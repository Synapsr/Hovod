import { and, eq, ne, sql } from 'drizzle-orm';
import {
  assets,
  usageMonthly,
  ASSET_STATUS,
  usageMonthKey,
  storageLimitBytes,
  quotaReached,
  quotaMessage,
  type PlanLimits,
} from '@hovod/db';
import { db } from '../db.js';
import { isCloud } from '../env.js';
import { LimitError, type Entitlement } from './entitlements.js';

/**
 * Usage counters of an organization.
 *
 * `encodingSec` / `aiSec` come from `usage_monthly` (written by the worker for
 * the current UTC month); `storageBytes` is the live sum of `assets.storage_bytes`.
 */
export interface OrgUsage {
  month: string;
  encodingSec: number;
  aiSec: number;
  storageBytes: number;
}

/** Shape exposed by `/v1/auth/me` and the org endpoints. */
export interface UsageSummary {
  encodingMinutes: number;
  aiMinutes: number;
  storageBytes: number;
}

export async function getOrgUsage(orgId: string, now: Date = new Date()): Promise<OrgUsage> {
  const month = usageMonthKey(now);

  const [[monthly], [storage]] = await Promise.all([
    db
      .select({ encodingSec: usageMonthly.encodingSec, aiSec: usageMonthly.aiSec })
      .from(usageMonthly)
      .where(and(eq(usageMonthly.orgId, orgId), eq(usageMonthly.month, month)))
      .limit(1),
    db
      .select({ total: sql<string | number | null>`COALESCE(SUM(${assets.storageBytes}), 0)` })
      .from(assets)
      .where(and(eq(assets.orgId, orgId), ne(assets.status, ASSET_STATUS.DELETED))),
  ]);

  return {
    month,
    encodingSec: Number(monthly?.encodingSec ?? 0),
    aiSec: Number(monthly?.aiSec ?? 0),
    storageBytes: Number(storage?.total ?? 0),
  };
}

export function summarizeUsage(usage: OrgUsage): UsageSummary {
  return {
    encodingMinutes: Math.round((usage.encodingSec / 60) * 10) / 10,
    aiMinutes: Math.round((usage.aiSec / 60) * 10) / 10,
    storageBytes: usage.storageBytes,
  };
}

export async function getUsageSummary(orgId: string): Promise<UsageSummary> {
  return summarizeUsage(await getOrgUsage(orgId));
}

/* ─── Limit checks (cloud only; the worker re-checks with the real duration) ─── */

export function storageLimitReached(usage: Pick<OrgUsage, 'storageBytes'>, limits: PlanLimits): boolean {
  return usage.storageBytes >= storageLimitBytes(limits.storageGb);
}

export function encodingLimitReached(usage: Pick<OrgUsage, 'encodingSec'>, limits: PlanLimits): boolean {
  return quotaReached(usage.encodingSec, limits.encodingMinutes);
}

/**
 * Refuse to start new work when the org is at its storage or monthly encoding
 * ceiling. Cheap pre-check used by `POST /v1/assets` and `/process` — the worker
 * remains authoritative once the duration is known.
 */
export async function assertCanStartEncoding(orgId: string, entitlement: Entitlement): Promise<void> {
  if (!isCloud || !entitlement.limits) return;
  const limits = entitlement.limits;
  const usage = await getOrgUsage(orgId);

  if (storageLimitReached(usage, limits)) {
    throw new LimitError(
      'storage_limit',
      `Storage limit reached (${limits.storageGb} GB). Delete videos or upgrade your plan.`,
    );
  }
  if (encodingLimitReached(usage, limits)) {
    throw new LimitError('encoding_limit', quotaMessage('encoding', limits.encodingMinutes));
  }
}
