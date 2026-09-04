#!/usr/bin/env node
/**
 * 0004_cloud against a real MySQL: fresh install (0001→0004) and the upgrade
 * path from a database whose `organizations.tier` column carries values.
 *
 * Needs a reachable MySQL with rights to create databases:
 *   HOVOD_TEST_DATABASE_URL=mysql://root:root@127.0.0.1:33307/mysql node packages/db/scripts/test-migration-0004.mjs
 * Skips (exit 0) when the variable is unset.
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MIGRATIONS_DIR, runMigrations, listMigrationFiles } = await import(path.join(PKG_ROOT, 'dist', 'index.js'));

const ROOT_URL = process.env.HOVOD_TEST_DATABASE_URL;
if (!ROOT_URL) {
  console.log('HOVOD_TEST_DATABASE_URL not set — skipping 0004 docker checks');
  process.exit(0);
}

const quiet = { info() {}, warn() {} };
const withDb = (name) => ROOT_URL.replace(/\/[^/?]*(\?.*)?$/, `/${name}$1`);

const admin = await mysql.createConnection(ROOT_URL);
for (const name of ['hovod_c_fresh', 'hovod_c_tier']) {
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.query(`CREATE DATABASE \`${name}\``);
}
await admin.end();

async function columns(pool, table) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME AS c, COLUMN_TYPE AS ty, IS_NULLABLE AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [table],
  );
  return Object.fromEntries(rows.map((r) => [r.c, `${r.ty} ${r.n}`]));
}
async function tables(pool) {
  const [rows] = await pool.query('SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME');
  return rows.map((r) => r.t);
}

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ok   ${label}`); };

/* ─── 1. Fresh install 0001 → 0004 ───────────────────────── */
console.log('\n[1] fresh install 0001 → 0004');
{
  const pool = mysql.createPool({ uri: withDb('hovod_c_fresh'), connectionLimit: 3 });
  const files = await listMigrationFiles(MIGRATIONS_DIR);
  const r1 = await runMigrations(pool, { logger: quiet });
  assert.deepEqual(r1.applied, files); ok(`applied ${files.length} files: ${files.join(', ')}`);
  assert.ok(files.includes('0004_cloud.sql')); ok('0004_cloud.sql is part of the set');

  const t = await tables(pool);
  for (const name of ['stripe_events', 'usage_monthly', 'org_invitations', 'password_resets']) {
    assert.ok(t.includes(name), name); ok(`table ${name} exists`);
  }
  const orgs = await columns(pool, 'organizations');
  assert.equal(orgs.tier, undefined); ok('organizations.tier dropped');
  assert.equal(orgs.plan, 'varchar(32) YES'); ok('organizations.plan nullable varchar');
  assert.equal(orgs.subscription_status, 'varchar(32) YES'); ok('organizations.subscription_status');
  assert.equal(orgs.cancel_at_period_end, 'tinyint(1) NO'); ok('organizations.cancel_at_period_end NOT NULL default 0');
  for (const c of ['stripe_price_id', 'current_period_end', 'grace_until', 'activated_at']) {
    assert.ok(orgs[c], c); ok(`organizations.${c}`);
  }
  assert.equal((await columns(pool, 'users')).email_verified_at, 'timestamp YES'); ok('users.email_verified_at');
  assert.equal((await columns(pool, 'assets')).storage_bytes, 'bigint NO'); ok('assets.storage_bytes BIGINT NOT NULL');
  assert.equal((await columns(pool, 'usage_monthly')).month, 'char(7) NO'); ok('usage_monthly.month CHAR(7)');

  const r2 = await runMigrations(pool, { logger: quiet });
  assert.deepEqual(r2.applied, []); ok('second run is a no-op');

  // INSERT IGNORE dedupe semantics on stripe_events
  const [a] = await pool.query("INSERT IGNORE INTO stripe_events (id, type) VALUES ('evt_1', 'x')");
  const [b] = await pool.query("INSERT IGNORE INTO stripe_events (id, type) VALUES ('evt_1', 'x')");
  assert.equal(a.affectedRows, 1); assert.equal(b.affectedRows, 0); ok('stripe_events INSERT IGNORE dedupes (1 then 0 rows)');

  // ON DUPLICATE KEY UPDATE accumulates usage
  await pool.query("INSERT INTO users (id, email, password_hash) VALUES ('u1', 'u1@x', 'h')");
  await pool.query("INSERT INTO organizations (id, name, slug, owner_id) VALUES ('o1', 'O', 'o', 'u1')");
  const upsert = "INSERT INTO usage_monthly (org_id, month, encoding_sec, ai_sec) VALUES ('o1', '2026-09', ?, ?) ON DUPLICATE KEY UPDATE encoding_sec = encoding_sec + VALUES(encoding_sec), ai_sec = ai_sec + VALUES(ai_sec)";
  await pool.query(upsert, [100, 0]);
  await pool.query(upsert, [50, 30]);
  const [[u]] = await pool.query("SELECT encoding_sec, ai_sec FROM usage_monthly WHERE org_id = 'o1' AND month = '2026-09'");
  assert.equal(Number(u.encoding_sec), 150); assert.equal(Number(u.ai_sec), 30); ok('usage_monthly upsert accumulates (150 s / 30 s)');
  await pool.query("DELETE FROM organizations WHERE id = 'o1'");
  const [[left]] = await pool.query("SELECT COUNT(*) AS n FROM usage_monthly");
  assert.equal(Number(left.n), 0); ok('usage_monthly cascades on org delete');
  await pool.end();
}

/* ─── 2. Upgrade from a DB where organizations.tier has values ── */
console.log('\n[2] upgrade: organizations.tier → plan');
{
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'hovod-0004-'));
  await cp(MIGRATIONS_DIR, tmp, { recursive: true });
  for (const f of await readdir(tmp)) if (f >= '0004') await rm(path.join(tmp, f));

  const pool = mysql.createPool({ uri: withDb('hovod_c_tier'), connectionLimit: 3 });
  const r0 = await runMigrations(pool, { migrationsDir: tmp, logger: quiet });
  assert.deepEqual(r0.applied, ['0001_baseline.sql', '0002_playback_sessions.sql', '0003_api_hardening.sql']); ok('0001–0003 applied (pre-cloud state)');
  assert.equal((await columns(pool, 'organizations')).tier, 'varchar(32) NO'); ok('organizations.tier present before 0004');

  await pool.query("INSERT INTO users (id, email, password_hash) VALUES ('u1', 'a@x', 'h')");
  await pool.query(`INSERT INTO organizations (id, name, slug, owner_id, tier, stripe_customer_id, stripe_subscription_id) VALUES
    ('free1', 'Free', 'free1', 'u1', 'free', NULL, NULL),
    ('pro1',  'Pro',  'pro1',  'u1', 'pro',  'cus_1', 'sub_1'),
    ('biz1',  'Biz',  'biz1',  'u1', 'business', 'cus_2', NULL),
    ('odd1',  'Odd',  'odd1',  'u1', 'enterprise', NULL, NULL)`);

  const r1 = await runMigrations(pool, { logger: quiet });
  assert.deepEqual(r1.applied, ['0004_cloud.sql']); ok('0004 applied on top');
  assert.equal((await columns(pool, 'organizations')).tier, undefined); ok('tier column dropped');

  const [rows] = await pool.query('SELECT id, plan, subscription_status, activated_at FROM organizations ORDER BY id');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.free1.plan, null); assert.equal(byId.free1.subscription_status, null); ok("tier 'free' → plan NULL, no status");
  assert.equal(byId.pro1.plan, 'pro'); assert.equal(byId.pro1.subscription_status, 'active'); assert.ok(byId.pro1.activated_at); ok("tier 'pro' + subscription id → plan pro, status active (until Stripe overwrites)");
  assert.equal(byId.biz1.plan, 'business'); assert.equal(byId.biz1.subscription_status, null); ok("tier 'business' without subscription → plan business, no status (pending)");
  assert.equal(byId.odd1.plan, null); ok("unknown tier → plan NULL");

  const r2 = await runMigrations(pool, { logger: quiet });
  assert.deepEqual(r2.applied, []); ok('second run is a no-op');
  await pool.end();
  await rm(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);
