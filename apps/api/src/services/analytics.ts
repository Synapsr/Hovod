import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { ANALYTICS, ANALYTICS_EVENT, ASSET_STATUS, type AnalyticsPeriod } from '@hovod/db';
import { pool as defaultPool } from '../db.js';

/**
 * Session-based analytics.
 *
 * The player sends small event batches; the API folds every batch into ONE
 * upsert per session on `playback_sessions`. All reads are plain aggregations
 * over that table for the requested period — there is no background
 * aggregation and no second source of truth.
 *
 * Every function takes an optional mysql2 pool so the module can be exercised
 * against a throwaway database without booting the API.
 */

/* ─── Helpers ──────────────────────────────────────────────── */

export function parseDeviceType(ua: string): 'mobile' | 'tablet' | 'desktop' {
  if (/mobile|android.*mobile|iphone|ipod/i.test(ua)) return 'mobile';
  if (/tablet|ipad|android(?!.*mobile)/i.test(ua)) return 'tablet';
  return 'desktop';
}

export function parseCountryHint(acceptLanguage: string): string {
  const match = acceptLanguage.match(/[a-z]{2}-([A-Z]{2})/);
  return match ? match[1] : 'XX';
}

export function periodToDays(period: AnalyticsPeriod): number | null {
  if (period === '7d') return 7;
  if (period === '30d') return 30;
  if (period === '90d') return 90;
  return null; // 'all'
}

/** UTC cutoff for a period (null = no lower bound). */
export function periodStart(period: AnalyticsPeriod, now = new Date()): Date | null {
  const days = periodToDays(period);
  return days ? new Date(now.getTime() - days * 86_400_000) : null;
}

/** Finite number or undefined — bogus client values must never fail a batch. */
function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function clampInt(v: number | undefined, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

const MAX_INT = 2_147_483_647;

/* ─── playbackId → asset resolution (60 s cache) ──────────── */

interface PlaybackTarget {
  assetId: string;
  orgId: string;
}

interface CacheEntry {
  target: PlaybackTarget | null;
  expiresAt: number;
}

const PLAYBACK_CACHE_MAX = 5_000;
const playbackCache = new Map<string, CacheEntry>();

/**
 * Resolve a playback id to its asset. Only `ready` assets resolve; unknown ids
 * are cached as misses too (a flood of bogus ids must not hit the database).
 * Map iteration order is insertion order, so the oldest entry is evicted first.
 */
export async function resolvePlayback(
  playbackId: string,
  pool: Pool = defaultPool,
  now = Date.now(),
): Promise<PlaybackTarget | null> {
  const hit = playbackCache.get(playbackId);
  if (hit && hit.expiresAt > now) return hit.target;

  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT id, org_id FROM assets WHERE playback_id = ? AND status = ? LIMIT 1',
    [playbackId, ASSET_STATUS.READY],
  );
  const row = rows[0];
  const target = row ? { assetId: String(row.id), orgId: String(row.org_id) } : null;

  if (playbackCache.size >= PLAYBACK_CACHE_MAX) {
    const oldest = playbackCache.keys().next().value;
    if (oldest !== undefined) playbackCache.delete(oldest);
  }
  playbackCache.delete(playbackId);
  playbackCache.set(playbackId, { target, expiresAt: now + ANALYTICS.PLAYBACK_CACHE_TTL_MS });
  return target;
}

/** Test hook / cache invalidation after an asset changes state. */
export function clearPlaybackCache(playbackId?: string): void {
  if (playbackId) playbackCache.delete(playbackId);
  else playbackCache.clear();
}

/* ─── Event Ingestion ──────────────────────────────────────── */

export type AnalyticsEventType = (typeof ANALYTICS_EVENT)[keyof typeof ANALYTICS_EVENT];

/** One validated player event (see routes/analytics.ts for the wire schema). */
export interface IngestEvent {
  sessionId: string;
  playbackId: string;
  viewerId?: string;
  type: AnalyticsEventType;
  timestamp?: number;
  currentTime?: number;
  duration?: number;
  /** Milliseconds actually played since the previous heartbeat. */
  watchedMs?: number;
  qualityHeight?: number;
  bufferMs?: number;
  errorMessage?: string;
  referrer?: string;
  playerType?: string;
  owner?: boolean;
}

export interface IngestContext {
  userAgent: string;
  acceptLanguage: string;
  /** Injected clock for tests. */
  now?: Date;
}

export interface IngestResult {
  /** Events folded into a session (owner previews are accepted but never stored). */
  accepted: number;
  /** Events dropped: unknown / not-ready playback id. */
  rejected: number;
}

/** In-memory fold of every event of one session inside a batch. */
interface SessionDelta {
  sessionId: string;
  assetId: string;
  orgId: string;
  playbackId: string;
  viewerId: string | null;
  playerType: string | null;
  referrer: string | null;
  watchedMs: number;
  maxPositionSec: number;
  durationSec: number | null;
  qualityHeight: number | null;
  qualityChanges: number;
  bufferCount: number;
  bufferMs: number;
  errorCount: number;
  seekCount: number;
  pauseCount: number;
  lastError: string | null;
}

/**
 * Fold a batch of validated events into `playback_sessions`: one
 * `INSERT … ON DUPLICATE KEY UPDATE` per session touched by the batch.
 */
export async function ingestEvents(
  events: IngestEvent[],
  ctx: IngestContext,
  pool: Pool = defaultPool,
): Promise<IngestResult> {
  const now = ctx.now ?? new Date();
  const deviceType = parseDeviceType(ctx.userAgent);
  const country = parseCountryHint(ctx.acceptLanguage);
  const userAgent = ctx.userAgent ? ctx.userAgent.slice(0, 256) : null;

  let accepted = 0;
  let rejected = 0;
  const deltas = new Map<string, SessionDelta>();

  for (const ev of events) {
    // Owner previews never count — dropped before touching the database.
    if (ev.owner === true) {
      accepted++;
      continue;
    }

    const target = await resolvePlayback(ev.playbackId, pool, now.getTime());
    if (!target) {
      rejected++;
      continue;
    }
    accepted++;

    let delta = deltas.get(ev.sessionId);
    if (!delta) {
      delta = {
        sessionId: ev.sessionId,
        assetId: target.assetId,
        orgId: target.orgId,
        playbackId: ev.playbackId,
        viewerId: null,
        playerType: null,
        referrer: null,
        watchedMs: 0,
        maxPositionSec: 0,
        durationSec: null,
        qualityHeight: null,
        qualityChanges: 0,
        bufferCount: 0,
        bufferMs: 0,
        errorCount: 0,
        seekCount: 0,
        pauseCount: 0,
        lastError: null,
      };
      deltas.set(ev.sessionId, delta);
    } else if (delta.assetId !== target.assetId) {
      // A session id is bound to one playback; ignore events that point elsewhere.
      accepted--;
      rejected++;
      continue;
    }

    if (ev.viewerId && !delta.viewerId) delta.viewerId = ev.viewerId.slice(0, 40);
    if (ev.playerType && !delta.playerType) delta.playerType = ev.playerType.slice(0, 16);
    if (ev.referrer && !delta.referrer) delta.referrer = ev.referrer.slice(0, 512);

    const duration = clampInt(finite(ev.duration), 0, MAX_INT);
    if (duration && duration > 0) delta.durationSec = Math.max(delta.durationSec ?? 0, duration);

    const position = clampInt(finite(ev.currentTime), 0, MAX_INT);
    if (position !== undefined) delta.maxPositionSec = Math.max(delta.maxPositionSec, position);

    const quality = clampInt(finite(ev.qualityHeight), 1, 100_000);
    if (quality !== undefined) delta.qualityHeight = quality;

    switch (ev.type) {
      case ANALYTICS_EVENT.HEARTBEAT: {
        const watched = clampInt(finite(ev.watchedMs), 0, ANALYTICS.MAX_WATCHED_MS_PER_EVENT);
        if (watched !== undefined) delta.watchedMs += watched;
        break;
      }
      case ANALYTICS_EVENT.VIEW_END: {
        const watched = clampInt(finite(ev.watchedMs), 0, ANALYTICS.MAX_WATCHED_MS_PER_EVENT);
        if (watched !== undefined) delta.watchedMs += watched;
        break;
      }
      case ANALYTICS_EVENT.PAUSE:
        delta.pauseCount++;
        break;
      case ANALYTICS_EVENT.SEEK:
        delta.seekCount++;
        break;
      case ANALYTICS_EVENT.QUALITY_CHANGE:
        delta.qualityChanges++;
        break;
      case ANALYTICS_EVENT.BUFFER_END: {
        delta.bufferCount++;
        const ms = clampInt(finite(ev.bufferMs), 0, 600_000);
        if (ms !== undefined) delta.bufferMs += ms;
        break;
      }
      case ANALYTICS_EVENT.ERROR:
        delta.errorCount++;
        if (ev.errorMessage) delta.lastError = ev.errorMessage.slice(0, 255);
        break;
      case ANALYTICS_EVENT.VIEW_START:
      case ANALYTICS_EVENT.BUFFER_START:
      default:
        break;
    }
  }

  for (const delta of deltas.values()) {
    await upsertSession(pool, delta, { now, deviceType, country, userAgent });
  }

  return { accepted, rejected };
}

async function upsertSession(
  pool: Pool,
  d: SessionDelta,
  meta: { now: Date; deviceType: string; country: string; userAgent: string | null },
): Promise<void> {
  const watchedSec = Math.round(d.watchedMs / 1000);
  // A position past the known duration is clamped (ended events report duration+ε).
  const maxPosition = d.durationSec ? Math.min(d.maxPositionSec, d.durationSec) : d.maxPositionSec;
  const threshold = ANALYTICS.COMPLETION_THRESHOLD;

  // Assignments in ON DUPLICATE KEY UPDATE run left to right and see the already
  // updated columns, so `completed` (last) uses the new position and duration.
  await pool.query<ResultSetHeader>(
    `INSERT INTO playback_sessions
      (id, asset_id, org_id, playback_id, viewer_id, player_type, device_type, country, referrer, user_agent,
       started_at, last_seen_at, watched_sec, max_position_sec, duration_sec, quality_height,
       quality_changes, buffer_count, buffer_ms, error_count, seek_count, pause_count, completed, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       last_seen_at = GREATEST(last_seen_at, ?),
       viewer_id = COALESCE(viewer_id, ?),
       player_type = COALESCE(player_type, ?),
       referrer = COALESCE(referrer, ?),
       watched_sec = watched_sec + ?,
       max_position_sec = GREATEST(max_position_sec, ?),
       duration_sec = COALESCE(?, duration_sec),
       quality_height = COALESCE(?, quality_height),
       quality_changes = quality_changes + ?,
       buffer_count = buffer_count + ?,
       buffer_ms = buffer_ms + ?,
       error_count = error_count + ?,
       seek_count = seek_count + ?,
       pause_count = pause_count + ?,
       last_error = COALESCE(?, last_error),
       completed = (completed OR (duration_sec > 0 AND max_position_sec >= ? * duration_sec))`,
    [
      d.sessionId, d.assetId, d.orgId, d.playbackId, d.viewerId, d.playerType, meta.deviceType, meta.country,
      d.referrer, meta.userAgent,
      meta.now, meta.now, watchedSec, maxPosition, d.durationSec, d.qualityHeight,
      d.qualityChanges, d.bufferCount, d.bufferMs, d.errorCount, d.seekCount, d.pauseCount,
      d.durationSec && maxPosition >= threshold * d.durationSec ? 1 : 0,
      d.lastError,
      // update branch
      meta.now, d.viewerId, d.playerType, d.referrer, watchedSec, maxPosition, d.durationSec, d.qualityHeight,
      d.qualityChanges, d.bufferCount, d.bufferMs, d.errorCount, d.seekCount, d.pauseCount, d.lastError,
      threshold,
    ],
  );
}

/* ─── Read models ──────────────────────────────────────────── */

export interface TimeSeriesPoint {
  /** `YYYY-MM-DD` for day buckets, `YYYY-MM-DDTHH:00:00Z` for hour buckets (UTC). */
  date: string;
  views: number;
  uniqueViewers: number;
  watchTimeSec: number;
}

export interface HourPoint {
  /** UTC hour 0–23. */
  hour: number;
  views: number;
}

export interface AnalyticsSummary {
  /** Sessions that actually started playing (watched >= 1 s or reached >= 1 s). */
  views: number;
  /** Distinct browsers (viewer id); sessions without one count individually. */
  uniqueViewers: number;
  /** Sum of seconds actually played. */
  watchTimeSec: number;
  /** Mean of min(1, max_position / duration) over views with a known duration, in %. */
  avgWatchPercent: number;
  /** Share of views that reached 90 % of the duration, in %. */
  completionRate: number;
  /** 0.6 × avgWatchPercent + 0.3 × completionRate + 0.1 × (100 − min(100, % of views with an error)). */
  engagementScore: number;
  /** Views with at least one playback error. */
  errorSessions: number;
  /** Total playback errors. */
  errorCount: number;
  /** Rebuffering time as a share of watch time, in %. */
  bufferRatio: number;
  /** Total rebuffering events. */
  bufferCount: number;
  /** UTC hour with the most views (null without data). */
  peakHour: number | null;
}

export interface AssetAnalyticsResult {
  period: AnalyticsPeriod;
  granularity: 'hour' | 'day';
  summary: AnalyticsSummary;
  timeSeries: TimeSeriesPoint[];
  /** 10 deciles: % of views whose max position reached 10 %, 20 %, … 100 % of the duration. */
  retentionCurve: number[];
  peakHours: HourPoint[];
  devices: Record<string, number>;
  /** Views per last known rendition height, e.g. `{ "720": 12 }`. */
  qualityDistribution: Record<string, number>;
  topReferrers: Array<{ referrer: string; views: number }>;
}

export interface OverviewAnalyticsResult {
  period: AnalyticsPeriod;
  granularity: 'hour' | 'day';
  summary: AnalyticsSummary & { totalAssets: number };
  timeSeries: TimeSeriesPoint[];
  topAssets: Array<{
    assetId: string;
    title: string;
    views: number;
    uniqueViewers: number;
    watchTimeSec: number;
    avgWatchPercent: number;
    completionRate: number;
    engagementScore: number;
  }>;
  peakHours: HourPoint[];
  devices: Record<string, number>;
}

/** Sessions that count as a view. */
const VIEW_COND = '(s.watched_sec >= 1 OR s.max_position_sec >= 1)';
const WATCH_FRACTION = 'LEAST(1, s.max_position_sec / s.duration_sec)';

interface Scope {
  where: string;
  params: unknown[];
}

function scopeFor(kind: 'asset' | 'org', id: string, period: AnalyticsPeriod, now: Date): Scope {
  const start = periodStart(period, now);
  const col = kind === 'asset' ? 's.asset_id' : 's.org_id';
  const where = `${col} = ?${start ? ' AND s.started_at >= ?' : ''}`;
  const params: unknown[] = start ? [id, start] : [id];
  return { where, params };
}

async function rows(pool: Pool, sqlStr: string, params: unknown[]): Promise<RowDataPacket[]> {
  const [r] = await pool.query<RowDataPacket[]>(sqlStr, params);
  return r;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const pct = (v: unknown): number => Math.round(n(v) * 1000) / 10;

function engagementScore(avgWatchPercent: number, completionRate: number, views: number, errorSessions: number): number {
  if (views === 0) return 0;
  const errorPct = Math.min(100, (errorSessions / views) * 100);
  const score = 0.6 * avgWatchPercent + 0.3 * completionRate + 0.1 * (100 - errorPct);
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function loadSummary(pool: Pool, scope: Scope): Promise<AnalyticsSummary> {
  const [row] = await rows(
    pool,
    `SELECT
       COUNT(*) AS views,
       COUNT(DISTINCT COALESCE(s.viewer_id, s.id)) AS unique_viewers,
       COALESCE(SUM(s.watched_sec), 0) AS watch_time_sec,
       AVG(CASE WHEN s.duration_sec > 0 THEN ${WATCH_FRACTION} END) AS avg_watch,
       AVG(s.completed) AS completion,
       COALESCE(SUM(s.error_count > 0), 0) AS error_sessions,
       COALESCE(SUM(s.error_count), 0) AS error_count,
       COALESCE(SUM(s.buffer_count), 0) AS buffer_count,
       COALESCE(SUM(s.buffer_ms), 0) AS buffer_ms
     FROM playback_sessions s
     WHERE ${scope.where} AND ${VIEW_COND}`,
    scope.params,
  );

  const views = n(row?.views);
  const watchTimeSec = n(row?.watch_time_sec);
  const avgWatchPercent = pct(row?.avg_watch);
  const completionRate = pct(row?.completion);
  const errorSessions = n(row?.error_sessions);
  const bufferMs = n(row?.buffer_ms);

  return {
    views,
    uniqueViewers: n(row?.unique_viewers),
    watchTimeSec,
    avgWatchPercent,
    completionRate,
    engagementScore: engagementScore(avgWatchPercent, completionRate, views, errorSessions),
    errorSessions,
    errorCount: n(row?.error_count),
    bufferRatio: watchTimeSec > 0 ? Math.round((bufferMs / 1000 / watchTimeSec) * 1000) / 10 : 0,
    bufferCount: n(row?.buffer_count),
    peakHour: null,
  };
}

async function loadPeakHours(pool: Pool, scope: Scope): Promise<HourPoint[]> {
  const r = await rows(
    pool,
    `SELECT HOUR(s.started_at) AS hour, COUNT(*) AS views
     FROM playback_sessions s
     WHERE ${scope.where} AND ${VIEW_COND}
     GROUP BY HOUR(s.started_at)`,
    scope.params,
  );
  const byHour = new Map(r.map((x) => [n(x.hour), n(x.views)]));
  return Array.from({ length: 24 }, (_, hour) => ({ hour, views: byHour.get(hour) ?? 0 }));
}

function peakHourOf(points: HourPoint[]): number | null {
  let best: HourPoint | null = null;
  for (const p of points) if (p.views > 0 && (!best || p.views > best.views)) best = p;
  return best ? best.hour : null;
}

async function loadDevices(pool: Pool, scope: Scope): Promise<Record<string, number>> {
  const r = await rows(
    pool,
    `SELECT COALESCE(s.device_type, 'unknown') AS device, COUNT(*) AS views
     FROM playback_sessions s
     WHERE ${scope.where} AND ${VIEW_COND}
     GROUP BY COALESCE(s.device_type, 'unknown')`,
    scope.params,
  );
  const out: Record<string, number> = {};
  for (const x of r) out[String(x.device)] = n(x.views);
  return out;
}

async function loadQualityDistribution(pool: Pool, scope: Scope): Promise<Record<string, number>> {
  const r = await rows(
    pool,
    `SELECT s.quality_height AS height, COUNT(*) AS views
     FROM playback_sessions s
     WHERE ${scope.where} AND ${VIEW_COND} AND s.quality_height IS NOT NULL
     GROUP BY s.quality_height`,
    scope.params,
  );
  const out: Record<string, number> = {};
  for (const x of r) out[String(n(x.height))] = n(x.views);
  return out;
}

async function loadRetention(pool: Pool, scope: Scope): Promise<number[]> {
  const deciles = Array.from({ length: 10 }, (_, i) => (i + 1) / 10);
  const cols = deciles
    .map((d, i) => `COALESCE(SUM(${WATCH_FRACTION} >= ${d.toFixed(1)}), 0) AS d${i}`)
    .join(',\n       ');
  const [row] = await rows(
    pool,
    `SELECT COUNT(*) AS total,
       ${cols}
     FROM playback_sessions s
     WHERE ${scope.where} AND ${VIEW_COND} AND s.duration_sec > 0`,
    scope.params,
  );
  const total = n(row?.total);
  if (total === 0) return [];
  return deciles.map((_, i) => Math.round((n(row?.[`d${i}`]) / total) * 1000) / 10);
}

async function loadTopReferrers(pool: Pool, scope: Scope): Promise<Array<{ referrer: string; views: number }>> {
  // Group by host for http(s) referrers, keep anything else verbatim.
  const host = `CASE
      WHEN s.referrer IS NULL OR s.referrer = '' THEN '(direct)'
      WHEN s.referrer LIKE 'http%' THEN SUBSTRING_INDEX(SUBSTRING_INDEX(s.referrer, '/', 3), '//', -1)
      ELSE s.referrer END`;
  const r = await rows(
    pool,
    `SELECT ${host} AS ref, COUNT(*) AS views
     FROM playback_sessions s
     WHERE ${scope.where} AND ${VIEW_COND}
     GROUP BY ${host}
     ORDER BY views DESC, ref ASC
     LIMIT 5`,
    scope.params,
  );
  return r.map((x) => ({ referrer: String(x.ref), views: n(x.views) }));
}

/* ─── Time series ─────────────────────────────────────────── */

function granularityFor(period: AnalyticsPeriod): 'hour' | 'day' {
  return period === '7d' ? 'hour' : 'day';
}

function bucketKey(d: Date, granularity: 'hour' | 'day'): string {
  const iso = d.toISOString();
  return granularity === 'hour' ? `${iso.slice(0, 13)}:00:00Z` : iso.slice(0, 10);
}

/** Every bucket between `from` and `now` (inclusive), oldest first. */
function fillBuckets(from: Date, now: Date, granularity: 'hour' | 'day'): string[] {
  const step = granularity === 'hour' ? 3_600_000 : 86_400_000;
  const keys: string[] = [];
  const first = granularity === 'hour'
    ? Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours())
    : Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const last = now.getTime();
  // Cap at ~3 years of days / a month of hours so a pathological window cannot explode.
  const max = granularity === 'hour' ? 24 * 31 : 366 * 3;
  for (let t = first, i = 0; t <= last && i < max; t += step, i++) {
    keys.push(bucketKey(new Date(t), granularity));
  }
  return keys;
}

async function loadTimeSeries(
  pool: Pool,
  scope: Scope,
  period: AnalyticsPeriod,
  now: Date,
): Promise<{ granularity: 'hour' | 'day'; points: TimeSeriesPoint[] }> {
  const granularity = granularityFor(period);
  const fmt = granularity === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%d';
  const r = await rows(
    pool,
    `SELECT DATE_FORMAT(s.started_at, '${fmt}') AS bucket,
       COUNT(*) AS views,
       COUNT(DISTINCT COALESCE(s.viewer_id, s.id)) AS unique_viewers,
       COALESCE(SUM(s.watched_sec), 0) AS watch_time_sec,
       MIN(s.started_at) AS first_seen
     FROM playback_sessions s
     WHERE ${scope.where} AND ${VIEW_COND}
     GROUP BY DATE_FORMAT(s.started_at, '${fmt}')
     ORDER BY bucket`,
    scope.params,
  );

  const byBucket = new Map<string, TimeSeriesPoint>();
  let earliest: Date | null = null;
  for (const x of r) {
    byBucket.set(String(x.bucket), {
      date: String(x.bucket),
      views: n(x.views),
      uniqueViewers: n(x.unique_viewers),
      watchTimeSec: n(x.watch_time_sec),
    });
    const seen = x.first_seen instanceof Date ? x.first_seen : new Date(String(x.first_seen));
    if (!Number.isNaN(seen.getTime()) && (!earliest || seen < earliest)) earliest = seen;
  }

  const from = periodStart(period, now) ?? earliest;
  if (!from) return { granularity, points: [] };

  const points = fillBuckets(from, now, granularity).map(
    (date) => byBucket.get(date) ?? { date, views: 0, uniqueViewers: 0, watchTimeSec: 0 },
  );
  return { granularity, points };
}

/* ─── Per-asset analytics ─────────────────────────────────── */

export async function getAssetAnalytics(
  assetId: string,
  period: AnalyticsPeriod,
  pool: Pool = defaultPool,
  now = new Date(),
): Promise<AssetAnalyticsResult> {
  const scope = scopeFor('asset', assetId, period, now);

  const [summary, series, retentionCurve, peakHours, devices, qualityDistribution, topReferrers] =
    await Promise.all([
      loadSummary(pool, scope),
      loadTimeSeries(pool, scope, period, now),
      loadRetention(pool, scope),
      loadPeakHours(pool, scope),
      loadDevices(pool, scope),
      loadQualityDistribution(pool, scope),
      loadTopReferrers(pool, scope),
    ]);

  summary.peakHour = peakHourOf(peakHours);

  return {
    period,
    granularity: series.granularity,
    summary,
    timeSeries: series.points,
    retentionCurve,
    peakHours,
    devices,
    qualityDistribution,
    topReferrers,
  };
}

/* ─── Organization overview ───────────────────────────────── */

export async function getOverviewAnalytics(
  orgId: string,
  period: AnalyticsPeriod,
  pool: Pool = defaultPool,
  now = new Date(),
): Promise<OverviewAnalyticsResult> {
  const scope = scopeFor('org', orgId, period, now);

  const topAssetsQuery = rows(
    pool,
    `SELECT s.asset_id, a.title,
       COUNT(*) AS views,
       COUNT(DISTINCT COALESCE(s.viewer_id, s.id)) AS unique_viewers,
       COALESCE(SUM(s.watched_sec), 0) AS watch_time_sec,
       AVG(CASE WHEN s.duration_sec > 0 THEN ${WATCH_FRACTION} END) AS avg_watch,
       AVG(s.completed) AS completion,
       COALESCE(SUM(s.error_count > 0), 0) AS error_sessions
     FROM playback_sessions s
     INNER JOIN assets a ON a.id = s.asset_id
     WHERE ${scope.where} AND ${VIEW_COND} AND a.status <> ?
     GROUP BY s.asset_id, a.title
     ORDER BY views DESC, watch_time_sec DESC
     LIMIT 10`,
    [...scope.params, ASSET_STATUS.DELETED],
  );

  const assetCountQuery = rows(
    pool,
    'SELECT COUNT(*) AS cnt FROM assets WHERE org_id = ? AND status <> ?',
    [orgId, ASSET_STATUS.DELETED],
  );

  const [summary, series, peakHours, devices, topRows, countRows] = await Promise.all([
    loadSummary(pool, scope),
    loadTimeSeries(pool, scope, period, now),
    loadPeakHours(pool, scope),
    loadDevices(pool, scope),
    topAssetsQuery,
    assetCountQuery,
  ]);

  summary.peakHour = peakHourOf(peakHours);

  const topAssets = topRows.map((x) => {
    const views = n(x.views);
    const avgWatchPercent = pct(x.avg_watch);
    const completionRate = pct(x.completion);
    return {
      assetId: String(x.asset_id),
      title: String(x.title ?? 'Unknown'),
      views,
      uniqueViewers: n(x.unique_viewers),
      watchTimeSec: n(x.watch_time_sec),
      avgWatchPercent,
      completionRate,
      engagementScore: engagementScore(avgWatchPercent, completionRate, views, n(x.error_sessions)),
    };
  });

  return {
    period,
    granularity: series.granularity,
    summary: { ...summary, totalAssets: n(countRows[0]?.cnt) },
    timeSeries: series.points,
    topAssets,
    peakHours,
    devices,
  };
}
