import { Queue } from 'bullmq';
import { ANALYTICS } from '@hovod/db';
import { env } from './env.js';

/** Keep finished jobs around for inspection, but never let Redis grow unbounded. */
const jobRetention = {
  removeOnComplete: { age: 86_400, count: 1000 },   // 1 day
  removeOnFail: { age: 604_800, count: 1000 },      // 7 days
};

export const transcodeQueue = new Queue('transcode', {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: {
    ...jobRetention,
    // Safe because the worker is idempotent (renditions rows are reset at job start)
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
  },
});

/** Analytics maintenance (session retention cleanup). Consumed by apps/worker/src/analytics-worker.ts. */
export const analyticsQueue = new Queue(ANALYTICS.QUEUE_NAME, {
  connection: { url: env.REDIS_URL },
  defaultJobOptions: { ...jobRetention },
});

/**
 * Deterministic BullMQ job id for an asset's transcode job (one in-flight job
 * per asset). BullMQ forbids ':' in custom ids, hence the dash.
 * Mirrored in apps/worker/src/index.ts (transcodeJobIdFor).
 */
export function transcodeJobId(assetId: string): string {
  return `transcode-${assetId}`;
}

/**
 * Register the daily session cleanup and drop the v0.x aggregation schedulers
 * (hourly/daily rollups, 30-day event purge) that no longer have a consumer.
 */
export async function scheduleAnalyticsJobs() {
  await analyticsQueue.upsertJobScheduler(
    'analytics-cleanup',
    { every: 86_400_000 },
    { name: 'cleanup', data: { type: 'cleanup', retentionDays: env.ANALYTICS_RETENTION_DAYS } },
  );

  const legacy = new Queue(ANALYTICS.LEGACY_QUEUE_NAME, { connection: { url: env.REDIS_URL } });
  try {
    for (const id of ['hourly-aggregation', 'daily-aggregation', 'cleanup-events']) {
      await legacy.removeJobScheduler(id).catch(() => {});
    }
  } finally {
    await legacy.close();
  }
}
