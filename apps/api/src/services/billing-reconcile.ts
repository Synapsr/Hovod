import { Redis } from 'ioredis';
import { env, isCloud } from '../env.js';
import { syncSubscription, orgsWithSubscription, countPendingOrgs } from './billing.js';

/**
 * Nightly reconcile: re-read every subscription from Stripe so a missed webhook
 * can never leave an org in the wrong state for more than a day.
 *
 * Runs every 24 h (with up to 1 h of jitter so replicas do not line up), the
 * first time 5 minutes after boot, under a Redis lock so only one API replica
 * does the work.
 */

export const RECONCILE_LOCK_KEY = 'hovod:reconcile';
export const RECONCILE_LOCK_TTL_SEC = 3_600;
export const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_JITTER_MS = 60 * 60 * 1000;
export const RECONCILE_FIRST_RUN_MS = 5 * 60 * 1000;

export interface ReconcileSummary {
  checked: number;
  synced: number;
  failed: number;
  pending: number;
  durationMs: number;
}

export interface ReconcileLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** One reconcile pass (no locking — callers hold the lock). */
export async function runReconcile(logger: ReconcileLogger = console): Promise<ReconcileSummary> {
  const started = Date.now();
  const orgs = await orgsWithSubscription();
  let synced = 0;
  let failed = 0;

  for (const org of orgs) {
    try {
      await syncSubscription(org.stripeSubscriptionId);
      synced += 1;
    } catch (err) {
      failed += 1;
      logger.warn(`[reconcile] org ${org.id} (${org.stripeSubscriptionId}): ${(err as Error).message}`);
    }
  }

  // Orgs with a customer but no subscription stay pending on purpose — the
  // paywall is the recovery path — they are only counted here.
  const pending = await countPendingOrgs().catch(() => 0);

  const summary: ReconcileSummary = { checked: orgs.length, synced, failed, pending, durationMs: Date.now() - started };
  logger.info(`[reconcile] ${summary.checked} subscription(s) checked, ${summary.synced} synced, ${summary.failed} failed, ${summary.pending} org(s) still pending (${summary.durationMs} ms)`);
  return summary;
}

/** `SET key NX EX ttl` — true when this process holds the lock. */
export async function acquireReconcileLock(redis: Redis): Promise<boolean> {
  const result = await redis.set(RECONCILE_LOCK_KEY, String(process.pid), 'EX', RECONCILE_LOCK_TTL_SEC, 'NX');
  return result === 'OK';
}

export interface ReconcileScheduler {
  stop(): Promise<void>;
  /** Run now if the lock is free (used by tests / ops). */
  trigger(): Promise<ReconcileSummary | null>;
}

/** Start the periodic reconcile. No-op (returns a dummy) outside cloud mode. */
export function startReconcileScheduler(logger: ReconcileLogger = console): ReconcileScheduler {
  if (!isCloud) {
    return { stop: async () => {}, trigger: async () => null };
  }

  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  redis.on('error', (err) => logger.warn(`[reconcile] Redis error: ${err.message}`));
  redis.connect().catch(() => { /* retried on next tick */ });

  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<ReconcileSummary | null> => {
    if (running || stopped) return null;
    running = true;
    try {
      if (!(await acquireReconcileLock(redis))) {
        logger.info('[reconcile] another replica holds the lock — skipping');
        return null;
      }
      return await runReconcile(logger);
    } catch (err) {
      logger.error(`[reconcile] failed: ${(err as Error).message}`);
      return null;
    } finally {
      running = false;
    }
  };

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await tick();
      schedule(RECONCILE_INTERVAL_MS + Math.floor(Math.random() * RECONCILE_JITTER_MS));
    }, delay);
    timer.unref();
  };

  schedule(RECONCILE_FIRST_RUN_MS);
  logger.info(`[reconcile] scheduled — first run in ${Math.round(RECONCILE_FIRST_RUN_MS / 60_000)} min, then every 24 h`);

  return {
    trigger: tick,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await redis.quit().catch(() => {});
    },
  };
}
