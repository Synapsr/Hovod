import { Worker } from 'bullmq';
import { nanoid } from 'nanoid';
import { createDb } from '@hovod/db';
import { env } from './env.js';

const { db, pool } = createDb(env.DATABASE_URL);

/** Helper: execute raw SQL and return rows as any[] */
async function query(sqlStr: string, params: unknown[] = []): Promise<any[]> {
  const [rows] = await pool.query(sqlStr, params);
  return rows as any[];
}

/* ─── Hourly Aggregation ──────────────────────────────────── */

async function aggregateHourly() {
  const now = new Date();
  // Process events from the last 2 hours to cover the current incomplete hour
  const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000);
  const fromTs = twoHoursAgo.toISOString().slice(0, 19).replace('T', ' ');
  const toTs = now.toISOString().slice(0, 19).replace('T', ' ');

  // Group by asset, actual UTC date, and actual UTC hour of the event
  const rows = await query(
    `SELECT
      asset_id,
      DATE_FORMAT(created_at, '%Y-%m-%d') as event_date,
      HOUR(created_at) as event_hour,
      COUNT(CASE WHEN event_type = 'view_start' THEN 1 END) as view_count,
      COUNT(DISTINCT session_id) as unique_sessions,
      COUNT(CASE WHEN event_type = 'heartbeat' THEN 1 END) * 10 as watch_time_sec,
      COUNT(CASE WHEN event_type = 'buffer_end' THEN 1 END) as buffer_count,
      COALESCE(SUM(CASE WHEN event_type = 'buffer_end' THEN buffer_duration_ms ELSE 0 END), 0) as total_buffer_ms,
      COUNT(CASE WHEN event_type = 'error' THEN 1 END) as error_count
    FROM analytics_events
    WHERE created_at >= ? AND created_at < ?
    GROUP BY asset_id, DATE_FORMAT(created_at, '%Y-%m-%d'), HOUR(created_at)`,
    [fromTs, toTs],
  );

  for (const row of rows) {
    try {
      const dateStr = String(row.event_date);
      const hour = Number(row.event_hour);

      const qualityRows = await query(
        `SELECT quality_height, COUNT(*) as cnt
         FROM analytics_events
         WHERE asset_id = ? AND DATE_FORMAT(created_at, '%Y-%m-%d') = ? AND HOUR(created_at) = ?
           AND quality_height IS NOT NULL AND event_type IN ('heartbeat', 'quality_change')
         GROUP BY quality_height`,
        [row.asset_id, dateStr, hour],
      );
      const qualityDist: Record<string, number> = {};
      for (const qr of qualityRows) {
        qualityDist[String(qr.quality_height)] = Number(qr.cnt);
      }

      const deviceRows = await query(
        `SELECT device_type, COUNT(DISTINCT session_id) as cnt
         FROM analytics_events
         WHERE asset_id = ? AND DATE_FORMAT(created_at, '%Y-%m-%d') = ? AND HOUR(created_at) = ?
           AND device_type IS NOT NULL
         GROUP BY device_type`,
        [row.asset_id, dateStr, hour],
      );
      const deviceDist: Record<string, number> = {};
      for (const dr of deviceRows) {
        deviceDist[dr.device_type] = Number(dr.cnt);
      }

      await query(
        `INSERT INTO analytics_daily (id, asset_id, date, hour, view_count, unique_sessions, total_watch_time_sec, quality_distribution, device_distribution, buffer_count, total_buffer_ms, error_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           view_count = VALUES(view_count),
           unique_sessions = VALUES(unique_sessions),
           total_watch_time_sec = VALUES(total_watch_time_sec),
           quality_distribution = VALUES(quality_distribution),
           device_distribution = VALUES(device_distribution),
           buffer_count = VALUES(buffer_count),
           total_buffer_ms = VALUES(total_buffer_ms),
           error_count = VALUES(error_count)`,
        [
          nanoid(16), row.asset_id, dateStr, hour,
          Number(row.view_count), Number(row.unique_sessions), Number(row.watch_time_sec),
          JSON.stringify(qualityDist), JSON.stringify(deviceDist),
          Number(row.buffer_count), Number(row.total_buffer_ms), Number(row.error_count),
        ],
      );
    } catch (err) {
      console.error(`[analytics] Hourly aggregation failed for asset ${row.asset_id}:`, err);
    }
  }

  console.log(`[analytics] Hourly aggregation done: ${rows.length} buckets processed`);
}

/* ─── Daily Aggregation ──────────────────────────────────── */

async function aggregateDaily() {
  const assetRows = await query(`SELECT DISTINCT asset_id FROM analytics_daily`);

  for (const { asset_id: assetId } of assetRows) {
    try {
      const totalsRows = await query(
        `SELECT
          COALESCE(SUM(view_count), 0) as total_views,
          COALESCE(SUM(unique_sessions), 0) as total_unique_sessions,
          COALESCE(SUM(total_watch_time_sec), 0) as total_watch_time_sec,
          COALESCE(SUM(buffer_count), 0) as total_buffer_count,
          COALESCE(SUM(error_count), 0) as total_error_count
        FROM analytics_daily WHERE asset_id = ?`,
        [assetId],
      );
      const totals = totalsRows[0];

      const watchRows = await query(
        `SELECT AVG(watch_fraction) * 100 as avg_watch_pct FROM (
          SELECT session_id, MAX(current_time) / NULLIF(MAX(duration), 0) as watch_fraction
          FROM analytics_events
          WHERE asset_id = ? AND event_type IN ('heartbeat', 'view_end') AND duration > 0
          GROUP BY session_id
        ) sub`,
        [assetId],
      );
      const avgWatchPct = Number(watchRows[0]?.avg_watch_pct ?? 0);

      const retentionCurve = await computeRetentionCurve(assetId);

      const peakRows = await query(
        `SELECT hour, SUM(view_count) as total
         FROM analytics_daily
         WHERE asset_id = ? AND hour IS NOT NULL
         GROUP BY hour ORDER BY total DESC LIMIT 1`,
        [assetId],
      );
      const peakHour = peakRows[0]?.hour ?? null;

      const qualityRows = await query(
        `SELECT quality_height, COUNT(*) as cnt
         FROM analytics_events
         WHERE asset_id = ? AND quality_height IS NOT NULL AND event_type IN ('heartbeat', 'quality_change')
         GROUP BY quality_height`,
        [assetId],
      );
      const qualityDist: Record<string, number> = {};
      for (const qr of qualityRows) {
        qualityDist[String(qr.quality_height)] = Number(qr.cnt);
      }

      const totalViews = Number(totals.total_views);
      const bufferRatio = totalViews > 0 ? Number(totals.total_buffer_count) / totalViews : 0;
      const errorRate = totalViews > 0 ? Number(totals.total_error_count) / totalViews : 0;
      const engagementScore = computeEngagementScore(avgWatchPct, bufferRatio, errorRate);

      await query(
        `INSERT INTO analytics_asset_stats (asset_id, total_views, total_unique_sessions, total_watch_time_sec, avg_watch_percent, engagement_score, retention_curve, peak_hour, quality_distribution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           total_views = VALUES(total_views),
           total_unique_sessions = VALUES(total_unique_sessions),
           total_watch_time_sec = VALUES(total_watch_time_sec),
           avg_watch_percent = VALUES(avg_watch_percent),
           engagement_score = VALUES(engagement_score),
           retention_curve = VALUES(retention_curve),
           peak_hour = VALUES(peak_hour),
           quality_distribution = VALUES(quality_distribution)`,
        [
          assetId, Number(totals.total_views), Number(totals.total_unique_sessions),
          Number(totals.total_watch_time_sec), Math.round(avgWatchPct), engagementScore,
          JSON.stringify(retentionCurve), peakHour, JSON.stringify(qualityDist),
        ],
      );
    } catch (err) {
      console.error(`[analytics] Daily aggregation failed for asset ${assetId}:`, err);
    }
  }

  console.log(`[analytics] Daily aggregation done: ${assetRows.length} assets processed`);
}

async function computeRetentionCurve(assetId: string): Promise<number[]> {
  const sessions = await query(
    `SELECT session_id, MAX(current_time) as max_time, MAX(duration) as duration
     FROM analytics_events
     WHERE asset_id = ? AND event_type IN ('heartbeat', 'view_end') AND duration > 0
     GROUP BY session_id`,
    [assetId],
  );

  if (sessions.length === 0) return [];

  const curve: number[] = [];
  for (let decile = 1; decile <= 10; decile++) {
    const threshold = decile / 10;
    const reached = sessions.filter(
      (s: any) => s.duration > 0 && Number(s.max_time) / Number(s.duration) >= threshold,
    ).length;
    curve.push(Math.round((reached / sessions.length) * 100));
  }
  return curve;
}

function computeEngagementScore(
  avgWatchPercent: number,
  bufferRatio: number,
  errorRate: number,
): number {
  const watchScore = Math.min(100, Math.max(0, avgWatchPercent));
  const bufferScore = Math.max(0, 100 - bufferRatio * 1000);
  const errorScore = Math.max(0, 100 - errorRate * 500);
  const score = Math.round(watchScore * 0.6 + bufferScore * 0.25 + errorScore * 0.15);
  return Math.max(0, Math.min(100, score));
}

/* ─── Cleanup ─────────────────────────────────────────────── */

async function cleanupOldEvents(retentionDays: number) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const cutoffStr = cutoff.toISOString().slice(0, 19).replace('T', ' ');

  await query(`DELETE FROM analytics_events WHERE created_at < ? LIMIT 10000`, [cutoffStr]);

  console.log(`[analytics] Cleanup: removed events older than ${retentionDays} days`);
}

/* ─── Worker ──────────────────────────────────────────────── */

export function createAnalyticsWorker(redisUrl: string) {
  const worker = new Worker(
    'analytics-aggregation',
    async (job) => {
      const { type, retentionDays } = job.data as {
        type: 'hourly' | 'daily' | 'cleanup';
        retentionDays?: number;
      };

      console.log(`[analytics] Processing job: ${type}`);

      switch (type) {
        case 'hourly':
          await aggregateHourly();
          break;
        case 'daily':
          await aggregateDaily();
          break;
        case 'cleanup':
          await cleanupOldEvents(retentionDays ?? 30);
          break;
      }
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
