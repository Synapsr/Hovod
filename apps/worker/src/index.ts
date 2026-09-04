import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { Redis } from 'ioredis';
import { nanoid } from 'nanoid';
import { assets, organizations, settings, aiJobs, createDb, jobs, renditions, ASSET_STATUS, JOB_STATUS, AI_JOB_STATUS, S3_PATHS, ID_LENGTH, WEBHOOK_EVENT, PROCESSING_STEP } from '@hovod/db';
import { env } from './env.js';
import { createAnalyticsWorker } from './analytics-worker.js';
import { ffprobe, getFfmpegCapabilities, type SourceProbe } from './ffmpeg.js';
import { detectHardware } from './hardware.js';
import { ensureFreeSpace, sweepStaleJobDirs, JOB_DIR_PREFIX } from './scratch.js';
import { s3, uploadDirectory, publicAcl } from './s3.js';
import { generateThumbnails } from './thumbnails.js';
import {
  filterLadder,
  transcodeRendition,
  createDownloadableMp4,
  extractPosterThumbnail,
  createMasterPlaylist,
  shouldToneMap,
  type RenditionOutput,
} from './transcoding.js';
import { isAiConfigured } from './ai/provider-factory.js';
import { processAi } from './ai/process.js';

const TRANSCODE_QUEUE = 'transcode';
const MAX_SOURCE_SIZE_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB
/** assets.error_message / jobs.error_message are VARCHAR(1024) */
const MAX_ERROR_MESSAGE_LENGTH = 1000;
/** Scratch space required relative to the source size (source + HLS rungs + MP4 remux) */
const SCRATCH_MULTIPLIER = 3;
/** MySQL INT upper bound for renditions.file_size_bytes */
const MAX_INT32 = 2_147_483_647;
const INTERRUPTED_MESSAGE = 'Processing was interrupted — click Retry';
/** BullMQ states in which a job is still going to run (or is running) */
const LIVE_JOB_STATES = new Set(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']);

/** Mirrors transcodeJobId() in apps/api/src/queue.ts (BullMQ forbids ':' in custom ids). */
const transcodeJobIdFor = (assetId: string) => `${TRANSCODE_QUEUE}-${assetId}`;

const jobDataSchema = z.object({
  assetId: z.string().min(1).max(36),
  jobId: z.string().min(1).max(36),
});

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Unknown worker error';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_LENGTH) || 'Unknown worker error';
}

/* ─── Hardware-adaptive configuration ─────────────────────── */

function computeWorkerConfig() {
  const hardware = detectHardware();
  const cpuCores = hardware.cpuCores;
  const totalMemGB = hardware.totalMemBytes / (1024 ** 3);
  // Reserve 1 GB for OS + Node.js overhead
  const availableMemGB = Math.max(1, totalMemGB - 1);

  // Each FFmpeg job uses ~1–1.5 GB (decoder + encoder buffers + Node overhead)
  const MEM_PER_JOB_GB = 1.5;
  // FFmpeg x264 sweet spot is ~4 threads; beyond that, diminishing returns
  const idealThreadsPerJob = Math.min(4, cpuCores);

  const memBasedConcurrency = Math.floor(availableMemGB / MEM_PER_JOB_GB);
  const cpuBasedConcurrency = Math.floor(cpuCores / idealThreadsPerJob);

  const concurrency = env.WORKER_CONCURRENCY
    ?? Math.max(1, Math.min(memBasedConcurrency, cpuBasedConcurrency));
  const ffmpegThreads = env.FFMPEG_THREADS
    ?? Math.max(1, Math.floor(cpuCores / concurrency));
  const dbPoolSize = env.DB_POOL_SIZE
    ?? Math.max(5, concurrency * 2 + 2);

  return { concurrency, ffmpegThreads, dbPoolSize, cpuCores, totalMemGB, hardware };
}

const workerConfig = computeWorkerConfig();
const workDir = path.resolve(env.WORK_DIR ?? os.tmpdir());

console.log('[worker] Hardware-adaptive config:');
console.log(`  CPU cores:      ${workerConfig.cpuCores} (${workerConfig.hardware.cpuSource})`);
console.log(`  Total RAM:      ${workerConfig.totalMemGB.toFixed(1)} GB (${workerConfig.hardware.memSource})`);
console.log(`  Concurrency:    ${workerConfig.concurrency} job(s)${env.WORKER_CONCURRENCY ? ' (override)' : ''}`);
console.log(`  FFmpeg threads: ${workerConfig.ffmpegThreads} per job${env.FFMPEG_THREADS !== undefined ? ' (override)' : ''}`);
console.log(`  DB pool size:   ${workerConfig.dbPoolSize}${env.DB_POOL_SIZE ? ' (override)' : ''}`);
console.log(`  Work dir:       ${workDir}${env.WORK_DIR ? '' : ' (os tmpdir)'}`);
console.log(`  S3 public ACL:  ${publicAcl ? 'public-read' : 'disabled'}`);

const { db } = createDb(env.DATABASE_URL, {
  connectionLimit: workerConfig.dbPoolSize,
  idleTimeout: 60_000,
});

/* ─── Metering & Webhooks helpers (cloud mode) ───────────── */

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
redis.on('error', (err) => console.warn(`[worker] Redis (metering) error: ${err.message}`));
redis.connect().catch(() => { /* non-fatal */ });

async function trackEncoding(orgId: string | null, durationSec: number): Promise<void> {
  if (!orgId) return;
  const minutes = Math.ceil(durationSec / 60);
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const key = `usage:${orgId}:encodingMinutes:${month}`;
  const newVal = await redis.incrby(key, minutes);
  if (newVal === minutes) await redis.expire(key, 90 * 86400).catch(() => {});
}

async function resolveWebhookUrls(orgId: string | null): Promise<string[]> {
  const urls: string[] = [];
  if (orgId) {
    try {
      const [org] = await db.select({ webhookUrl: organizations.webhookUrl }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      if (org?.webhookUrl) urls.push(org.webhookUrl);
    } catch { /* non-fatal: org table may not exist in self-hosted */ }
  }
  if (env.WEBHOOK_URL) urls.push(env.WEBHOOK_URL);
  return urls;
}

async function fireWebhook(event: string, data: Record<string, unknown>, orgId?: string | null): Promise<void> {
  const urls = await resolveWebhookUrls(orgId ?? null);
  if (urls.length === 0) return;

  const payload = JSON.stringify({ type: event, data, timestamp: new Date().toISOString() });

  await Promise.allSettled(urls.map(async (url) => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.warn(`[worker] Webhook ${event} to ${url} failed: ${(err as Error).message}`);
    }
  }));
}

/* ─── Terminal-state helpers ──────────────────────────────── */

const transcodeQueue = new Queue(TRANSCODE_QUEUE, { connection: { url: env.REDIS_URL } });
transcodeQueue.on('error', (err) => console.warn(`[worker] Queue error: ${err.message}`));

/** Writes the failed terminal state for an asset and its pending job row(s). Idempotent. */
async function markAssetFailed(assetId: string, jobId: string | null, message: string): Promise<void> {
  try {
    await db.update(assets)
      .set({ status: ASSET_STATUS.ERROR, errorMessage: message })
      .where(and(eq(assets.id, assetId), inArray(assets.status, [ASSET_STATUS.QUEUED, ASSET_STATUS.PROCESSING, ASSET_STATUS.ERROR])));
    const jobCondition = jobId
      ? and(eq(jobs.id, jobId), eq(jobs.assetId, assetId))
      : and(eq(jobs.assetId, assetId), inArray(jobs.status, [JOB_STATUS.QUEUED, JOB_STATUS.PROCESSING]));
    await db.update(jobs)
      .set({ status: JOB_STATUS.FAILED, currentStep: null, errorMessage: message })
      .where(jobCondition);
  } catch (dbError) {
    console.error(`[worker] Failed to write error state for asset ${assetId}: ${(dbError as Error).message}`);
  }
}

/** Marks the asset as queued again while BullMQ waits out the retry backoff. */
async function markRetryPending(assetId: string, jobId: string, message: string, attempt: number): Promise<void> {
  try {
    await db.update(assets).set({ status: ASSET_STATUS.QUEUED, errorMessage: message }).where(eq(assets.id, assetId));
    await db.update(jobs)
      .set({ status: JOB_STATUS.QUEUED, currentStep: null, errorMessage: message, attempts: attempt })
      .where(and(eq(jobs.id, jobId), eq(jobs.assetId, assetId)));
  } catch (dbError) {
    console.error(`[worker] Failed to write retry state for asset ${assetId}: ${(dbError as Error).message}`);
  }
}

async function isJobLive(bullJobId: string): Promise<boolean> {
  const bullJob = await transcodeQueue.getJob(bullJobId);
  if (!bullJob) return false;
  const state = await bullJob.getState();
  return LIVE_JOB_STATES.has(state);
}

/**
 * Startup reconciliation: assets left in `queued`/`processing` by a previous
 * worker whose BullMQ job no longer exists (or already finished) can never
 * make progress — flag them so the user can retry.
 */
async function reconcileInterruptedAssets(): Promise<void> {
  const stuck = await db.select({ id: assets.id, status: assets.status })
    .from(assets)
    .where(inArray(assets.status, [ASSET_STATUS.QUEUED, ASSET_STATUS.PROCESSING]));
  if (stuck.length === 0) return;

  let interrupted = 0;
  for (const asset of stuck) {
    const pendingJobs = await db.select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.assetId, asset.id), inArray(jobs.status, [JOB_STATUS.QUEUED, JOB_STATUS.PROCESSING])));

    // Deterministic id (new) + legacy ids (jobs.id) from before deterministic ids existed
    const candidates = [transcodeJobIdFor(asset.id), ...pendingJobs.map((j) => j.id)];
    let live = false;
    for (const candidate of candidates) {
      try {
        if (await isJobLive(candidate)) { live = true; break; }
      } catch (err) {
        console.warn(`[worker] Could not inspect queue job ${candidate}: ${(err as Error).message}`);
        live = true; // don't flag an asset on a Redis hiccup
        break;
      }
    }
    if (live) continue;

    await markAssetFailed(asset.id, null, INTERRUPTED_MESSAGE);
    interrupted += 1;
    console.warn(`[worker] Asset ${asset.id} was ${asset.status} with no live job — marked as error`);
  }
  console.log(`[worker] Reconciliation: ${stuck.length} in-flight asset(s) checked, ${interrupted} marked interrupted`);
}

/* ─── Source resolution ───────────────────────────────────── */

interface ResolvedSource {
  sourcePath: string;
  sizeBytes: number;
  /** Directory on the shared upload volume to remove once processing succeeds */
  cleanupSourceDir: string | null;
}

async function resolveSource(asset: typeof assets.$inferSelect, tmpDir: string): Promise<ResolvedSource> {
  /* Local shared volume → URL → S3 fallback */
  const localSourcePath = path.join(env.UPLOAD_DIR, asset.id, 'input.mp4');
  try {
    const localStat = await stat(localSourcePath);
    if (localStat.size === 0) throw new UnrecoverableError('Local source file is empty');
    if (localStat.size > MAX_SOURCE_SIZE_BYTES) throw new UnrecoverableError('Source file exceeds size limit');
    console.log(`[worker] Using local source (${(localStat.size / (1024 * 1024)).toFixed(1)} MB)`);
    return { sourcePath: localSourcePath, sizeBytes: localStat.size, cleanupSourceDir: path.dirname(localSourcePath) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const sourcePath = path.join(tmpDir, 'source.mp4');

  if (asset.sourceUrl) {
    const parsedUrl = new URL(asset.sourceUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new UnrecoverableError('Only http and https source URLs are supported');
    }

    console.log('[worker] Downloading from URL...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    try {
      const response = await fetch(asset.sourceUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`Failed to fetch source URL: ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error('Response body is empty');

      const contentLength = Number(response.headers.get('content-length') || '0');
      if (contentLength > MAX_SOURCE_SIZE_BYTES) {
        throw new UnrecoverableError(`Source file too large: ${(contentLength / (1024 * 1024 * 1024)).toFixed(1)} GB exceeds limit`);
      }
      if (contentLength > 0) await ensureFreeSpace(workDir, contentLength * (1 + SCRATCH_MULTIPLIER), 'downloading the source');

      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(sourcePath));
    } finally {
      clearTimeout(timeout);
    }
  } else if (asset.sourceKey) {
    console.log('[worker] Downloading from S3 (fallback)...');
    const sourceObject = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.sourceKey }));
    if (sourceObject.ContentLength && sourceObject.ContentLength > MAX_SOURCE_SIZE_BYTES) {
      throw new UnrecoverableError(`Source file too large: ${(sourceObject.ContentLength / (1024 * 1024 * 1024)).toFixed(1)} GB exceeds limit`);
    }
    if (sourceObject.ContentLength) await ensureFreeSpace(workDir, sourceObject.ContentLength * (1 + SCRATCH_MULTIPLIER), 'downloading the source');
    await pipeline(Readable.from(sourceObject.Body as AsyncIterable<Uint8Array>), createWriteStream(sourcePath));
  } else {
    throw new UnrecoverableError('No source available for asset');
  }

  const fileStat = await stat(sourcePath);
  if (fileStat.size > MAX_SOURCE_SIZE_BYTES) throw new UnrecoverableError('Downloaded source file exceeds size limit');
  if (fileStat.size === 0) throw new Error('Downloaded source file is empty');
  return { sourcePath, sizeBytes: fileStat.size, cleanupSourceDir: null };
}

function describeSource(probe: SourceProbe, toneMap: boolean): string {
  const parts = [
    `${probe.width}x${probe.height}`,
    `${probe.fps ? probe.fps.toFixed(2) : '?'} fps`,
    `${probe.duration.toFixed(1)}s`,
    `video=${probe.videoCodec ?? '?'}#${probe.videoStreamIndex}`,
    probe.hasAudio ? `audio=${probe.audioCodec ?? '?'}#${probe.audioStreamIndex}` : 'no audio',
  ];
  if (probe.rotation) parts.push(`rotation=${probe.rotation}`);
  if (probe.isHdr) parts.push(`HDR(${probe.colorTransfer}) tone-map=${toneMap ? 'on' : 'off (zscale/tonemap unavailable)'}`);
  return parts.join(', ');
}

/* ─── Post-ready phase (AI, metering, webhooks, archival) ─── */

interface PostReadyContext {
  asset: typeof assets.$inferSelect;
  assetId: string;
  sourcePath: string;
  tmpDir: string;
  probe: SourceProbe;
  cleanupSourceDir: string | null;
}

/**
 * Everything that happens after the asset is READY. Nothing in here may flip
 * the asset back to error — every step is individually guarded.
 */
async function runPostReadyPhase({ asset, assetId, sourcePath, tmpDir, probe, cleanupSourceDir }: PostReadyContext): Promise<void> {
  /* AI Processing — enrichment only */
  try {
    let meta: Record<string, unknown> = {};
    try {
      meta = asset.metadata ? (typeof asset.metadata === 'string' ? JSON.parse(asset.metadata as string) : asset.metadata) as Record<string, unknown> : {};
    } catch { /* malformed metadata — treat as empty */ }
    let aiOptions = meta.aiOptions as { transcription?: boolean; subtitles?: boolean; chapters?: boolean } | undefined;

    /* Read platform AI defaults from settings table if no per-asset override */
    if (!aiOptions) {
      try {
        const condition = asset.orgId ? eq(settings.orgId, asset.orgId) : isNull(settings.orgId);
        const [settingsRow] = await db.select({ aiAutoTranscribe: settings.aiAutoTranscribe, aiAutoChapter: settings.aiAutoChapter }).from(settings).where(condition).limit(1);
        if (settingsRow) {
          const transcribe = settingsRow.aiAutoTranscribe === 'true';
          const chapter = settingsRow.aiAutoChapter === 'true';
          if (!transcribe && !chapter) {
            console.log('[worker] AI processing disabled in platform settings, skipping');
          }
          aiOptions = { transcription: transcribe, subtitles: transcribe, chapters: chapter };
        }
      } catch { /* settings table may not exist yet — default to running AI */ }
    }

    if (isAiConfigured()) {
      const aiJobId = nanoid(ID_LENGTH.AI_JOB);
      await db.insert(aiJobs).values({ id: aiJobId, assetId, status: AI_JOB_STATUS.QUEUED });
      const ran = await processAi({
        assetId, aiJobId, sourcePath, outputDir: tmpDir, durationSec: probe.duration,
        audioStreamIndex: probe.audioStreamIndex, db, aiOptions,
      });
      if (ran) {
        const aiDir = path.join(tmpDir, 'ai');
        await uploadDirectory(aiDir, `${S3_PATHS.PLAYBACK_PREFIX}/${assetId}/ai`);
        console.log(`[worker] AI outputs uploaded for asset ${assetId}`);
      }
    }
  } catch (aiError) {
    console.error('[worker] AI processing failed (non-fatal):', (aiError as Error).message);
  }

  /* Track encoding usage & fire webhook (fire-and-forget) */
  trackEncoding(asset.orgId, probe.duration).catch(() => {});
  fireWebhook(WEBHOOK_EVENT.ASSET_READY, {
    assetId,
    playbackId: asset.playbackId,
    duration: Math.round(probe.duration),
  }, asset.orgId).catch(() => {});

  /* Upload original source to S3 for download feature */
  if (asset.sourceKey && cleanupSourceDir) {
    try {
      console.log('[worker] Uploading source to S3 for archival...');
      await s3.send(new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: asset.sourceKey,
        Body: createReadStream(sourcePath),
        ContentType: 'video/mp4',
      }));
    } catch (err) {
      console.warn('[worker] Source upload to S3 failed (non-fatal):', (err as Error).message);
    }
  }

  /* Clean up local source from shared volume */
  if (cleanupSourceDir) {
    try { await rm(cleanupSourceDir, { recursive: true, force: true }); } catch {}
  }
}

/* ─── Transcode processor ─────────────────────────────────── */

async function processTranscodeJob(job: Job): Promise<void> {
  const { assetId, jobId } = jobDataSchema.parse(job.data);
  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;

  console.log(`[worker] Starting job ${jobId} for asset ${assetId} (attempt ${attempt}/${maxAttempts})`);

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new UnrecoverableError(`Asset not found: ${assetId}`);

  // Skip if already processed (idempotency for re-delivered jobs)
  if (asset.status === ASSET_STATUS.READY) {
    console.log(`[worker] Asset ${assetId} already ready, skipping`);
    await db.update(jobs).set({ status: JOB_STATUS.COMPLETED, currentStep: null }).where(eq(jobs.id, jobId)).catch(() => {});
    return;
  }

  const setStep = (step: string) => db.update(jobs).set({ currentStep: step }).where(eq(jobs.id, jobId)).catch(() => {});

  await db.update(jobs)
    .set({ status: JOB_STATUS.PROCESSING, currentStep: PROCESSING_STEP.DOWNLOADING, attempts: attempt, errorMessage: null })
    .where(eq(jobs.id, jobId));
  await db.update(assets).set({ status: ASSET_STATUS.PROCESSING, errorMessage: null }).where(eq(assets.id, assetId));
  // Idempotency: a re-delivered or retried job must not accumulate duplicate rows
  await db.delete(renditions).where(eq(renditions.assetId, assetId));

  const tmpDir = path.join(workDir, `${JOB_DIR_PREFIX}${assetId}-${randomUUID().slice(0, 8)}`);
  const outputDir = path.join(tmpDir, 'hls');
  await mkdir(outputDir, { recursive: true });

  let cleanupSourceDir: string | null = null;

  try {
    const source = await resolveSource(asset, tmpDir);
    const sourcePath = source.sourcePath;
    cleanupSourceDir = source.cleanupSourceDir;

    await ensureFreeSpace(workDir, source.sizeBytes * SCRATCH_MULTIPLIER, 'transcoding');

    /* Probe source video */
    await setStep(PROCESSING_STEP.PROBING);
    const probe = await ffprobe(sourcePath);
    if (probe.videoStreamIndex === null || probe.width === 0 || probe.height === 0) {
      throw new UnrecoverableError('Source has no video stream');
    }
    const capabilities = await getFfmpegCapabilities();
    const toneMap = shouldToneMap(probe, capabilities);
    console.log(`[worker] Source: ${describeSource(probe, toneMap)}`);
    if (probe.duration <= 0) console.warn('[worker] Source duration unknown — timeouts fall back to defaults');

    /* Transcode each rendition (skip resolutions above source) */
    const ladder = filterLadder(probe.width, probe.height);
    console.log(`[worker] Ladder: ${ladder.map(p => p.quality).join(', ')}`);

    const outputs: RenditionOutput[] = [];
    for (const profile of ladder) {
      console.log(`[worker] Transcoding ${profile.quality}...`);
      await setStep(`transcoding_${profile.quality}`);
      const output = await transcodeRendition(sourcePath, outputDir, profile, {
        source: probe,
        threads: workerConfig.ffmpegThreads,
        capabilities,
      });
      outputs.push(output);
      console.log(`[worker] ${profile.quality}: ${output.width}x${output.height}, avg ${(output.averageBandwidth / 1000).toFixed(0)} kbps${output.hasAudio ? '' : ', no audio'}`);

      await db.insert(renditions).values({
        id: randomUUID(),
        assetId,
        quality: profile.quality,
        width: output.width,
        height: output.height,
        bitrateKbps: output.videoBitrateKbps,
        fileSizeBytes: Math.min(output.segmentBytes, MAX_INT32),
        codec: 'h264',
        playlistPath: `${S3_PATHS.PLAYBACK_PREFIX}/${assetId}/${output.playlistPath}`,
      });
    }

    /* One downloadable MP4 from the highest rung (fast remux, no re-encoding) */
    const highest = ladder[ladder.length - 1];
    try {
      await createDownloadableMp4(outputDir, highest, probe.duration);
    } catch (err) {
      console.warn(`[worker] Downloadable MP4 failed (non-fatal, download disabled): ${(err as Error).message}`);
      await rm(path.join(outputDir, 'download.mp4'), { force: true }).catch(() => {});
    }

    /* Thumbnails — a sprite failure only disables the scrubber preview */
    await setStep(PROCESSING_STEP.THUMBNAILS);
    console.log('[worker] Generating thumbnails...');
    try {
      const layout = await generateThumbnails(sourcePath, outputDir, probe, { capabilities });
      console.log(`[worker] Sprite: ${layout.count} tiles every ${layout.interval}s (${layout.cols}x${layout.rows})`);
    } catch (err) {
      console.warn(`[worker] Thumbnail sprite failed (non-fatal, scrubber preview disabled): ${(err as Error).message}`);
      await rm(path.join(outputDir, 'thumbnails'), { recursive: true, force: true }).catch(() => {});
    }
    try {
      await extractPosterThumbnail(sourcePath, outputDir, { source: probe, capabilities });
    } catch (err) {
      console.warn(`[worker] Poster extraction failed, retrying at t=0: ${(err as Error).message}`);
      try {
        await extractPosterThumbnail(sourcePath, outputDir, { source: { ...probe, duration: 0 }, capabilities });
      } catch (retryErr) {
        console.warn(`[worker] Poster extraction failed (non-fatal): ${(retryErr as Error).message}`);
      }
    }

    /* Create master playlist and upload */
    await createMasterPlaylist(outputDir, outputs);

    await setStep(PROCESSING_STEP.UPLOADING);
    console.log('[worker] Uploading to S3...');
    await uploadDirectory(outputDir, `${S3_PATHS.PLAYBACK_PREFIX}/${assetId}`);

    /* Mark as ready — the job is complete from here on */
    await db.update(assets).set({ status: ASSET_STATUS.READY, durationSec: Math.round(probe.duration), errorMessage: null }).where(eq(assets.id, assetId));
    await db.update(jobs).set({ status: JOB_STATUS.COMPLETED, currentStep: null, errorMessage: null }).where(eq(jobs.id, jobId));
    console.log(`[worker] Asset ${assetId} is ready`);

    await runPostReadyPhase({ asset, assetId, sourcePath, tmpDir, probe, cleanupSourceDir });

    console.log(`[worker] Job ${jobId} completed successfully`);
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    const willRetry = !(error instanceof UnrecoverableError) && attempt < maxAttempts;
    console.error(`[worker] Job ${jobId} failed (attempt ${attempt}/${maxAttempts}${willRetry ? ', will retry' : ''}):`, message);

    if (willRetry) {
      await markRetryPending(assetId, jobId, message, attempt);
    } else {
      await markAssetFailed(assetId, jobId, message);
      fireWebhook(WEBHOOK_EVENT.ASSET_ERROR, { assetId, errorMessage: message }, asset.orgId).catch(() => {});
    }

    throw error;
  } finally {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error(`[worker] Failed to clean up temp directory: ${tmpDir}`);
    }
  }
}

const worker = new Worker(TRANSCODE_QUEUE, processTranscodeJob, {
  connection: { url: env.REDIS_URL },
  concurrency: workerConfig.concurrency,
  // FFmpeg jobs are long: renew the lock less often and tolerate slow event loops
  lockDuration: 120_000,
  stalledInterval: 60_000,
  autorun: false,
});

worker.on('ready', () => {
  console.log('[worker] Worker ready, waiting for jobs...');
});

worker.on('failed', (job, err) => {
  if (!job) {
    console.error(`[worker] A job failed without job data: ${err.message}`);
    return;
  }
  const parsed = jobDataSchema.safeParse(job.data);
  // Only write terminal state when BullMQ will not retry the job
  job.getState().then(async (state) => {
    if (state !== 'failed') {
      console.warn(`[worker] Job ${job.id} failed, retry scheduled (${state}): ${err.message}`);
      return;
    }
    console.error(`[worker] Job ${job.id} failed permanently: ${err.message}`);
    if (parsed.success) await markAssetFailed(parsed.data.assetId, parsed.data.jobId, sanitizeErrorMessage(err));
  }).catch((stateErr) => {
    console.error(`[worker] Could not resolve state of failed job ${job.id}: ${(stateErr as Error).message}`);
  });
});

// BullMQ emits Redis connection errors here — without a listener they crash the process
worker.on('error', (err) => {
  console.error(`[worker] Worker error: ${err.message}`);
});

worker.on('stalled', (jobId) => {
  console.warn(`[worker] Job ${jobId} stalled (lock expired) — BullMQ will retry it or fail it`);
  // A job that stalled too often is moved straight to failed without a 'failed' event
  Job.fromId(transcodeQueue, jobId).then(async (job) => {
    if (!job) return;
    const state = await job.getState();
    if (state !== 'failed') return;
    const parsed = jobDataSchema.safeParse(job.data);
    if (!parsed.success) return;
    console.error(`[worker] Job ${jobId} exceeded the stall limit — marking asset ${parsed.data.assetId} as error`);
    await markAssetFailed(parsed.data.assetId, parsed.data.jobId, INTERRUPTED_MESSAGE);
  }).catch((err) => {
    console.error(`[worker] Could not inspect stalled job ${jobId}: ${(err as Error).message}`);
  });
});

/* ─── Analytics Worker ────────────────────────────────────── */

const analyticsWorker = createAnalyticsWorker(env.REDIS_URL);

/* ─── Lifecycle ───────────────────────────────────────────── */

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] Received ${signal}, shutting down...`);
  const forceExit = setTimeout(() => {
    console.error('[worker] Shutdown timed out, exiting');
    process.exit(exitCode || 1);
  }, 30_000);
  forceExit.unref();
  try {
    await Promise.allSettled([worker.close(), analyticsWorker.close(), transcodeQueue.close(), redis.quit()]);
  } finally {
    process.exit(exitCode);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[worker] Unhandled promise rejection:', reason instanceof Error ? reason.stack ?? reason.message : reason);
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  console.error('[worker] Uncaught exception:', err.stack ?? err.message);
  shutdown('uncaughtException', 1);
});

async function boot() {
  const capabilities = await getFfmpegCapabilities();
  console.log(`[worker] FFmpeg ${capabilities.version}: zscale=${capabilities.zscale ? 'yes' : 'no'}, tonemap=${capabilities.tonemap ? 'yes' : 'no'} → HDR tone-mapping ${capabilities.hdrToneMapping ? 'enabled' : 'disabled (fallback to plain yuv420p)'}`);

  try {
    const removed = await sweepStaleJobDirs(workDir);
    if (removed > 0) console.log(`[worker] Swept ${removed} stale job director${removed === 1 ? 'y' : 'ies'} from ${workDir}`);
  } catch (err) {
    console.warn(`[worker] Stale directory sweep failed: ${(err as Error).message}`);
  }

  try {
    await reconcileInterruptedAssets();
  } catch (err) {
    console.error(`[worker] Startup reconciliation failed: ${(err as Error).message}`);
  }

  worker.run().catch((err) => {
    console.error(`[worker] Worker loop crashed: ${(err as Error).message}`);
    shutdown('worker-crash', 1);
  });
}

boot().catch((err) => {
  console.error(`[worker] Boot failed: ${(err as Error).message}`);
  shutdown('boot-failure', 1);
});
