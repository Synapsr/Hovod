import { Queue } from 'bullmq';
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

export const analyticsQueue = new Queue('analytics-aggregation', {
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

export async function scheduleAnalyticsJobs() {
  await analyticsQueue.upsertJobScheduler(
    'hourly-aggregation',
    { every: 300_000 },
    { name: 'aggregate', data: { type: 'hourly' } },
  );

  await analyticsQueue.upsertJobScheduler(
    'daily-aggregation',
    { every: 86_400_000 },
    { name: 'aggregate', data: { type: 'daily' } },
  );

  await analyticsQueue.upsertJobScheduler(
    'cleanup-events',
    { every: 86_400_000 },
    { name: 'aggregate', data: { type: 'cleanup', retentionDays: 30 } },
  );
}
