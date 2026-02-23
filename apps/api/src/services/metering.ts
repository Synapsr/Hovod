import { Redis } from 'ioredis';
import { env, hasStripe } from '../env.js';

const EXPIRY_SECONDS = 90 * 24 * 60 * 60; // 90 days

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    redis.connect().catch(() => { /* non-fatal — metering is best-effort */ });
  }
  return redis;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function key(orgId: string, metric: string): string {
  return `usage:${orgId}:${metric}:${currentMonth()}`;
}

/** Increment a usage counter. Returns the new value. */
export async function incrementUsage(orgId: string, metric: string, amount: number): Promise<number> {
  if (!hasStripe) return 0;
  const r = getRedis();
  const k = key(orgId, metric);
  const newVal = await r.incrby(k, amount);
  if (newVal === amount) {
    await r.expire(k, EXPIRY_SECONDS).catch(() => {});
  }
  return newVal;
}

/** Get current usage for a metric. */
export async function getUsage(orgId: string, metric: string): Promise<number> {
  if (!hasStripe) return 0;
  const val = await getRedis().get(key(orgId, metric));
  return Number(val || 0);
}

/** Get all usage counters for the current billing period. */
export async function getAllUsage(orgId: string): Promise<{
  encodingMinutes: number;
  storageGb: number;
  deliveryMinutes: number;
}> {
  if (!hasStripe) return { encodingMinutes: 0, storageGb: 0, deliveryMinutes: 0 };
  const r = getRedis();
  const month = currentMonth();
  const [enc, stor, del] = await r.mget(
    `usage:${orgId}:encodingMinutes:${month}`,
    `usage:${orgId}:storageGb:${month}`,
    `usage:${orgId}:deliveryMinutes:${month}`,
  );
  return {
    encodingMinutes: Number(enc || 0),
    storageGb: Number(stor || 0),
    deliveryMinutes: Number(del || 0),
  };
}

/** Check if usage is within the limit. Returns true if OK, false if over limit. */
export async function checkLimit(orgId: string, metric: string, limit: number): Promise<boolean> {
  if (limit === -1) return true; // unlimited
  const current = await getUsage(orgId, metric);
  return current < limit;
}

/** Close Redis connection (graceful shutdown). */
export async function closeMetering(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => {});
    redis = null;
  }
}
