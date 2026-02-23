import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { assets, aiJobs, ASSET_STATUS, S3_PATHS } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { NotFoundError } from '../middleware/error-handler.js';

export async function aiRoutes(app: FastifyInstance) {
  /** Public AI data for a playback ID */
  app.get<{ Params: { playbackId: string } }>('/v1/playback/:playbackId/ai', async (request) => {
    const { playbackId } = request.params;

    const [asset] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.playbackId, playbackId), eq(assets.status, ASSET_STATUS.READY)))
      .limit(1);

    if (!asset) throw new NotFoundError('Playback not found');

    const [aiJob] = await db
      .select()
      .from(aiJobs)
      .where(eq(aiJobs.assetId, asset.id))
      .limit(1);

    if (!aiJob) {
      return { data: { status: 'none' } };
    }

    const baseUrl = `${env.S3_PUBLIC_BASE_URL}/${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}`;

    return {
      data: {
        status: aiJob.status,
        language: aiJob.language,
        transcriptionStatus: aiJob.transcriptionStatus,
        subtitlesStatus: aiJob.subtitlesStatus,
        chaptersStatus: aiJob.chaptersStatus,
        subtitlesUrl: aiJob.subtitlesPath ? `${baseUrl}/${S3_PATHS.AI_SUBTITLES}` : null,
        transcriptUrl: aiJob.transcriptPath ? `${baseUrl}/${S3_PATHS.AI_TRANSCRIPT}` : null,
        chaptersUrl: aiJob.chaptersPath ? `${baseUrl}/${S3_PATHS.AI_CHAPTERS}` : null,
      },
    };
  });
}
