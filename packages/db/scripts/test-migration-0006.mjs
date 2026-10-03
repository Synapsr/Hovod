#!/usr/bin/env node
/**
 * Asset JSON repair against a real MySQL or MariaDB (after npm run build -w @hovod/db).
 * Uses a new temporary database and drops it in finally.
 *
 * HOVOD_TEST_DATABASE_URL=mysql://root:root@127.0.0.1:33307/mysql node packages/db/scripts/test-migration-0006.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MIGRATIONS_DIR, runMigrations, listMigrationFiles, parseMigrationSql } = await import(path.join(PKG_ROOT, 'dist', 'index.js'));
const REPAIR = '0006_repair_asset_json.sql';
const sql = await readFile(path.join(MIGRATIONS_DIR, REPAIR), 'utf8');
const statements = parseMigrationSql(sql);
assert.equal(statements.length, 2, 'each JSON column has its own runner statement');

const rootUrl = process.env.HOVOD_TEST_DATABASE_URL;
if (!rootUrl) {
  console.log('HOVOD_TEST_DATABASE_URL not set — skipping 0006 database checks');
  process.exit(0);
}

const quiet = { info() {}, warn() {} };
const database = `hovod_json_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(rootUrl);
dbUrl.pathname = `/${database}`;
const admin = await mysql.createConnection(rootUrl);
const beforeRepairDir = await mkdtemp(path.join(os.tmpdir(), 'hovod-0006-'));
let pool;
let passed = 0;
const ok = (label) => { passed++; console.log(`  ok   ${label}`); };

try {
  await admin.query(`CREATE DATABASE \`${database}\``);
  pool = mysql.createPool({ uri: dbUrl.toString(), connectionLimit: 3, dateStrings: true });
  await cp(MIGRATIONS_DIR, beforeRepairDir, { recursive: true });
  for (const file of await readdir(beforeRepairDir)) {
    if (file >= '0006') await rm(path.join(beforeRepairDir, file));
  }
  const earlierFiles = await listMigrationFiles(beforeRepairDir);
  assert.deepEqual((await runMigrations(pool, { migrationsDir: beforeRepairDir, logger: quiet })).applied, earlierFiles);
  ok('upgrade fixture runs all migrations before 0006');

  const encode = JSON.stringify;
  const probe = { width: 1920, note: 'Café "été"', path: 'a\\b\\c' };
  const custom = { genre: 'documentary', course: '42', note: 'Café "été"', path: 'a\\b\\c' };
  const healthyMeta = encode(probe);
  const healthyCustom = encode(custom);
  const fixtures = [
    ['healthy', healthyMeta, healthyCustom],
    ['encoded', encode(healthyMeta), encode(healthyCustom)],
    ['mixed_metadata', encode(healthyMeta), healthyCustom],
    ['mixed_custom', healthyMeta, encode(healthyCustom)],
    ['empty', encode('{}'), encode('{}')],
    ['sql_null', null, null],
    ['json_null', 'null', 'null'],
    ['array', '[1,"a"]', '["a","b"]'],
    ['encoded_array', encode('[1,"a"]'), encode('["a","b"]')],
    ['number', '123', '42'],
    ['boolean', 'true', 'false'],
    ['string', encode('documentary'), encode('plain text')],
    ['invalid_inner', encode('{invalid'), encode('[invalid')],
    ['encoded_number', encode('123'), encode('42')],
    ['encoded_boolean', encode('true'), encode('false')],
    ['encoded_null', encode('null'), encode('null')],
    ['encoded_string', encode(encode('123')), encode(encode('42'))],
    ['extra_layer', encode(encode(healthyMeta)), encode(encode(healthyCustom))],
  ];
  for (const [id, metadata, customMetadata] of fixtures) {
    await pool.query(
      'INSERT INTO assets (id, org_id, title, playback_id, metadata, custom_metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, 'test_org', id, `play_${id}`, metadata, customMetadata, '2020-01-02 03:04:05'],
    );
  }

  // Read documents as text to compare identical storage on both engines. mysql2
  // decodes MySQL JSON itself, whereas MariaDB JSON is returned as LONGTEXT.
  const snapshot = async () => {
    const [rows] = await pool.query('SELECT id, CAST(metadata AS CHAR) AS metadata, CAST(custom_metadata AS CHAR) AS customMetadata, updated_at AS updatedAt FROM assets ORDER BY id');
    return Object.fromEntries(rows.map((row) => [row.id, row]));
  };
  const before = await snapshot();
  const result = await runMigrations(pool, { logger: quiet });
  assert.deepEqual(result.applied, [REPAIR]);
  ok('0006 repair is recorded by the versioned runner');

  const after = await snapshot();
  for (const id of ['encoded', 'mixed_metadata', 'mixed_custom']) {
    assert.deepEqual(JSON.parse(after[id].metadata), probe);
    assert.deepEqual(JSON.parse(after[id].customMetadata), custom);
    assert.equal(after[id].updatedAt, before[id].updatedAt);
    ok(`${id}: valid object documents repaired, timestamp preserved`);
  }
  assert.deepEqual(JSON.parse(after.empty.metadata), {});
  assert.deepEqual(JSON.parse(after.empty.customMetadata), {});
  ok('encoded empty objects repaired');

  const repaired = new Set(['encoded', 'mixed_metadata', 'mixed_custom', 'empty']);
  for (const [id] of fixtures) {
    if (repaired.has(id)) continue;
    assert.deepEqual(after[id], before[id], `${id} must be left untouched`);
    ok(`${id}: storage preserved`);
  }

  // Execute statements explicitly too: retries after a partial failed migration
  // must remain safe, independent of schema_migrations suppressing normal reruns.
  for (const statement of statements) {
    const [result] = await pool.query(statement);
    assert.equal(result.affectedRows, 0, 're-executed repair must match no rows');
  }
  assert.deepEqual(await snapshot(), after);
  ok('both repair statements are idempotent');
  assert.deepEqual((await runMigrations(pool, { logger: quiet })).applied, []);
  ok('subsequent runner invocation is a no-op');

  const [[types]] = await pool.query("SELECT JSON_TYPE(metadata) AS metadataType, JSON_TYPE(custom_metadata) AS customType FROM assets WHERE id = 'encoded'");
  assert.equal(types.metadataType, 'OBJECT');
  assert.equal(types.customType, 'OBJECT');
  ok('repaired SQL values are objects rather than JSON string scalars');

  // Fresh installs execute the repair against empty assets without errors.
  await pool.query('DELETE FROM assets');
  await pool.query('DELETE FROM schema_migrations WHERE name = ?', [REPAIR]);
  assert.deepEqual((await runMigrations(pool, { logger: quiet })).applied, [REPAIR]);
  ok('repair runs safely against an empty asset table');

  console.log(`\n${passed} JSON repair checks passed`);
} finally {
  if (pool) await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.end();
  await rm(beforeRepairDir, { recursive: true, force: true });
}
