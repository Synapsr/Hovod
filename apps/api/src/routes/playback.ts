import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assets, aiJobs, settings, ASSET_STATUS, S3_PATHS, DEFAULT_SETTINGS } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { s3PublicClient } from '../s3.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';
import { findAssetOrFail, getPlaybackUrls, getThumbnailUrl } from '../services/asset.js';
import { insertManifestView } from '../services/analytics.js';
import { verifyJwt } from '../services/cloud.js';

export async function playbackRoutes(app: FastifyInstance) {
  /* Get playback info for an asset */
  app.get<{ Params: { id: string } }>('/v1/assets/:id/playback', async (request) => {
    const asset = await findAssetOrFail(request.params.id);
    return { data: getPlaybackUrls(asset.id, asset.playbackId) };
  });

  /* Public playback endpoint */
  app.get<{ Params: { playbackId: string } }>('/v1/playback/:playbackId', async (request) => {
    const { playbackId } = request.params;
    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.playbackId, playbackId), eq(assets.status, ASSET_STATUS.READY)))
      .limit(1);

    if (!asset) throw new NotFoundError('Playback not found');

    // Fire-and-forget: track manifest request
    insertManifestView(asset.id, asset.playbackId, request).catch(() => {});

    const playbackUrls = getPlaybackUrls(asset.id, asset.playbackId);

    // Determine if the viewer can edit this asset (requires valid JWT for the same org)
    let canEdit = false;
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : undefined;
    if (bearer) {
      try {
        const payload = verifyJwt(bearer, env.JWT_SECRET);
        canEdit = asset.orgId === payload.org;
      } catch { /* invalid token — read-only */ }
    }

    // Attach AI data if available
    const [aiJob] = await db
      .select()
      .from(aiJobs)
      .where(eq(aiJobs.assetId, asset.id))
      .limit(1);

    const baseUrl = `${env.S3_PUBLIC_BASE_URL}/${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}`;

    // Resolve org settings (or fall back to global/null-org settings)
    const settingsCondition = asset.orgId ? eq(settings.orgId, asset.orgId) : isNull(settings.orgId);
    const [settingsRow] = await db.select().from(settings).where(settingsCondition).limit(1);

    const defaultPublicSettings = { allowDownload: false, showTranscript: true, showChapters: true, showComments: true };
    const publicSettings = (asset.publicSettings as Record<string, unknown> | null)
      ? { ...defaultPublicSettings, ...(asset.publicSettings as Record<string, boolean>) }
      : defaultPublicSettings;

    return {
      data: {
        ...playbackUrls,
        thumbnailUrl: getThumbnailUrl(asset.id, asset.status, asset.customThumbnailKey),
        title: asset.title,
        description: asset.description ?? null,
        durationSec: asset.durationSec,
        canEdit,
        publicSettings,
        settings: {
          primaryColor: settingsRow?.primaryColor ?? DEFAULT_SETTINGS.PRIMARY_COLOR,
          theme: settingsRow?.theme ?? DEFAULT_SETTINGS.THEME,
          logoUrl: settingsRow?.logoKey ? `${env.S3_PUBLIC_BASE_URL}/${settingsRow.logoKey}` : null,
        },
        ai: aiJob && aiJob.status !== 'skipped' ? {
          status: aiJob.status,
          subtitlesUrl: aiJob.subtitlesPath ? `${baseUrl}/${S3_PATHS.AI_SUBTITLES}` : null,
          chaptersUrl: aiJob.chaptersPath ? `${baseUrl}/${S3_PATHS.AI_CHAPTERS}` : null,
          transcriptUrl: aiJob.transcriptPath ? `${baseUrl}/${S3_PATHS.AI_TRANSCRIPT}` : null,
          language: aiJob.language,
        } : null,
      },
    };
  });

  /* Public download endpoint */
  app.get<{ Params: { playbackId: string } }>('/v1/playback/:playbackId/download', async (request) => {
    const { playbackId } = request.params;
    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.playbackId, playbackId), eq(assets.status, ASSET_STATUS.READY)))
      .limit(1);

    if (!asset) throw new NotFoundError('Playback not found');

    const ps = asset.publicSettings as Record<string, boolean> | null;
    if (!ps?.allowDownload) throw new AppError(403, 'Download is not enabled for this video');
    if (!asset.sourceKey) throw new NotFoundError('No source file available');

    const command = new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: asset.sourceKey,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(asset.title)}.mp4"`,
    });

    const downloadUrl = await getSignedUrl(s3PublicClient, command, { expiresIn: 3600 });
    return { data: { downloadUrl } };
  });
}
