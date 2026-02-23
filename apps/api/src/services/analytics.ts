import { eq, sql, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { FastifyRequest } from 'fastify';
import {
  analyticsEvents,
  analyticsAssetStats,
  assets,
  ANALYTICS_EVENT,
  ID_LENGTH,
} from '@hovod/db';
import { db, pool } from '../db.js';

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

function periodToDays(period: string): number | null {
  if (period === '7d') return 7;
  if (period === '30d') return 30;
  if (period === '90d') return 90;
  return null; // 'all'
}

function dateMinusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Raw SQL helper (mysql2 pool) */
async function rawQuery(sqlStr: string, params: unknown[] = []): Promise<any[]> {
  const [rows] = await pool.query(sqlStr, params);
  return rows as any[];
}

/* ─── Event Ingestion ──────────────────────────────────────── */

interface EventPayload {
  sessionId: string;
  assetId: string;
  playbackId: string;
  eventType: string;
  currentTime?: number;
  duration?: number;
  qualityHeight?: number;
  bufferDurationMs?: number;
  errorMessage?: string;
  playerType?: string;
  referrer?: string;
}

export async function insertAnalyticsEvents(
  events: EventPayload[],
  userAgent: string,
  acceptLanguage: string,
): Promise<number> {
  const deviceType = parseDeviceType(userAgent);
  const country = parseCountryHint(acceptLanguage);

  const rows = events.map((e) => ({
    id: nanoid(ID_LENGTH.ANALYTICS_EVENT),
    sessionId: e.sessionId,
    assetId: e.assetId,
    playbackId: e.playbackId,
    eventType: e.eventType,
    currentTime: e.currentTime ?? null,
    duration: e.duration ?? null,
    qualityHeight: e.qualityHeight ?? null,
    bufferDurationMs: e.bufferDurationMs ?? null,
    errorMessage: e.errorMessage ?? null,
    userAgent: userAgent.slice(0, 512),
    country,
    deviceType,
    referrer: e.referrer ?? null,
    playerType: e.playerType ?? null,
  }));

  await db.insert(analyticsEvents).values(rows);
  return rows.length;
}

/** Fire-and-forget server-side manifest view tracking */
export function insertManifestView(
  assetId: string,
  playbackId: string,
  request: FastifyRequest,
) {
  const ua = (request.headers['user-agent'] as string) || '';
  const lang = (request.headers['accept-language'] as string) || '';
  return db.insert(analyticsEvents).values({
    id: nanoid(ID_LENGTH.ANALYTICS_EVENT),
    sessionId: `srv-${nanoid(12)}`,
    assetId,
    playbackId,
    eventType: ANALYTICS_EVENT.VIEW_START,
    userAgent: ua.slice(0, 512),
    country: parseCountryHint(lang),
    deviceType: parseDeviceType(ua),
    playerType: 'server',
  });
}

/* ─── Per-Asset Analytics (real-time from raw events) ──────── */

export async function getAssetAnalytics(assetId: string, period: string) {
  const days = periodToDays(period);
  const dateCutoff = days ? dateMinusDays(days) : '1970-01-01';

  // Real-time stats from raw events
  const statsRows = await rawQuery(
    `SELECT
      COALESCE(SUM(CASE WHEN event_type = 'view_start' THEN 1 ELSE 0 END), 0) as total_views,
      COUNT(DISTINCT session_id) as total_unique_sessions,
      COALESCE(SUM(CASE WHEN event_type = 'heartbeat' THEN 10 ELSE 0 END), 0) as total_watch_time_sec
    FROM analytics_events
    WHERE asset_id = ? AND created_at >= ?`,
    [assetId, dateCutoff],
  );
  const stats = statsRows[0];

  // Time series from raw events
  const tsRows = await rawQuery(
    `SELECT
      DATE_FORMAT(created_at, '%Y-%m-%d') as date,
      SUM(CASE WHEN event_type = 'view_start' THEN 1 ELSE 0 END) as views,
      SUM(CASE WHEN event_type = 'heartbeat' THEN 10 ELSE 0 END) as watch_time_sec,
      COUNT(DISTINCT session_id) as unique_sessions
    FROM analytics_events
    WHERE asset_id = ? AND created_at >= ?
    GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
    ORDER BY date`,
    [assetId, dateCutoff],
  );

  // Hourly breakdown from raw events
  const hourlyRows = await rawQuery(
    `SELECT
      HOUR(created_at) as hour,
      SUM(CASE WHEN event_type = 'view_start' THEN 1 ELSE 0 END) as views
    FROM analytics_events
    WHERE asset_id = ? AND created_at >= ?
    GROUP BY HOUR(created_at)
    ORDER BY HOUR(created_at)`,
    [assetId, dateCutoff],
  );

  // Pre-computed heavy metrics from aggregation worker (if available)
  const [precomputed] = await db
    .select()
    .from(analyticsAssetStats)
    .where(eq(analyticsAssetStats.assetId, assetId))
    .limit(1);

  return {
    lifetime: {
      totalViews: Number(stats?.total_views ?? 0),
      totalUniqueSessions: Number(stats?.total_unique_sessions ?? 0),
      totalWatchTimeSec: Number(stats?.total_watch_time_sec ?? 0),
      avgWatchPercent: precomputed?.avgWatchPercent ?? 0,
      engagementScore: precomputed?.engagementScore ?? 0,
      peakHour: precomputed?.peakHour ?? null,
      qualityDistribution: precomputed?.qualityDistribution ?? {},
      retentionCurve: precomputed?.retentionCurve ?? [],
    },
    timeSeries: tsRows.map((r: any) => ({
      date: String(r.date),
      views: Number(r.views),
      watchTimeSec: Number(r.watch_time_sec),
      uniqueSessions: Number(r.unique_sessions),
    })),
    hourlyBreakdown: hourlyRows.map((r: any) => ({
      hour: Number(r.hour),
      views: Number(r.views),
    })),
  };
}

/* ─── Global Overview (real-time from raw events) ─────────── */

export async function getOverviewAnalytics(period: string, orgId: string) {
  const days = periodToDays(period) ?? 30;
  const dateCutoff = dateMinusDays(days);

  // Summary from raw events (scoped to org)
  const summaryRows = await rawQuery(
    `SELECT
      COALESCE(SUM(CASE WHEN e.event_type = 'view_start' THEN 1 ELSE 0 END), 0) as total_views,
      COALESCE(SUM(CASE WHEN e.event_type = 'heartbeat' THEN 10 ELSE 0 END), 0) as total_watch_time_sec
    FROM analytics_events e
    INNER JOIN assets a ON a.id = e.asset_id
    WHERE a.org_id = ? AND e.created_at >= ?`,
    [orgId, dateCutoff],
  );
  const summary = summaryRows[0];

  // Asset count (scoped to org)
  const [assetCount] = await db
    .select({ count: sql<number>`COUNT(*)`.as('cnt') })
    .from(assets)
    .where(eq(assets.orgId, orgId));

  // Average engagement from pre-computed stats (scoped to org)
  const allStats = await db
    .select({ engagementScore: analyticsAssetStats.engagementScore })
    .from(analyticsAssetStats)
    .innerJoin(assets, eq(assets.id, analyticsAssetStats.assetId))
    .where(eq(assets.orgId, orgId));
  const avgEngagement =
    allStats.length > 0
      ? Math.round(allStats.reduce((s, r) => s + r.engagementScore, 0) / allStats.length)
      : 0;

  // Time series from raw events (scoped to org)
  const tsRows = await rawQuery(
    `SELECT
      DATE_FORMAT(e.created_at, '%Y-%m-%d') as date,
      SUM(CASE WHEN e.event_type = 'view_start' THEN 1 ELSE 0 END) as views,
      SUM(CASE WHEN e.event_type = 'heartbeat' THEN 10 ELSE 0 END) as watch_time_sec,
      COUNT(DISTINCT e.session_id) as unique_sessions
    FROM analytics_events e
    INNER JOIN assets a ON a.id = e.asset_id
    WHERE a.org_id = ? AND e.created_at >= ?
    GROUP BY DATE_FORMAT(e.created_at, '%Y-%m-%d')
    ORDER BY date`,
    [orgId, dateCutoff],
  );

  // Top assets from raw events (scoped to org)
  const topRows = await rawQuery(
    `SELECT
      e.asset_id,
      SUM(CASE WHEN e.event_type = 'view_start' THEN 1 ELSE 0 END) as views
    FROM analytics_events e
    INNER JOIN assets a ON a.id = e.asset_id
    WHERE a.org_id = ? AND e.created_at >= ?
    GROUP BY e.asset_id
    HAVING views > 0
    ORDER BY views DESC
    LIMIT 10`,
    [orgId, dateCutoff],
  );

  // Enrich top assets with titles and engagement
  const enriched = await Promise.all(
    topRows.map(async (ta: any) => {
      const [asset] = await db
        .select({ title: assets.title })
        .from(assets)
        .where(eq(assets.id, ta.asset_id))
        .limit(1);
      const [statRow] = await db
        .select({ engagementScore: analyticsAssetStats.engagementScore })
        .from(analyticsAssetStats)
        .where(eq(analyticsAssetStats.assetId, ta.asset_id))
        .limit(1);
      return {
        assetId: ta.asset_id,
        title: asset?.title ?? 'Unknown',
        views: Number(ta.views),
        engagementScore: statRow?.engagementScore ?? 0,
      };
    }),
  );

  // Peak hours from raw events (scoped to org)
  const peakRows = await rawQuery(
    `SELECT
      HOUR(e.created_at) as hour,
      SUM(CASE WHEN e.event_type = 'view_start' THEN 1 ELSE 0 END) as views
    FROM analytics_events e
    INNER JOIN assets a ON a.id = e.asset_id
    WHERE a.org_id = ? AND e.created_at >= ?
    GROUP BY HOUR(e.created_at)
    ORDER BY HOUR(e.created_at)`,
    [orgId, dateCutoff],
  );

  return {
    summary: {
      totalViews: Number(summary?.total_views ?? 0),
      totalWatchTimeSec: Number(summary?.total_watch_time_sec ?? 0),
      totalAssets: Number(assetCount?.count ?? 0),
      avgEngagementScore: avgEngagement,
    },
    timeSeries: tsRows.map((r: any) => ({
      date: String(r.date),
      views: Number(r.views),
      watchTimeSec: Number(r.watch_time_sec),
      uniqueSessions: Number(r.unique_sessions),
    })),
    topAssets: enriched,
    peakHours: peakRows.map((r: any) => ({
      hour: Number(r.hour),
      views: Number(r.views),
    })),
  };
}
