import type { FastifyInstance, FastifyReply } from 'fastify';
import { desc, eq, isNull } from 'drizzle-orm';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { aiJobs, settings, S3_PATHS, DEFAULT_SETTINGS } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { s3PublicClient } from '../s3.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';
import { findAssetOrFail } from '../services/asset.js';
import {
  RENDITION_RE,
  cachedRewrite,
  isSigned,
  masterPlaylistFor,
  playbackFileUrl,
  playbackUrls,
  resolvePlayback,
  rewriteMediaPlaylist,
  rewriteThumbnailVtt,
  signPlaybackToken,
  thumbnailUrlFor,
} from '../services/playback-access.js';

const HLS_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

/** Rewritten playlists embed presigned URLs (and the master a token): never cache them in shared caches. */
function sendPrivateText(reply: FastifyReply, contentType: string, body: string) {
  return reply
    .header('content-type', contentType)
    .header('cache-control', 'private, no-store')
    .send(body);
}

export async function playbackRoutes(app: FastifyInstance) {
  /* Get playback info for an asset (owner side: dashboard, API keys) */
  app.get<{ Params: { id: string } }>('/v1/assets/:id/playback', async (request) => {
    // Org-scoped: without it any authenticated tenant could resolve another
    // tenant's playback id from a guessed asset id.
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const token = isSigned(asset) ? signPlaybackToken(asset.playbackId).token : null;
    return { data: playbackUrls(asset, token) };
  });

  /* Public playback endpoint */
  app.get<{ Params: { playbackId: string } }>('/v1/playback/:playbackId', async (request) => {
    const { asset, token, isOwner } = await resolvePlayback(request, request.params.playbackId);

    // Views are counted exclusively from the player's own `view_start` event
    // (a metadata fetch is not a view — counting it here doubled every number).

    // Attach AI data if available
    // Newest first: re-processing an asset inserts another ai_jobs row, and an
    // unordered LIMIT 1 would keep serving the previous run's statuses.
    const [aiJob] = await db
      .select()
      .from(aiJobs)
      .where(eq(aiJobs.assetId, asset.id))
      .orderBy(desc(aiJobs.createdAt))
      .limit(1);

    // Resolve org settings (or fall back to global/null-org settings)
    const settingsCondition = asset.orgId ? eq(settings.orgId, asset.orgId) : isNull(settings.orgId);
    const [settingsRow] = await db.select().from(settings).where(settingsCondition).limit(1);

    const defaultPublicSettings = { allowDownload: false, showTranscript: true, showChapters: true, showComments: true };
    const publicSettings = (asset.publicSettings as Record<string, unknown> | null)
      ? { ...defaultPublicSettings, ...(asset.publicSettings as Record<string, boolean>) }
      : defaultPublicSettings;

    const [thumbnailUrl, subtitlesUrl, chaptersUrl, transcriptUrl] = await Promise.all([
      thumbnailUrlFor(asset),
      aiJob?.subtitlesPath ? playbackFileUrl(asset, S3_PATHS.AI_SUBTITLES) : null,
      aiJob?.chaptersPath ? playbackFileUrl(asset, S3_PATHS.AI_CHAPTERS) : null,
      aiJob?.transcriptPath ? playbackFileUrl(asset, S3_PATHS.AI_TRANSCRIPT) : null,
    ]);

    return {
      data: {
        ...playbackUrls(asset, token),
        thumbnailUrl,
        title: asset.title,
        description: asset.description ?? null,
        durationSec: asset.durationSec,
        canEdit: isOwner,
        publicSettings,
        settings: {
          primaryColor: settingsRow?.primaryColor ?? DEFAULT_SETTINGS.PRIMARY_COLOR,
          theme: settingsRow?.theme ?? DEFAULT_SETTINGS.THEME,
          logoUrl: settingsRow?.logoKey ? `${env.S3_PUBLIC_BASE_URL}/${settingsRow.logoKey}` : null,
        },
        ai: aiJob && aiJob.status !== 'skipped' ? {
          status: aiJob.status,
          subtitlesUrl,
          chaptersUrl,
          transcriptUrl,
          language: aiJob.language,
        } : null,
      },
    };
  });

  /* ─── HLS through the API (signed assets; works for public ones too) ─── */

  app.get<{ Params: { playbackId: string } }>('/v1/playback/:playbackId/master.m3u8', async (request, reply) => {
    const { asset, token } = await resolvePlayback(request, request.params.playbackId);
    return sendPrivateText(reply, HLS_CONTENT_TYPE, await masterPlaylistFor(asset, token));
  });

  app.get<{ Params: { playbackId: string; rendition: string } }>('/v1/playback/:playbackId/:rendition/index.m3u8', async (request, reply) => {
    if (!RENDITION_RE.test(request.params.rendition)) throw new NotFoundError('Playlist not found');
    const { asset } = await resolvePlayback(request, request.params.playbackId);
    const body = await cachedRewrite(asset, `${request.params.rendition}/index.m3u8`, rewriteMediaPlaylist);
    return sendPrivateText(reply, HLS_CONTENT_TYPE, body);
  });

  app.get<{ Params: { playbackId: string } }>('/v1/playback/:playbackId/thumbnails.vtt', async (request, reply) => {
    const { asset } = await resolvePlayback(request, request.params.playbackId);
    const body = await cachedRewrite(asset, S3_PATHS.THUMBNAILS_VTT, rewriteThumbnailVtt);
    return sendPrivateText(reply, 'text/vtt; charset=utf-8', body);
  });

  /* Public download endpoint */
  app.get<{ Params: { playbackId: string } }>('/v1/playback/:playbackId/download', async (request) => {
    const { asset } = await resolvePlayback(request, request.params.playbackId);

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
