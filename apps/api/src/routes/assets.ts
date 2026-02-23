import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { assets, jobs, renditions, aiJobs, ASSET_STATUS, SOURCE_TYPE, JOB_STATUS, JOB_TYPE, S3_PATHS, ID_LENGTH, TIER_LIMITS, UNLIMITED_TIER_LIMITS, WEBHOOK_EVENT, METADATA_LIMITS, type OrgTier } from '@hovod/db';
import { db } from '../db.js';
import { env, hasStripe } from '../env.js';
import { s3Client, s3PublicClient } from '../s3.js';
import { transcodeQueue } from '../queue.js';
import { findAssetOrFail, getThumbnailUrl, getSourceKey } from '../services/asset.js';
import { checkLimit } from '../services/metering.js';
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

export async function assetRoutes(app: FastifyInstance) {
  /* Create asset */
  app.post<{ Body: z.infer<typeof createAssetBody> }>('/v1/assets', async (request, reply) => {
    const body = createAssetBody.parse(request.body);
    const id = nanoid(ID_LENGTH.ASSET);
    const playbackId = nanoid(ID_LENGTH.PLAYBACK);

    // Check asset limit (enforced only with Stripe billing)
    if (hasStripe && request.orgId) {
      const limits = TIER_LIMITS[request.orgTier as OrgTier] ?? TIER_LIMITS.free;
      if (limits.maxAssets !== -1) {
        const existing = await db.select({ id: assets.id }).from(assets).where(eq(assets.orgId, request.orgId!));
        if (existing.length >= limits.maxAssets) {
          throw new AppError(403, `Asset limit reached (${limits.maxAssets} on ${request.orgTier} plan). Upgrade for unlimited assets.`);
        }
      }
    }

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

  /* List assets */
  app.get('/v1/assets', async (request) => {
    const list = await db
      .select()
      .from(assets)
      .where(eq(assets.orgId, request.orgId!))
      .orderBy(desc(assets.createdAt));
    return {
      data: list.map((a) => ({
        ...a,
        thumbnailUrl: getThumbnailUrl(a.id, a.status, a.customThumbnailKey),
      })),
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

      await pipeline(request.body as Readable, createWriteStream(filePath));

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

    // Verify ownership in cloud mode
    await findAssetOrFail(id, request.orgId);

    const result = await db
      .update(assets)
      .set({ sourceType: SOURCE_TYPE.URL, sourceUrl: body.sourceUrl, status: ASSET_STATUS.UPLOADED })
      .where(eq(assets.id, id));

    if (result[0].affectedRows === 0) {
      await findAssetOrFail(id);
    }

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

  app.post<{ Params: { id: string } }>('/v1/assets/:id/process', async (request) => {
    const body = processBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);

    // Check encoding minutes limit (enforced only with Stripe billing)
    if (hasStripe && request.orgId) {
      const limits = TIER_LIMITS[request.orgTier as OrgTier] ?? TIER_LIMITS.free;
      const withinLimit = await checkLimit(request.orgId, 'encodingMinutes', limits.encodingMinutes);
      if (!withinLimit) {
        throw new AppError(403, `Encoding minutes limit reached (${limits.encodingMinutes} min on ${request.orgTier} plan). Upgrade for more.`);
      }
    }

    // Store AI options in asset metadata
    if (body?.aiOptions) {
      const existing = asset.metadata ? (typeof asset.metadata === 'string' ? JSON.parse(asset.metadata) : asset.metadata) as Record<string, unknown> : {};
      await db.update(assets).set({ metadata: JSON.stringify({ ...existing, aiOptions: body.aiOptions }) }).where(eq(assets.id, asset.id));
    }

    const jobId = nanoid(ID_LENGTH.JOB);

    await db.insert(jobs).values({
      id: jobId,
      assetId: asset.id,
      type: JOB_TYPE.TRANSCODE,
      status: JOB_STATUS.QUEUED,
      attempts: 0,
    });
    await db.update(assets).set({ status: ASSET_STATUS.QUEUED }).where(eq(assets.id, asset.id));
    await transcodeQueue.add('transcode', { assetId: asset.id, jobId }, { jobId });

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
      const contentType = request.headers['content-type'] || 'image/jpeg';
      const extMap: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
      const ext = extMap[contentType] || 'jpg';
      const thumbnailKey = `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}/custom-thumbnail.${ext}`;

      const chunks: Buffer[] = [];
      for await (const chunk of request.body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      await s3Client.send(new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: thumbnailKey,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read',
      }));

      await db.update(assets).set({ customThumbnailKey: thumbnailKey }).where(eq(assets.id, asset.id));

      return {
        data: { thumbnailUrl: `${env.S3_PUBLIC_BASE_URL}/${thumbnailKey}` },
      };
    });
  });

  /* Download original source file or rendition */
  app.get<{ Params: { id: string }; Querystring: { quality?: string } }>('/v1/assets/:id/download', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const { quality } = request.query;

    if (quality) {
      // Download a specific rendition MP4
      const s3Key = `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}/${quality}/download.mp4`;
      const [headResult, downloadUrl] = await Promise.all([
        s3Client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: s3Key })).catch(() => null),
        getSignedUrl(s3PublicClient, new GetObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: s3Key,
          ResponseContentDisposition: `attachment; filename="${encodeURIComponent(asset.title)}-${quality}.mp4"`,
        }), { expiresIn: 3600 }),
      ]);
      if (!headResult) throw new NotFoundError('Rendition download not available');
      return { data: { downloadUrl, fileSizeBytes: headResult.ContentLength ?? null } };
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
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateTranscriptBody> }>('/v1/assets/:id/transcript', async (request) => {
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
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateChaptersBody> }>('/v1/assets/:id/chapters', async (request) => {
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
