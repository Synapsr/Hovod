import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, like, lt, or, sql } from 'drizzle-orm';
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { assets, jobs, renditions, aiJobs, ASSET_STATUS, SOURCE_TYPE, JOB_STATUS, JOB_TYPE, S3_PATHS, ID_LENGTH, WEBHOOK_EVENT, METADATA_LIMITS, assertPublicHttpUrl, BlockedUrlError } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { s3Client, s3PublicClient } from '../s3.js';
import { transcodeQueue, transcodeJobId } from '../queue.js';
import { findAssetOrFail, getThumbnailUrl, getSourceKey, encodeCursor, decodeCursor, escapeLikePattern } from '../services/asset.js';
import { dispatchWebhook } from '../services/webhooks.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';
import { generateVttFromSegments } from '../services/vtt.js';

const customMetadataSchema = z.record(
  z.string().min(1).max(METADATA_LIMITS.MAX_KEY_LENGTH),
  z.string().max(METADATA_LIMITS.MAX_VALUE_LENGTH),
).refine(
  (obj) => Object.keys(obj).length <= METADATA_LIMITS.MAX_KEYS,
  `Maximum ${METADATA_LIMITS.MAX_KEYS} metadata entries allowed`,
);

const createAssetBody = z.object({
  title: z.string().min(1).max(255),
  metadata: customMetadataSchema.optional(),
});
const importAssetBody = z.object({
  sourceUrl: z.string().url().max(2048).refine(
    (url) => url.startsWith('https://') || url.startsWith('http://'),
    'Only http and https URLs are allowed',
  ),
});

/* ─── List query ─────────────────────────────────────────── */

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

/** Columns returned by the list endpoint — the heavy JSON/TEXT columns are opt-in. */
const LIST_COLUMNS = {
  id: assets.id,
  orgId: assets.orgId,
  status: assets.status,
  sourceType: assets.sourceType,
  sourceKey: assets.sourceKey,
  sourceUrl: assets.sourceUrl,
  title: assets.title,
  playbackId: assets.playbackId,
  customThumbnailKey: assets.customThumbnailKey,
  durationSec: assets.durationSec,
  errorMessage: assets.errorMessage,
  createdAt: assets.createdAt,
  updatedAt: assets.updatedAt,
};

const LIST_COLUMNS_FULL = {
  ...LIST_COLUMNS,
  description: assets.description,
  metadata: assets.metadata,
  customMetadata: assets.customMetadata,
  publicSettings: assets.publicSettings,
};

const LISTABLE_STATUSES = [
  ASSET_STATUS.CREATED,
  ASSET_STATUS.UPLOADED,
  ASSET_STATUS.QUEUED,
  ASSET_STATUS.PROCESSING,
  ASSET_STATUS.READY,
  ASSET_STATUS.ERROR,
] as const;

const listAssetsQuery = z.object({
  q: z.string().trim().max(255).optional(),
  status: z.enum(LISTABLE_STATUSES).optional(),
  sourceType: z.enum([SOURCE_TYPE.UPLOAD, SOURCE_TYPE.URL]).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
  cursor: z.string().max(512).optional(),
  fields: z.enum(['default', 'full']).optional(),
});

/** Transcripts and chapter lists are far bigger than the 1 MB global JSON limit. */
const TEXT_TRACK_BODY_LIMIT = 10 * 1024 * 1024;

export async function assetRoutes(app: FastifyInstance) {
  /* Create asset */
  app.post<{ Body: z.infer<typeof createAssetBody> }>('/v1/assets', async (request, reply) => {
    const body = createAssetBody.parse(request.body);
    const id = nanoid(ID_LENGTH.ASSET);
    const playbackId = nanoid(ID_LENGTH.PLAYBACK);

    await db.insert(assets).values({
      id,
      orgId: request.orgId!,
      title: body.title,
      playbackId,
      status: ASSET_STATUS.CREATED,
      sourceType: SOURCE_TYPE.UPLOAD,
      ...(body.metadata ? { customMetadata: body.metadata } : {}),
    });

    reply.code(201);
    return { data: { id, playbackId, status: ASSET_STATUS.CREATED } };
  });

  /**
   * List assets — keyset pagination on `(created_at DESC, id DESC)`.
   *
   * A request without any pagination parameter still gets a page (capped at
   * LIST_MAX_LIMIT) plus the `pagination` block, so older clients that only read
   * `data` keep working while no longer being able to pull an unbounded library
   * in a single query.
   */
  app.get<{ Querystring: z.infer<typeof listAssetsQuery> }>('/v1/assets', async (request) => {
    const query = listAssetsQuery.parse(request.query);
    const limit = query.limit ?? LIST_DEFAULT_LIMIT;

    const conditions = [eq(assets.orgId, request.orgId!)];
    if (query.status) conditions.push(eq(assets.status, query.status));
    if (query.sourceType) conditions.push(eq(assets.sourceType, query.sourceType));
    if (query.q) conditions.push(like(assets.title, `%${escapeLikePattern(query.q)}%`));

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!cursor) throw new AppError(400, 'Invalid cursor');
      const cursorDate = new Date(cursor.createdAt);
      conditions.push(
        or(
          lt(assets.createdAt, cursorDate),
          and(eq(assets.createdAt, cursorDate), lt(assets.id, cursor.id)),
        )!,
      );
    }

    const columns = query.fields === 'full' ? LIST_COLUMNS_FULL : LIST_COLUMNS;
    const rows = await db
      .select(columns)
      .from(assets)
      .where(and(...conditions))
      .orderBy(desc(assets.createdAt), desc(assets.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    // A COUNT over the whole org is only cheap while no filter narrows it down.
    let total: number | undefined;
    if (!query.q && !query.status && !query.sourceType) {
      const [row] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(assets)
        .where(eq(assets.orgId, request.orgId!));
      total = Number(row?.count ?? 0);
    }

    return {
      data: page.map((a) => ({
        ...a,
        thumbnailUrl: getThumbnailUrl(a.id, a.status, a.customThumbnailKey),
        hasCustomThumbnail: !!a.customThumbnailKey,
      })),
      pagination: {
        limit,
        hasMore,
        nextCursor: hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
        ...(total === undefined ? {} : { total }),
      },
    };
  });

  /* Get asset by ID */
  app.get<{ Params: { id: string } }>('/v1/assets/:id', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const assetRenditions = await db.select().from(renditions).where(eq(renditions.assetId, asset.id));
    const [aiJob] = await db.select().from(aiJobs).where(eq(aiJobs.assetId, asset.id)).limit(1);
    const [activeJob] = await db.select({ currentStep: jobs.currentStep }).from(jobs).where(and(eq(jobs.assetId, asset.id), eq(jobs.status, JOB_STATUS.PROCESSING))).limit(1);
    return {
      data: {
        ...asset,
        thumbnailUrl: getThumbnailUrl(asset.id, asset.status, asset.customThumbnailKey),
        hasCustomThumbnail: !!asset.customThumbnailKey,
        currentStep: activeJob?.currentStep ?? null,
        renditions: assetRenditions,
        aiJob: aiJob ? {
          status: aiJob.status,
          transcriptionStatus: aiJob.transcriptionStatus,
          subtitlesStatus: aiJob.subtitlesStatus,
          chaptersStatus: aiJob.chaptersStatus,
          language: aiJob.language,
        } : null,
      },
    };
  });

  /* Get upload URL */
  app.post<{ Params: { id: string } }>('/v1/assets/:id/upload-url', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const sourceKey = getSourceKey(asset.id);

    const command = new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: sourceKey,
      ContentType: 'video/mp4',
    });

    const uploadUrl = await getSignedUrl(s3PublicClient, command, { expiresIn: 3600 });
    await db.update(assets).set({ sourceKey }).where(eq(assets.id, asset.id));

    return { data: { uploadUrl, sourceKey, method: 'PUT' } };
  });

  /* Confirm S3 presigned upload completed — verifies file exists before marking uploaded */
  app.post<{ Params: { id: string } }>('/v1/assets/:id/upload-complete', async (request, reply) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    if (!asset.sourceKey) {
      return reply.code(400).send({ error: 'No upload URL was generated for this asset' });
    }

    // Verify the file actually exists on S3
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.sourceKey }));
    } catch {
      return reply.code(400).send({ error: 'File not found on storage — upload may have failed' });
    }

    await db.update(assets)
      .set({ status: ASSET_STATUS.UPLOADED })
      .where(and(eq(assets.id, asset.id), eq(assets.status, ASSET_STATUS.CREATED)));

    return { data: { id: asset.id, status: ASSET_STATUS.UPLOADED } };
  });

  /* ─── S3 multipart upload (browser uploads each part with a presigned PUT) ─── */

  /** Part size the browser must use for every part but the last (S3 requires >= 5 MiB). */
  const MULTIPART_PART_SIZE = 16 * 1024 * 1024;
  const MAX_PART_NUMBER = 10_000;

  const partUrlBody = z.object({
    uploadId: z.string().min(1).max(1024),
    partNumber: z.number().int().min(1).max(MAX_PART_NUMBER),
  });
  const completeBody = z.object({
    uploadId: z.string().min(1).max(1024),
    parts: z.array(z.object({
      PartNumber: z.number().int().min(1).max(MAX_PART_NUMBER),
      ETag: z.string().min(1).max(256),
    })).min(1).max(MAX_PART_NUMBER),
  });
  const abortBody = z.object({ uploadId: z.string().min(1).max(1024) });

  /* Start a multipart upload */
  app.post<{ Params: { id: string } }>('/v1/assets/:id/multipart/create', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const sourceKey = getSourceKey(asset.id);

    const created = await s3Client.send(new CreateMultipartUploadCommand({
      Bucket: env.S3_BUCKET,
      Key: sourceKey,
      ContentType: 'video/mp4',
    }));
    if (!created.UploadId) throw new AppError(502, 'Storage did not return an upload id');

    await db.update(assets).set({ sourceKey }).where(eq(assets.id, asset.id));

    return { data: { uploadId: created.UploadId, partSize: MULTIPART_PART_SIZE, key: sourceKey } };
  });

  /* Presign a single part */
  app.post<{ Params: { id: string }; Body: z.infer<typeof partUrlBody> }>('/v1/assets/:id/multipart/part-url', async (request) => {
    const body = partUrlBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const sourceKey = asset.sourceKey ?? getSourceKey(asset.id);

    const url = await getSignedUrl(s3PublicClient, new UploadPartCommand({
      Bucket: env.S3_BUCKET,
      Key: sourceKey,
      UploadId: body.uploadId,
      PartNumber: body.partNumber,
    }), { expiresIn: 3600 });

    return { data: { url } };
  });

  /* Finish the upload and mark the asset as uploaded */
  app.post<{ Params: { id: string }; Body: z.infer<typeof completeBody> }>('/v1/assets/:id/multipart/complete', async (request, reply) => {
    const body = completeBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const sourceKey = asset.sourceKey ?? getSourceKey(asset.id);

    const parts = [...body.parts].sort((a, b) => a.PartNumber - b.PartNumber);

    try {
      await s3Client.send(new CompleteMultipartUploadCommand({
        Bucket: env.S3_BUCKET,
        Key: sourceKey,
        UploadId: body.uploadId,
        MultipartUpload: { Parts: parts },
      }));
    } catch (err) {
      request.log.warn({ err, assetId: asset.id }, 'multipart complete failed');
      return reply.code(400).send({ error: 'Could not finish the upload — please retry' });
    }

    // Verify the assembled object is really there before promoting the asset
    try {
      await s3Client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: sourceKey }));
    } catch {
      return reply.code(400).send({ error: 'File not found on storage — upload may have failed' });
    }

    await db.update(assets)
      .set({ status: ASSET_STATUS.UPLOADED })
      .where(and(eq(assets.id, asset.id), eq(assets.status, ASSET_STATUS.CREATED)));

    return { data: { id: asset.id, status: ASSET_STATUS.UPLOADED } };
  });

  /* Abandon an upload so S3 stops holding the uploaded parts */
  app.post<{ Params: { id: string }; Body: z.infer<typeof abortBody> }>('/v1/assets/:id/multipart/abort', async (request) => {
    const body = abortBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const sourceKey = asset.sourceKey ?? getSourceKey(asset.id);

    await s3Client.send(new AbortMultipartUploadCommand({
      Bucket: env.S3_BUCKET,
      Key: sourceKey,
      UploadId: body.uploadId,
    })).catch(() => { /* already gone — nothing to clean up */ });

    return { data: { id: asset.id, aborted: true } };
  });

  /* Direct upload (saves to shared volume — Worker reads directly, no S3 round-trip) */
  app.register(async function uploadProxy(scope) {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', function (_req, payload, done) {
      done(null, payload);
    });

    scope.put<{ Params: { id: string } }>('/v1/assets/:id/upload', {
      bodyLimit: 5_368_709_120, // 5 GB
    }, async (request, reply) => {
      const asset = await findAssetOrFail(request.params.id, request.orgId);
      if (asset.status !== ASSET_STATUS.CREATED) {
        return reply.code(409).send({ error: 'Asset already has a source' });
      }

      const uploadDir = path.join(env.UPLOAD_DIR, asset.id);
      await mkdir(uploadDir, { recursive: true });
      const filePath = path.join(uploadDir, 'input.mp4');

      try {
        await pipeline(request.body as Readable, createWriteStream(filePath));
      } catch (err) {
        // A client that disconnects mid-upload (or blows the body limit) used to
        // leave a truncated input.mp4 behind that the worker would happily try to
        // transcode. Drop it and leave the asset in `created` so it can be retried.
        await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
        const hint = 'Upload was interrupted before the file was complete — please retry';
        await db.update(assets)
          .set({ status: ASSET_STATUS.CREATED, sourceKey: null, errorMessage: hint })
          .where(and(eq(assets.id, asset.id), eq(assets.status, ASSET_STATUS.CREATED)))
          .catch(() => {});
        request.log.warn({ err, assetId: asset.id }, 'direct upload aborted');
        if (typeof (err as { statusCode?: number }).statusCode === 'number') throw err;
        throw new AppError(400, hint);
      }

      const sourceKey = getSourceKey(asset.id);
      const updateResult = await db.update(assets)
        .set({ sourceKey, status: ASSET_STATUS.UPLOADED })
        .where(and(eq(assets.id, asset.id), eq(assets.status, ASSET_STATUS.CREATED)));

      if (updateResult[0].affectedRows === 0) {
        return reply.code(409).send({ error: 'Asset was modified concurrently' });
      }

      return { data: { id: asset.id, sourceKey, status: ASSET_STATUS.UPLOADED } };
    });
  });

  /* Import from URL */
  app.post<{ Params: { id: string }; Body: z.infer<typeof importAssetBody> }>('/v1/assets/:id/import', async (request) => {
    const { id } = request.params;
    const body = importAssetBody.parse(request.body);

    const asset = await findAssetOrFail(id, request.orgId);

    // The worker will fetch this URL from inside the network — refuse anything
    // that resolves to a private/loopback/link-local address (SSRF).
    try {
      await assertPublicHttpUrl(body.sourceUrl);
    } catch (err) {
      if (err instanceof BlockedUrlError) throw new AppError(400, err.message);
      throw err;
    }

    await db
      .update(assets)
      .set({ sourceType: SOURCE_TYPE.URL, sourceUrl: body.sourceUrl, status: ASSET_STATUS.UPLOADED, errorMessage: null })
      .where(and(eq(assets.id, asset.id), eq(assets.orgId, request.orgId!)));

    return { data: { id, sourceUrl: body.sourceUrl, status: ASSET_STATUS.UPLOADED } };
  });

  /* Start processing */
  const processBody = z.object({
    aiOptions: z.object({
      transcription: z.boolean().default(true),
      subtitles: z.boolean().default(true),
      chapters: z.boolean().default(true),
    }).optional(),
  }).optional();

  const PROCESSABLE_STATUSES: string[] = [ASSET_STATUS.UPLOADED, ASSET_STATUS.ERROR];
  const LIVE_QUEUE_STATES = new Set(['active', 'waiting', 'delayed', 'prioritized', 'waiting-children']);

  app.post<{ Params: { id: string } }>('/v1/assets/:id/process', async (request) => {
    const body = processBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);

    if (!PROCESSABLE_STATUSES.includes(asset.status)) {
      throw new AppError(409, `Asset cannot be processed while its status is "${asset.status}"`);
    }

    // One in-flight transcode per asset: refuse when a job row is still pending…
    const [pendingJob] = await db.select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.assetId, asset.id), inArray(jobs.status, [JOB_STATUS.QUEUED, JOB_STATUS.PROCESSING])))
      .limit(1);
    if (pendingJob) {
      throw new AppError(409, `Asset already has a ${pendingJob.status} job (${pendingJob.id})`);
    }

    // …or when the deterministic BullMQ job is still alive (e.g. waiting out a retry backoff)
    const bullJobId = transcodeJobId(asset.id);
    const existingJob = await transcodeQueue.getJob(bullJobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (LIVE_QUEUE_STATES.has(state)) {
        throw new AppError(409, `Asset is already being processed (job ${state})`);
      }
      // Finished job with the same id would make the new add a no-op — clear it first
      await existingJob.remove().catch(() => {});
    }

    // Store AI options in asset metadata
    if (body?.aiOptions) {
      const existing = asset.metadata ? (typeof asset.metadata === 'string' ? JSON.parse(asset.metadata) : asset.metadata) as Record<string, unknown> : {};
      // Drizzle's json() column serialises on write — stringifying here double-encoded the column.
      await db.update(assets).set({ metadata: { ...existing, aiOptions: body.aiOptions } }).where(eq(assets.id, asset.id));
    }

    const jobId = nanoid(ID_LENGTH.JOB);

    await db.insert(jobs).values({
      id: jobId,
      assetId: asset.id,
      type: JOB_TYPE.TRANSCODE,
      status: JOB_STATUS.QUEUED,
      attempts: 0,
    });
    await db.update(assets).set({ status: ASSET_STATUS.QUEUED, errorMessage: null }).where(eq(assets.id, asset.id));
    try {
      await transcodeQueue.add('transcode', { assetId: asset.id, jobId }, { jobId: bullJobId });
    } catch (err) {
      // Never leave the asset "queued" without a queue job behind it
      await db.delete(jobs).where(eq(jobs.id, jobId)).catch(() => {});
      await db.update(assets).set({ status: asset.status, errorMessage: asset.errorMessage }).where(eq(assets.id, asset.id)).catch(() => {});
      throw new AppError(503, `Could not enqueue processing job: ${(err as Error).message}`);
    }

    return { data: { assetId: asset.id, jobId, status: JOB_STATUS.QUEUED } };
  });

  /* Delete asset (hard delete: DB + S3) */
  app.delete<{ Params: { id: string } }>('/v1/assets/:id', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);

    // Delete all S3 objects under sources/{id}/ and playback/{id}/
    const prefixes = [
      `${S3_PATHS.SOURCES_PREFIX}/${asset.id}/`,
      `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}/`,
    ];

    for (const prefix of prefixes) {
      let continuationToken: string | undefined;
      do {
        const list = await s3Client.send(new ListObjectsV2Command({
          Bucket: env.S3_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));

        if (list.Contents && list.Contents.length > 0) {
          await s3Client.send(new DeleteObjectsCommand({
            Bucket: env.S3_BUCKET,
            Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key })) },
          }));
        }

        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
      } while (continuationToken);
    }

    // Hard delete from DB (FK CASCADE removes renditions + jobs)
    await db.delete(assets).where(eq(assets.id, asset.id));

    // Dispatch webhook (fire-and-forget)
    dispatchWebhook(WEBHOOK_EVENT.ASSET_DELETED, { assetId: asset.id, title: asset.title }, asset.orgId).catch(() => {});

    return { data: { id: asset.id, deleted: true } };
  });

  /* ─── Inline editing endpoints ─────────────────────────── */

  const publicSettingsSchema = z.object({
    allowDownload: z.boolean(),
    showTranscript: z.boolean(),
    showChapters: z.boolean(),
    showComments: z.boolean(),
  });

  const updateAssetBody = z.object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(10000).optional(),
    publicSettings: publicSettingsSchema.optional(),
    metadata: customMetadataSchema.optional(),
  });

  /* Update asset (title + description + public settings + metadata) */
  app.patch<{ Params: { id: string } }>('/v1/assets/:id', async (request) => {
    const body = updateAssetBody.parse(request.body);
    if (!body.title && body.description === undefined && !body.publicSettings && body.metadata === undefined) {
      throw new AppError(400, 'Nothing to update');
    }
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const updates: Record<string, unknown> = {};
    if (body.title) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description || null;
    if (body.publicSettings) updates.publicSettings = body.publicSettings;
    if (body.metadata !== undefined) updates.customMetadata = body.metadata;
    await db.update(assets).set(updates).where(eq(assets.id, asset.id));
    return { data: { id: asset.id, ...updates } };
  });

  /* Upload custom thumbnail */
  app.register(async function thumbnailUpload(scope) {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', function (_req, payload, done) {
      done(null, payload);
    });

    scope.put<{ Params: { id: string }; Body: AsyncIterable<Buffer> }>('/v1/assets/:id/thumbnail', {
      bodyLimit: 10_485_760, // 10 MB
    }, async (request) => {
      const asset = await findAssetOrFail(request.params.id, request.orgId);
      const contentType = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const extMap: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
      const ext = extMap[contentType];
      if (!ext) throw new AppError(400, 'Unsupported image type — use JPG, PNG, or WebP');
      // Unique key per upload so the public URL changes on every replacement (cache-bust by design)
      const thumbnailKey = `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}/custom-thumbnail-${nanoid(8)}.${ext}`;

      const chunks: Buffer[] = [];
      for await (const chunk of request.body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) throw new AppError(400, 'Empty image file');

      await s3Client.send(new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: thumbnailKey,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read',
      }));

      // Remove the previous custom thumbnail to avoid orphaned objects
      if (asset.customThumbnailKey && asset.customThumbnailKey !== thumbnailKey) {
        await s3Client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.customThumbnailKey })).catch(() => {});
      }

      await db.update(assets).set({ customThumbnailKey: thumbnailKey }).where(eq(assets.id, asset.id));

      return {
        data: { thumbnailUrl: `${env.S3_PUBLIC_BASE_URL}/${thumbnailKey}`, hasCustomThumbnail: true },
      };
    });
  });

  /* Reset thumbnail to the auto-generated frame (removes the custom override) */
  app.delete<{ Params: { id: string } }>('/v1/assets/:id/thumbnail', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    if (asset.customThumbnailKey) {
      await s3Client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.customThumbnailKey })).catch(() => {});
      await db.update(assets).set({ customThumbnailKey: null }).where(eq(assets.id, asset.id));
    }
    return {
      data: {
        thumbnailUrl: getThumbnailUrl(asset.id, asset.status, null),
        hasCustomThumbnail: false,
      },
    };
  });

  /* Download original source file or rendition */
  app.get<{ Params: { id: string }; Querystring: { quality?: string } }>('/v1/assets/:id/download', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const { quality } = request.query;

    if (quality) {
      if (!/^[a-z0-9]+$/i.test(quality)) throw new AppError(400, 'Invalid quality');
      // Per-rendition MP4 (legacy assets) → single download.mp4 from the highest rung (current worker)
      const playbackPrefix = `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}`;
      const candidates = [
        { key: `${playbackPrefix}/${quality}/download.mp4`, suffix: `-${quality}` },
        { key: `${playbackPrefix}/download.mp4`, suffix: '' },
      ];
      for (const candidate of candidates) {
        const headResult = await s3Client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: candidate.key })).catch(() => null);
        if (!headResult) continue;
        const downloadUrl = await getSignedUrl(s3PublicClient, new GetObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: candidate.key,
          ResponseContentDisposition: `attachment; filename="${encodeURIComponent(asset.title)}${candidate.suffix}.mp4"`,
        }), { expiresIn: 3600 });
        return { data: { downloadUrl, fileSizeBytes: headResult.ContentLength ?? null } };
      }
      throw new NotFoundError('Rendition download not available');
    }

    // Download original source
    if (!asset.sourceKey) throw new NotFoundError('No source file available');

    const [headResult, downloadUrl] = await Promise.all([
      s3Client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.sourceKey })).catch(() => null),
      getSignedUrl(s3PublicClient, new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: asset.sourceKey,
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(asset.title)}.mp4"`,
      }), { expiresIn: 3600 }),
    ]);

    return { data: { downloadUrl, fileSizeBytes: headResult?.ContentLength ?? null } };
  });

  const updateTranscriptBody = z.object({
    transcript: z.object({
      language: z.string(),
      duration: z.number(),
      text: z.string(),
      segments: z.array(z.object({
        id: z.number(),
        start: z.number(),
        end: z.number(),
        text: z.string(),
        words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).optional(),
      })),
    }),
  });

  /* Update transcript + regenerate subtitles */
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateTranscriptBody> }>('/v1/assets/:id/transcript', {
    bodyLimit: TEXT_TRACK_BODY_LIMIT,
  }, async (request) => {
    const { transcript } = updateTranscriptBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const prefix = `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}`;

    // Upload updated transcript.json
    await s3Client.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: `${prefix}/${S3_PATHS.AI_TRANSCRIPT}`,
      Body: JSON.stringify(transcript, null, 2),
      ContentType: 'application/json',
      ACL: 'public-read',
    }));

    // Regenerate and upload subtitles.vtt
    const vtt = generateVttFromSegments(transcript.segments);
    await s3Client.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: `${prefix}/${S3_PATHS.AI_SUBTITLES}`,
      Body: vtt,
      ContentType: 'text/vtt',
      ACL: 'public-read',
    }));

    return { data: { id: asset.id, updated: ['transcript', 'subtitles'] } };
  });

  const updateChaptersBody = z.object({
    chapters: z.array(z.object({
      title: z.string(),
      startTime: z.number(),
      endTime: z.number(),
    })),
  });

  /* Update chapters */
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateChaptersBody> }>('/v1/assets/:id/chapters', {
    bodyLimit: TEXT_TRACK_BODY_LIMIT,
  }, async (request) => {
    const { chapters } = updateChaptersBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const prefix = `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: `${prefix}/${S3_PATHS.AI_CHAPTERS}`,
      Body: JSON.stringify({ chapters }, null, 2),
      ContentType: 'application/json',
      ACL: 'public-read',
    }));

    return { data: { id: asset.id, updated: ['chapters'] } };
  });
}
