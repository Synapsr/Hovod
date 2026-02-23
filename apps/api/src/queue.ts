import { Queue } from 'bullmq';
import { env } from './env.js';

export const transcodeQueue = new Queue('transcode', {
  connection: { url: env.REDIS_URL },
});

export const analyticsQueue = new Queue('analytics-aggregation', {
  connection: { url: env.REDIS_URL },
});

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
