/**
 * Pure usage / quota helpers shared by the API (limit checks at request time)
 * and the worker (authoritative checks once the source duration is known).
 * No I/O here — the DB-backed helpers live in apps/api/src/services/usage.ts.
 */

/** Month key of `usage_monthly`: UTC `YYYY-MM`. */
export function usageMonthKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/** First day of the month after `date`, as UTC `YYYY-MM-01` (when the counters reset). */
export function usageResetDate(date: Date = new Date()): string {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

/** Bytes allowed by a storage limit expressed in GB (decimal gigabytes, as sold). */
export function storageLimitBytes(storageGb: number): number {
  return storageGb * 1_000_000_000;
}

/** Minutes → seconds for the per-month counters. */
export function minutesToSeconds(minutes: number): number {
  return minutes * 60;
}

/** True when the counter has reached the ceiling (nothing more may be started). */
export function quotaReached(usedSec: number, limitMinutes: number): boolean {
  return usedSec >= minutesToSeconds(limitMinutes);
}

/** True when adding `addSec` would push the counter over the ceiling. */
export function quotaWouldExceed(usedSec: number, addSec: number, limitMinutes: number): boolean {
  return usedSec + Math.max(0, addSec) > minutesToSeconds(limitMinutes);
}

/** Message stored on a job that was refused for quota reasons. */
export function quotaMessage(kind: 'encoding' | 'AI', limitMinutes: number, date: Date = new Date()): string {
  return `Monthly ${kind} quota reached (${limitMinutes} min). Resets on ${usageResetDate(date)}.`;
}
