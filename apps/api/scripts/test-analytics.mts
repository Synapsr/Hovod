/**
 * Analytics integration test (plain node + tsx, no framework). Run from apps/api after
 * `npm run build -w @hovod/db`:
 *
 *   npm test                                     # starts a throwaway mysql:8.4 container
 *   HOVOD_ANALYTICS_TEST_IMAGE=mariadb:10.11 npm test
 *   HOVOD_ANALYTICS_TEST_URL=mysql://root:root@127.0.0.1:3306 npm test   # reuse a server
 *
 *  [A] legacy import: baseline tables + fake analytics_events → migration 0002
 *      produces the expected playback_sessions and drops the old tables.
 *  [B] ingestion: synthetic batches (view_start + heartbeats + view_end for two
 *      sessions, plus owner / unknown / NaN / not-ready edge cases) → asserts
 *      the computed analytics (views, watch time, retention, engagement…).
 *
 * Env overrides: HOVOD_ANALYTICS_TEST_PORT (default 33308), HOVOD_ANALYTICS_TEST_CONTAINER
 * (default hovod-analytics-test), HOVOD_ANALYTICS_TEST_IMAGE (default mysql:8.4).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

const PORT = Number(process.env.HOVOD_ANALYTICS_TEST_PORT ?? 33308);
const CONTAINER = process.env.HOVOD_ANALYTICS_TEST_CONTAINER ?? 'hovod-analytics-test';
const IMAGE = process.env.HOVOD_ANALYTICS_TEST_IMAGE ?? 'mysql:8.4';
const EXTERNAL = process.env.HOVOD_ANALYTICS_TEST_URL; // e.g. mysql://root:root@127.0.0.1:3306
const serverUrl = EXTERNAL ?? `mysql://root:root@127.0.0.1:${PORT}`;
const rootUrl = `${serverUrl}/mysql`;
const dbUrl = (db: string) => `${serverUrl}/${db}`;

// The API module tree reads env at import time — dummy values, the pool is passed explicitly.
process.env.DATABASE_URL = dbUrl('hovod_wpa_ingest');
process.env.S3_ENDPOINT = 'http://127.0.0.1:9000';
process.env.S3_REGION = 'us-east-1';
process.env.S3_BUCKET = 'hovod-vod';
process.env.S3_ACCESS_KEY_ID = 'minioadmin';
process.env.S3_SECRET_ACCESS_KEY = 'minioadmin';
process.env.S3_PUBLIC_BASE_URL = 'http://127.0.0.1:9000/hovod-vod';
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.REDIS_URL = 'redis://127.0.0.1:6399';

const dbPkg = await import('@hovod/db');
const { runMigrations, parseMigrationSql, MIGRATIONS_DIR, createDb } = dbPkg;
const svc = await import('../src/services/analytics.js');

let passed = 0;
function ok(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (err) {
    console.log(`  FAIL ${label}\n       ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

async function waitForMysql() {
  let lastErr: unknown;
  for (let i = 0; i < 90; i++) {
    try {
      const c = await mysql.createConnection(rootUrl);
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`MySQL not ready: ${(lastErr as Error)?.message}`);
}

if (!EXTERNAL) {
  if (sh('docker', ['version', '--format', '{{.Server.Version}}']).code !== 0) {
    console.log('docker CLI unavailable and HOVOD_ANALYTICS_TEST_URL not set — nothing to test against');
    process.exit(0);
  }
  sh('docker', ['rm', '-f', CONTAINER]);
  const run = sh('docker', [
    'run', '-d', '--name', CONTAINER, '-p', `${PORT}:3306`,
    '-e', 'MYSQL_ROOT_PASSWORD=root', '-e', 'MARIADB_ROOT_PASSWORD=root', IMAGE,
  ]);
  if (run.code !== 0) throw new Error(`docker run failed: ${run.out}`);
  process.on('exit', () => {
    const rm = sh('docker', ['rm', '-f', CONTAINER]);
    console.log(`\n  removed container ${CONTAINER}${rm.code === 0 ? '' : ` (docker rm failed: ${rm.out})`}`);
  });
}
console.log(`\nAnalytics checks (${EXTERNAL ? serverUrl : `${IMAGE} on :${PORT}`})`);

const quiet = { info() {}, warn() {} };

async function tables(pool: mysql.Pool): Promise<string[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME',
  );
  return rows.map((r) => String(r.t));
}

await waitForMysql();
const admin = await mysql.createConnection(rootUrl);
for (const db of ['hovod_wpa_legacy', 'hovod_wpa_ingest']) {
  await admin.query(`DROP DATABASE IF EXISTS \`${db}\``);
  await admin.query(`CREATE DATABASE \`${db}\``);
}
await admin.end();

/* ─── [A] legacy import ─────────────────────────────────── */
console.log('\n[A] legacy analytics_events import');
{
  const { pool } = createDb(dbUrl('hovod_wpa_legacy'), { connectionLimit: 3 });
  // Apply the baseline only and record it, so the runner only has 0002 left to apply.
  const baseline = parseMigrationSql(await readFile(path.join(MIGRATIONS_DIR, '0001_baseline.sql'), 'utf8'));
  for (const s of baseline) await pool.query(s);
  await pool.query('CREATE TABLE schema_migrations (name VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  await pool.query("INSERT INTO schema_migrations (name) VALUES ('0001_baseline.sql')");

  await pool.query("INSERT INTO assets (id, org_id, status, title, playback_id) VALUES ('asset1', 'org1', 'ready', 'One', 'pb1'), ('asset2', 'org1', 'ready', 'Two', 'pb2')");

  const base = new Date(Date.UTC(2026, 7, 1, 12, 0, 0));
  const at = (sec: number) => new Date(base.getTime() + sec * 1000);
  let n = 0;
  const ev = (session: string, asset: string, type: string, extra: Record<string, unknown> = {}, sec = 0) => {
    n++;
    const cols: Record<string, unknown> = {
      id: `e${n}`, session_id: session, asset_id: asset, playback_id: asset === 'asset1' ? 'pb1' : 'pb2', event_type: type,
      created_at: at(sec), device_type: 'desktop', country: 'FR', user_agent: 'UA', referrer: 'https://ref.example/page', player_type: 'embed',
      ...extra,
    };
    const keys = Object.keys(cols);
    return pool.query(`INSERT INTO analytics_events (${keys.map((k) => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => cols[k]));
  };
  // Session A: 3 heartbeats, pause, seek, buffer, not completed
  await ev('sessA', 'asset1', 'view_start', { current_time: 0, duration: 100, quality_height: 720 }, 0);
  await ev('sessA', 'asset1', 'heartbeat', { current_time: 10, duration: 100, quality_height: 720 }, 10);
  await ev('sessA', 'asset1', 'heartbeat', { current_time: 20, duration: 100, quality_height: 1080 }, 20);
  await ev('sessA', 'asset1', 'heartbeat', { current_time: 30, duration: 100 }, 30);
  await ev('sessA', 'asset1', 'pause', { current_time: 30, duration: 100 }, 31);
  await ev('sessA', 'asset1', 'seek', { current_time: 35, duration: 100 }, 32);
  await ev('sessA', 'asset1', 'buffer_end', { current_time: 35, duration: 100, buffer_duration_ms: 500 }, 33);
  await ev('sessA', 'asset1', 'error', { current_time: 36, duration: 100, error_message: 'boom' }, 34);
  await ev('sessA', 'asset1', 'view_end', { current_time: 36, duration: 100 }, 35);
  // Session B: 10 heartbeats, completed
  await ev('sessB', 'asset2', 'view_start', { current_time: 0, duration: 100 }, 0);
  for (let i = 1; i <= 10; i++) await ev('sessB', 'asset2', 'heartbeat', { current_time: Math.min(95, i * 10), duration: 100, quality_height: 360 }, i * 10);
  // Server-side session: must be dropped
  await ev('srv-abc', 'asset1', 'view_start', { current_time: 0, duration: 100 }, 0);
  // Session for an asset that no longer exists: dropped by the inner join
  await ev('sessGhost', 'nope', 'view_start', { current_time: 0, duration: 100 }, 0);

  const res = await runMigrations(pool, { logger: quiet });
  ok('0002 applied on top of the baseline', () => assert.deepEqual(res.applied, ['0002_playback_sessions.sql']));
  const t = await tables(pool);
  ok('legacy tables dropped', () => {
    for (const x of ['analytics_events', 'analytics_daily', 'analytics_asset_stats']) assert.ok(!t.includes(x), x);
  });
  ok('playback_sessions created', () => assert.ok(t.includes('playback_sessions')));

  const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM playback_sessions ORDER BY id');
  ok('two sessions imported (srv-* and orphan dropped)', () => assert.deepEqual(rows.map((r) => r.id), ['sessA', 'sessB']));
  const a = rows[0]; const b = rows[1];
  ok('session A aggregates', () => {
    assert.equal(a.asset_id, 'asset1');
    assert.equal(a.org_id, 'org1');
    assert.equal(a.playback_id, 'pb1');
    assert.equal(Number(a.watched_sec), 30);
    assert.equal(Number(a.max_position_sec), 36);
    assert.equal(Number(a.duration_sec), 100);
    assert.equal(Number(a.quality_height), 1080);
    assert.equal(Number(a.pause_count), 1);
    assert.equal(Number(a.seek_count), 1);
    assert.equal(Number(a.buffer_count), 1);
    assert.equal(Number(a.buffer_ms), 500);
    assert.equal(Number(a.error_count), 1);
    assert.equal(a.last_error, 'boom');
    assert.equal(Number(a.completed), 0);
    assert.equal(a.device_type, 'desktop');
    assert.equal(a.country, 'FR');
    assert.equal(a.referrer, 'https://ref.example/page');
    assert.equal(new Date(a.started_at).toISOString(), at(0).toISOString());
    assert.equal(new Date(a.last_seen_at).toISOString(), at(35).toISOString());
  });
  ok('session B aggregates (completed)', () => {
    assert.equal(b.asset_id, 'asset2');
    assert.equal(Number(b.watched_sec), 100);
    assert.equal(Number(b.max_position_sec), 95);
    assert.equal(Number(b.completed), 1);
    assert.equal(Number(b.quality_height), 360);
  });

  // The imported history is readable through the read model
  const now = new Date(Date.UTC(2026, 7, 3, 0, 0, 0));
  const stats = await svc.getAssetAnalytics('asset1', '7d', pool, now);
  ok('imported session A reads back (views=1, watch=30s, avg 36%)', () => {
    assert.equal(stats.summary.views, 1);
    assert.equal(stats.summary.watchTimeSec, 30);
    assert.equal(stats.summary.avgWatchPercent, 36);
    assert.equal(stats.summary.errorCount, 1);
    assert.deepEqual(stats.retentionCurve, [100, 100, 100, 0, 0, 0, 0, 0, 0, 0]);
  });
  const over = await svc.getOverviewAnalytics('org1', '30d', pool, now);
  ok('overview after import: 2 views, top asset is the completed one', () => {
    assert.equal(over.summary.views, 2);
    assert.equal(over.summary.completionRate, 50);
    assert.equal(over.topAssets.length, 2);
    assert.equal(over.topAssets[0].views, 1);
  });
  await pool.end();
}

/* ─── [B] ingestion ─────────────────────────────────────── */
console.log('\n[B] ingestion → read model');
{
  const { pool } = createDb(dbUrl('hovod_wpa_ingest'), { connectionLimit: 4 });
  const res = await runMigrations(pool, { logger: quiet });
  ok('fresh install applies both migrations', () => assert.deepEqual(res.applied, ['0001_baseline.sql', '0002_playback_sessions.sql']));
  const t = await tables(pool);
  ok('fresh install has playback_sessions and no legacy tables', () => {
    assert.ok(t.includes('playback_sessions'));
    assert.ok(!t.includes('analytics_events'));
  });

  await pool.query("INSERT INTO assets (id, org_id, status, title, playback_id) VALUES ('assetR', 'orgX', 'ready', 'Ready', 'pbReady'), ('assetP', 'orgX', 'processing', 'Pending', 'pbPending'), ('assetD', 'orgX', 'deleted', 'Gone', 'pbGone')");
  await pool.query("INSERT INTO playback_sessions (id, asset_id, org_id, playback_id, started_at, last_seen_at, watched_sec, max_position_sec) VALUES ('oldSession0001', 'assetD', 'orgX', 'pbGone', '2020-01-01 00:00:00', '2020-01-01 00:00:00', 50, 50)");

  const now = new Date(Date.UTC(2026, 8, 4, 10, 30, 0));
  const ctx = { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120', acceptLanguage: 'fr-FR,fr;q=0.9', now };
  const E = (sessionId: string, viewerId: string, type: string, extra: Record<string, unknown> = {}) => ({
    sessionId, viewerId, playbackId: 'pbReady', type, playerType: 'embed', referrer: 'https://example.com/blog/post', ...extra,
  }) as unknown as import('../src/services/analytics.js').IngestEvent;

  // Session 1: view_start immediately, then heartbeats
  const r1 = await svc.ingestEvents([E('sessionAAAAAAAA', 'viewerAAAAAAAA', 'view_start', { currentTime: 2, duration: 100, qualityHeight: 720 })], ctx, pool);
  ok('view_start accepted', () => assert.deepEqual(r1, { accepted: 1, rejected: 0 }));

  const batch1 = [
    E('sessionAAAAAAAA', 'viewerAAAAAAAA', 'heartbeat', { currentTime: 12, duration: 100, watchedMs: 10_000, qualityHeight: 720 }),
    E('sessionAAAAAAAA', 'viewerAAAAAAAA', 'heartbeat', { currentTime: 22, duration: 100, watchedMs: 10_000, qualityHeight: 720 }),
    E('sessionAAAAAAAA', 'viewerAAAAAAAA', 'heartbeat', { currentTime: 32, duration: 100, watchedMs: 10_000, qualityHeight: 720 }),
    E('sessionAAAAAAAA', 'viewerAAAAAAAA', 'pause', { currentTime: 32, duration: 100 }),
    E('sessionAAAAAAAA', 'viewerAAAAAAAA', 'seek', { currentTime: 40, duration: 100 }),
    E('sessionAAAAAAAA', 'viewerAAAAAAAA', 'buffer_start', { currentTime: 40, duration: 100 }),
    E('sessionAAAAAAAA', 'viewerAAAAAAAA', 'buffer_end', { currentTime: 40, duration: 100, bufferMs: 1900 }),
    E('sessionAAAAAAAA', 'viewerAAAAAAAA', 'view_end', { currentTime: 40, duration: 100, watchedMs: 8_000 }),
    // Session 2 in the same batch, completed
    E('sessionBBBBBBBB', 'viewerBBBBBBBB', 'view_start', { currentTime: 1.5, duration: 100, qualityHeight: 1080 }),
    ...Array.from({ length: 9 }, (_, i) => E('sessionBBBBBBBB', 'viewerBBBBBBBB', 'heartbeat', { currentTime: 2 + (i + 1) * 10, duration: 100, watchedMs: 10_000, qualityHeight: 1080 })),
    E('sessionBBBBBBBB', 'viewerBBBBBBBB', 'view_end', { currentTime: 100, duration: 100, watchedMs: 8_000 }),
    // Edge cases
    E('sessionOWNERXXX', 'viewerOWNERXXX', 'view_start', { currentTime: 5, duration: 100, owner: true }),
    E('sessionUNKNOWNX', 'viewerUNKNOWNX', 'view_start', { currentTime: 5, duration: 100, playbackId: 'nope' }),
    E('sessionPENDINGX', 'viewerPENDINGX', 'view_start', { currentTime: 5, duration: 100, playbackId: 'pbPending' }),
    E('sessionNANXXXXX', 'viewerNANXXXXX', 'view_start', { currentTime: Number.NaN, duration: Number.POSITIVE_INFINITY, watchedMs: Number.NaN }),
    E('sessionNANXXXXX', 'viewerNANXXXXX', 'heartbeat', { currentTime: 3, duration: Number.NaN, watchedMs: 5_000_000 }),
  ];
  const r2 = await svc.ingestEvents(batch1, ctx, pool);
  ok('batch: owner accepted-but-dropped, unknown + not-ready rejected', () => assert.deepEqual(r2, { accepted: batch1.length - 2, rejected: 2 }));

  const [sessions] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM playback_sessions WHERE org_id = 'orgX' AND id <> 'oldSession0001' ORDER BY id");
  ok('three sessions stored (owner never stored)', () => assert.deepEqual(sessions.map((s) => s.id), ['sessionAAAAAAAA', 'sessionBBBBBBBB', 'sessionNANXXXXX']));
  const sA = sessions[0]; const sB = sessions[1]; const sN = sessions[2];
  ok('session A folded into one row', () => {
    assert.equal(Number(sA.watched_sec), 38);
    assert.equal(Number(sA.max_position_sec), 40);
    assert.equal(Number(sA.duration_sec), 100);
    assert.equal(Number(sA.pause_count), 1);
    assert.equal(Number(sA.seek_count), 1);
    assert.equal(Number(sA.buffer_count), 1);
    assert.equal(Number(sA.buffer_ms), 1900);
    assert.equal(Number(sA.completed), 0);
    assert.equal(sA.viewer_id, 'viewerAAAAAAAA');
    assert.equal(sA.device_type, 'desktop');
    assert.equal(sA.country, 'FR');
    assert.equal(sA.player_type, 'embed');
    assert.equal(sA.asset_id, 'assetR');
    assert.equal(sA.org_id, 'orgX');
    assert.equal(new Date(sA.started_at).toISOString(), now.toISOString());
  });
  ok('session B completed', () => {
    assert.equal(Number(sB.watched_sec), 98);
    assert.equal(Number(sB.max_position_sec), 100);
    assert.equal(Number(sB.completed), 1);
    assert.equal(Number(sB.quality_height), 1080);
  });
  ok('NaN / Infinity coerced, watchedMs clamped to 60 s', () => {
    assert.equal(Number(sN.max_position_sec), 3);
    assert.equal(Number(sN.watched_sec), 60);
    assert.equal(sN.duration_sec, null);
  });

  // A later batch keeps folding into session A (reload / mobile tail via sendBeacon)
  const later = new Date(now.getTime() + 60_000);
  await svc.ingestEvents([E('sessionAAAAAAAA', 'viewerAAAAAAAA', 'heartbeat', { currentTime: 45, duration: 100, watchedMs: 5_000 })], { ...ctx, now: later }, pool);
  const [[sA2]] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM playback_sessions WHERE id = 'sessionAAAAAAAA'");
  ok('second batch upserts the same session (watched 43 s, last_seen moved, started_at kept)', () => {
    assert.equal(Number(sA2.watched_sec), 43);
    assert.equal(Number(sA2.max_position_sec), 45);
    assert.equal(new Date(sA2.started_at).toISOString(), now.toISOString());
    assert.equal(new Date(sA2.last_seen_at).toISOString(), later.toISOString());
  });

  const readNow = new Date(later.getTime() + 60_000);
  const stats = await svc.getAssetAnalytics('assetR', '7d', pool, readNow);
  ok('asset analytics: numbers', () => {
    // sessionNAN has watched 60 s so it counts as a view → 3 views; it has no duration so it is
    // excluded from avg/retention.
    assert.equal(stats.summary.views, 3);
    assert.equal(stats.summary.uniqueViewers, 3);
    assert.equal(stats.summary.watchTimeSec, 43 + 98 + 60);
    assert.equal(stats.summary.avgWatchPercent, 72.5); // (0.45 + 1) / 2
    assert.equal(stats.summary.completionRate, 33.3); // 1 of 3 views
    assert.equal(stats.summary.errorCount, 0);
    assert.equal(stats.summary.bufferCount, 1);
    assert.equal(stats.summary.bufferRatio, Math.round((1.9 / 201) * 1000) / 10);
    // 0.6×72.5 + 0.3×33.3 + 0.1×100 = 43.5 + 9.99 + 10 = 63.49 → 63
    assert.equal(stats.summary.engagementScore, 63);
    assert.equal(stats.summary.peakHour, 10);
    assert.deepEqual(stats.retentionCurve, [100, 100, 100, 100, 50, 50, 50, 50, 50, 50]);
    assert.deepEqual(stats.devices, { desktop: 3 });
    assert.deepEqual(stats.qualityDistribution, { '720': 1, '1080': 1 });
    assert.deepEqual(stats.topReferrers, [{ referrer: 'example.com', views: 3 }]);
    assert.equal(stats.granularity, 'hour');
    assert.equal(stats.period, '7d');
  });
  ok('7d time series: hourly buckets, filled, all views in the 10:00Z bucket', () => {
    assert.ok(stats.timeSeries.length >= 168 && stats.timeSeries.length <= 170, String(stats.timeSeries.length));
    const hit = stats.timeSeries.filter((p) => p.views > 0);
    assert.deepEqual(hit, [{ date: '2026-09-04T10:00:00Z', views: 3, uniqueViewers: 3, watchTimeSec: 201 }]);
    assert.equal(stats.peakHours.length, 24);
    assert.equal(stats.peakHours.reduce((s, p) => s + p.views, 0), 3);
  });
  const stats30 = await svc.getAssetAnalytics('assetR', '30d', pool, readNow);
  ok('30d time series: daily buckets (31 points), same totals', () => {
    assert.equal(stats30.granularity, 'day');
    assert.equal(stats30.timeSeries.length, 31);
    assert.equal(stats30.summary.views, 3);
    assert.deepEqual(stats30.timeSeries.filter((p) => p.views > 0).map((p) => p.date), ['2026-09-04']);
  });
  const statsAll = await svc.getAssetAnalytics('assetR', 'all', pool, readNow);
  ok('all-time: same totals, series starts at the first session', () => {
    assert.equal(statsAll.summary.views, 3);
    assert.equal(statsAll.timeSeries[0].date, '2026-09-04');
  });
  const stats90 = await svc.getAssetAnalytics('assetD', '90d', pool, readNow);
  ok('a 2020 session is outside 90d but inside all', () => {
    assert.equal(stats90.summary.views, 0);
    assert.deepEqual(stats90.retentionCurve, []);
  });
  const statsDAll = await svc.getAssetAnalytics('assetD', 'all', pool, readNow);
  ok('all-time on the deleted asset counts the 2020 session', () => assert.equal(statsDAll.summary.views, 1));

  const over = await svc.getOverviewAnalytics('orgX', '7d', pool, readNow);
  ok('overview: org totals + top assets exclude deleted, totalAssets excludes deleted', () => {
    assert.equal(over.summary.views, 3);
    assert.equal(over.summary.uniqueViewers, 3);
    assert.equal(over.summary.watchTimeSec, 201);
    assert.equal(over.summary.totalAssets, 2);
    assert.equal(over.summary.engagementScore, 63);
    assert.deepEqual(over.topAssets.map((a) => a.assetId), ['assetR']);
    assert.equal(over.topAssets[0].views, 3);
    assert.equal(over.topAssets[0].engagementScore, 63);
    assert.equal(over.granularity, 'hour');
  });
  const overAll = await svc.getOverviewAnalytics('orgX', 'all', pool, readNow);
  ok('overview all-time: deleted asset sessions count in totals but not in top assets', () => {
    assert.equal(overAll.summary.views, 4);
    assert.deepEqual(overAll.topAssets.map((a) => a.assetId), ['assetR']);
    assert.equal(overAll.granularity, 'day');
  });
  const overOther = await svc.getOverviewAnalytics('orgOther', 'all', pool, readNow);
  ok('overview is org-scoped', () => assert.equal(overOther.summary.views, 0));

  // Cache: a playback that becomes ready is picked up after the TTL
  const miss = await svc.resolvePlayback('pbPending', pool, readNow.getTime());
  await pool.query("UPDATE assets SET status = 'ready' WHERE id = 'assetP'");
  const stillMiss = await svc.resolvePlayback('pbPending', pool, readNow.getTime() + 1000);
  const hit = await svc.resolvePlayback('pbPending', pool, readNow.getTime() + 61_000);
  ok('playback cache: 60 s TTL for misses too', () => {
    assert.equal(miss, null);
    assert.equal(stillMiss, null);
    assert.deepEqual(hit, { assetId: 'assetP', orgId: 'orgX' });
  });

  // Cascade delete
  await pool.query("DELETE FROM assets WHERE id = 'assetD'");
  const [[cnt]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS c FROM playback_sessions WHERE asset_id = 'assetD'");
  ok('sessions cascade with the asset', () => assert.equal(Number(cnt.c), 0));

  // Retention cleanup (same DELETE loop as the worker)
  await pool.query("INSERT INTO playback_sessions (id, asset_id, org_id, playback_id, started_at, last_seen_at) VALUES ('ancientSession01', 'assetR', 'orgX', 'pbReady', '2019-01-01 00:00:00', '2019-01-01 00:00:00')");
  const cutoff = new Date(readNow.getTime() - 400 * 86_400_000);
  const [del] = await pool.query<mysql.ResultSetHeader>('DELETE FROM playback_sessions WHERE started_at < ? LIMIT ?', [cutoff, 10_000]);
  const [[left]] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM playback_sessions');
  ok('retention delete removes only sessions older than 400 days', () => {
    assert.equal(del.affectedRows, 1);
    assert.equal(Number(left.c), 3);
  });

  // UTC pinning: the session started_at written via a JS Date reads back identical
  const [[tz]] = await pool.query<mysql.RowDataPacket[]>('SELECT @@session.time_zone AS tz');
  ok("pool session time_zone is '+00:00'", () => assert.equal(tz.tz, '+00:00'));

  await pool.end();
}

const cleanup = await mysql.createConnection(rootUrl);
for (const db of ['hovod_wpa_legacy', 'hovod_wpa_ingest']) await cleanup.query(`DROP DATABASE IF EXISTS \`${db}\``);
await cleanup.end();

console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}`);
