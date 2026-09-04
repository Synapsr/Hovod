import { Worker } from 'bullmq';
import type { ResultSetHeader } from 'mysql2/promise';
import { ANALYTICS, createDb } from '@hovod/db';
import { env } from './env.js';

/**
 * Analytics maintenance worker.
 *
 * Analytics are computed on read from `playback_sessions` (see
 * apps/api/src/services/analytics.ts); the only background job left is the
 * daily retention cleanup scheduled by the API (apps/api/src/queue.ts).
 */

const { pool } = createDb(env.DATABASE_URL, { connectionLimit: 2 });

interface CleanupJob {
  type: 'cleanup';
  retentionDays?: number;
}

/**
 * Delete sessions that started more than `retentionDays` ago, in batches of
 * {@link ANALYTICS.CLEANUP_BATCH_SIZE} rows until drained (a single huge DELETE
 * would hold locks for minutes on a busy install).
 */
export async function cleanupOldSessions(retentionDays: number): Promise<number> {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : ANALYTICS.RETENTION_DAYS_DEFAULT;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const batch = ANALYTICS.CLEANUP_BATCH_SIZE;

  let removed = 0;
  for (;;) {
    const [res] = await pool.query<ResultSetHeader>(
      'DELETE FROM playback_sessions WHERE started_at < ? LIMIT ?',
      [cutoff, batch],
    );
    removed += res.affectedRows;
    if (res.affectedRows < batch) break;
  }

  console.log(`[analytics] Cleanup: removed ${removed} session(s) older than ${days} days`);
  return removed;
}

export function createAnalyticsWorker(redisUrl: string) {
  const worker = new Worker(
    ANALYTICS.QUEUE_NAME,
    async (job) => {
      const data = job.data as CleanupJob;
      if (data.type !== 'cleanup') {
        console.warn(`[analytics] Ignoring unknown job type "${String(data.type)}"`);
        return;
      }
      await cleanupOldSessions(data.retentionDays ?? ANALYTICS.RETENTION_DAYS_DEFAULT);
    },
    { connection: { url: redisUrl }, concurrency: 1 },
  );

  worker.on('ready', () => {
    console.log('[analytics] Analytics worker ready');
  });

  worker.on('failed', (job, err) => {
    console.error(`[analytics] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
