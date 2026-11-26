import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { aiJobs, S3_PATHS } from '@hovod/db';
import { db } from '../db.js';
import { playbackFileUrl, resolvePlayback } from '../services/playback-access.js';

export async function aiRoutes(app: FastifyInstance) {
  /** Public AI data for a playback ID */
  app.get<{ Params: { playbackId: string } }>('/v1/playback/:playbackId/ai', async (request) => {
    const { asset } = await resolvePlayback(request, request.params.playbackId);

    // Newest first: re-processing an asset inserts another ai_jobs row, and an
    // unordered LIMIT 1 would keep serving the previous run's statuses.
    const [aiJob] = await db
      .select()
      .from(aiJobs)
      .where(eq(aiJobs.assetId, asset.id))
      .orderBy(desc(aiJobs.createdAt))
      .limit(1);

    if (!aiJob) {
      return { data: { status: 'none' } };
    }

    const [subtitlesUrl, transcriptUrl, chaptersUrl] = await Promise.all([
      aiJob.subtitlesPath ? playbackFileUrl(asset, S3_PATHS.AI_SUBTITLES) : null,
      aiJob.transcriptPath ? playbackFileUrl(asset, S3_PATHS.AI_TRANSCRIPT) : null,
      aiJob.chaptersPath ? playbackFileUrl(asset, S3_PATHS.AI_CHAPTERS) : null,
    ]);

    return {
      data: {
        status: aiJob.status,
        language: aiJob.language,
        transcriptionStatus: aiJob.transcriptionStatus,
        subtitlesStatus: aiJob.subtitlesStatus,
        chaptersStatus: aiJob.chaptersStatus,
        subtitlesUrl,
        transcriptUrl,
        chaptersUrl,
      },
    };
  });
}
