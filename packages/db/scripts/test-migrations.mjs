#!/usr/bin/env node
/**
 * Migration test-suite (plain node, no framework). Run from packages/db after `npm run build`:
 *
 *   node scripts/test-migrations.mjs            # static checks + docker MySQL tests
 *   node scripts/test-migrations.mjs --static   # static checks only (no docker)
 *
 * Static checks: file names / ordering / uniqueness, every file parses into
 * at least one statement, and the baseline creates every table declared in
 * src/schema.ts.
 *
 * Docker checks (skipped when the docker CLI is unavailable): a throwaway
 * mysql:8.4 container is started, then:
 *   1. fresh database → run twice, second run is a no-op, schema matches expectations;
 *   2. legacy v0.1-style database (no schema_migrations, old columns missing)
 *      → legacyRepair runs, 0001 is marked applied without executing it, second run no-op;
 *   3. a failing migration aborts with file name + MySQL error and is not recorded;
 *   4. concurrent boots (3 pools at once) apply the migrations exactly once.
 *
 * Env overrides: HOVOD_MIG_TEST_PORT (default 33306), HOVOD_MIG_TEST_CONTAINER
 * (default hovod-mig-test), HOVOD_MIG_TEST_IMAGE (default mysql:8.4).
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const SCHEMA_TS = path.join(PKG_ROOT, 'src', 'schema.ts');

const {
  MIGRATIONS_DIR,
  BASELINE_MIGRATION,
  MIGRATIONS_TABLE,
  MigrationError,
  listMigrationFiles,
  parseMigrationSql,
  createdTableName,
  runMigrations,
} = await import(path.join(PKG_ROOT, 'dist', 'index.js'));

const STATIC_ONLY = process.argv.includes('--static');
const PORT = Number(process.env.HOVOD_MIG_TEST_PORT ?? 33306);
const CONTAINER = process.env.HOVOD_MIG_TEST_CONTAINER ?? 'hovod-mig-test';
const IMAGE = process.env.HOVOD_MIG_TEST_IMAGE ?? 'mysql:8.4';
const ROOT_PW = 'root';

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${label}${a === e ? '' : ` (got ${a}, expected ${e})`}`);
}

const quietLogger = { info() {}, warn() {} };

/* ─── Static checks ──────────────────────────────────────── */

console.log(`\nStatic checks (${MIGRATIONS_DIR})`);

const files = await listMigrationFiles(MIGRATIONS_DIR);
ok(files.length >= 1, `found ${files.length} migration file(s)`);
eq(files[0], BASELINE_MIGRATION, 'first migration is the baseline');

const sorted = [...files].sort();
eq(files, sorted, 'files are in lexical order');

const seqs = files.map((f) => Number(f.slice(0, 4)));
const expectedSeqs = seqs.map((_, i) => i + 1);
eq(seqs, expectedSeqs, 'sequence numbers are contiguous from 0001');

const allEntries = (await readdir(MIGRATIONS_DIR)).filter((n) => !n.startsWith('.'));
eq(allEntries.length, files.length, 'no stray files in migrations dir');

const baselineTables = [];
for (const file of files) {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  const statements = parseMigrationSql(sql);
  ok(statements.length > 0, `${file}: parses into ${statements.length} statement(s)`);
  ok(
    statements.every((s) => !s.includes('-- >statement-breakpoint')),
    `${file}: no breakpoint marker leaks into statements`,
  );
  if (file === BASELINE_MIGRATION) {
    for (const s of statements) {
      const t = createdTableName(s);
      ok(t !== null, `${file}: statement is a CREATE TABLE (${t ?? s.slice(0, 40)})`);
      if (t) baselineTables.push(t);
    }
  }
}

// Parser edge cases
eq(parseMigrationSql(''), [], 'parser: empty file → no statements');
eq(parseMigrationSql('-- only a comment\n\n'), [], 'parser: comment-only file → no statements');
eq(
  parseMigrationSql('SELECT 1;\n-- >statement-breakpoint\n\n-- c\nSELECT 2;\n-- >statement-breakpoint\n'),
  ['SELECT 1;', '-- c\nSELECT 2;'],
  'parser: splits on breakpoint and drops trailing empty chunk',
);
eq(parseMigrationSql('SELECT 1;\r\n-- >statement-breakpoint\r\nSELECT 2;'), ['SELECT 1;', 'SELECT 2;'], 'parser: CRLF');

// Baseline covers every mysqlTable() in schema.ts
const schemaSrc = await readFile(SCHEMA_TS, 'utf8');
const schemaTables = [...schemaSrc.matchAll(/mysqlTable\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
ok(schemaTables.length > 0, `schema.ts declares ${schemaTables.length} table(s)`);
for (const t of schemaTables) {
  ok(baselineTables.includes(t), `baseline creates schema.ts table "${t}"`);
}
for (const t of baselineTables) {
  ok(schemaTables.includes(t), `schema.ts declares baseline table "${t}"`);
}

// Baseline covers every column of schema.ts (column names inside each mysqlTable block)
const baselineSql = await readFile(path.join(MIGRATIONS_DIR, BASELINE_MIGRATION), 'utf8');
const baselineStatements = parseMigrationSql(baselineSql);
const tableBlocks = schemaSrc.split(/export const \w+ = mysqlTable\(/).slice(1);
for (const block of tableBlocks) {
  const table = /^\s*'([a-z0-9_]+)'/.exec(block)?.[1];
  const body = block.split('}, (table)')[0].split('});')[0];
  const columns = [...body.matchAll(/\b(?:varchar|int|bigint|json|text|timestamp)\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  const stmt = baselineStatements.find((s) => createdTableName(s) === table) ?? '';
  const missing = columns.filter((c) => !stmt.includes(`\`${c}\``));
  eq(missing, [], `baseline "${table}" has all ${columns.length} schema.ts columns`);
}

/* ─── Docker-backed checks ───────────────────────────────── */

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function dockerAvailable() {
  return sh('docker', ['version', '--format', '{{.Server.Version}}']).code === 0;
}

async function waitForMysql(url, timeoutMs = 90_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const c = await mysql.createConnection(url);
      await c.query('SELECT 1');
      await c.end();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`MySQL not ready after ${timeoutMs}ms: ${lastErr?.message}`);
}

async function withPool(url, fn) {
  const pool = mysql.createPool({ uri: url, connectionLimit: 5 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function tables(pool) {
  const [rows] = await pool.query(
    'SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME',
  );
  return rows.map((r) => r.t);
}

async function column(pool, table, col) {
  const [rows] = await pool.query(
    `SELECT DATA_TYPE AS dataType, IS_NULLABLE AS nullable, COLUMN_TYPE AS columnType
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, col],
  );
  return rows[0] ?? null;
}

async function applied(pool) {
  const [rows] = await pool.query(`SELECT name FROM \`${MIGRATIONS_TABLE}\` ORDER BY name`);
  return rows.map((r) => r.name);
}

const EXPECTED_TABLES = [...baselineTables, MIGRATIONS_TABLE].sort();

async function dockerTests() {
  const rootUrl = `mysql://root:${ROOT_PW}@127.0.0.1:${PORT}/mysql`;
  const dbUrl = (db) => `mysql://root:${ROOT_PW}@127.0.0.1:${PORT}/${db}`;

  console.log(`\nDocker checks (container ${CONTAINER}, ${IMAGE}, port ${PORT})`);
  sh('docker', ['rm', '-f', CONTAINER]);
  const run = sh('docker', [
    'run', '-d', '--name', CONTAINER, '-p', `${PORT}:3306`,
    '-e', `MYSQL_ROOT_PASSWORD=${ROOT_PW}`, IMAGE,
  ]);
  if (run.code !== 0) throw new Error(`docker run failed: ${run.out}`);

  try {
    await waitForMysql(rootUrl);
    console.log('  mysql ready');

    const admin = await mysql.createConnection(rootUrl);
    for (const db of ['hovod_fresh', 'hovod_legacy', 'hovod_fail', 'hovod_par']) {
      await admin.query(`CREATE DATABASE \`${db}\``);
    }
    await admin.end();

    /* 1. Fresh install */
    console.log('\n[1] fresh install');
    await withPool(dbUrl('hovod_fresh'), async (pool) => {
      const r1 = await runMigrations(pool, { logger: quietLogger });
      eq(r1.applied, files, 'first run applies every migration');
      eq(r1.legacyRepaired, false, 'first run is not a legacy repair');
      eq(await applied(pool), files, 'schema_migrations records every file');
      eq(await tables(pool), EXPECTED_TABLES, 'all baseline tables + schema_migrations exist');

      const fsb = await column(pool, 'renditions', 'file_size_bytes');
      eq(fsb?.dataType, 'bigint', 'renditions.file_size_bytes is BIGINT');
      eq((await column(pool, 'assets', 'description'))?.dataType, 'text', 'assets.description is TEXT');
      eq((await column(pool, 'jobs', 'current_step'))?.dataType, 'varchar', 'jobs.current_step exists');
      eq((await column(pool, 'assets', 'org_id'))?.nullable, 'NO', 'assets.org_id is NOT NULL on fresh installs');

      const r2 = await runMigrations(pool, { logger: quietLogger });
      eq(r2.applied, [], 'second run applies nothing');
      eq(r2.skipped, files, 'second run skips every file');
      eq(await tables(pool), EXPECTED_TABLES, 'second run changes no tables');

      const [lock] = await pool.query("SELECT IS_FREE_LOCK('hovod_migrations') AS free");
      eq(Number(lock[0].free), 1, 'advisory lock released after run');
    });

    /* 2. Legacy install (v0.1-style schema, no schema_migrations) */
    console.log('\n[2] legacy install');
    await withPool(dbUrl('hovod_legacy'), async (pool) => {
      await pool.query(`
        CREATE TABLE assets (
          id VARCHAR(36) PRIMARY KEY,
          status VARCHAR(32) NOT NULL DEFAULT 'created',
          source_type VARCHAR(32) NOT NULL DEFAULT 'upload',
          source_key VARCHAR(512) NULL,
          source_url VARCHAR(2048) NULL,
          title VARCHAR(255) NOT NULL,
          playback_id VARCHAR(64) NOT NULL UNIQUE,
          metadata JSON NULL,
          description VARCHAR(2000) NULL,
          duration_sec INT NULL,
          error_message VARCHAR(1024) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_assets_status (status)
        )`);
      await pool.query(`
        CREATE TABLE renditions (
          id VARCHAR(36) PRIMARY KEY,
          asset_id VARCHAR(36) NOT NULL,
          quality VARCHAR(32) NOT NULL,
          width INT NOT NULL,
          height INT NOT NULL,
          bitrate_kbps INT NOT NULL,
          file_size_bytes INT NULL,
          codec VARCHAR(32) NOT NULL DEFAULT 'h264',
          playlist_path VARCHAR(1024) NOT NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_renditions_asset_id (asset_id),
          CONSTRAINT fk_renditions_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
        )`);
      await pool.query(`
        CREATE TABLE jobs (
          id VARCHAR(36) PRIMARY KEY,
          asset_id VARCHAR(36) NOT NULL,
          type VARCHAR(32) NOT NULL,
          status VARCHAR(32) NOT NULL,
          attempts INT NOT NULL DEFAULT 0,
          error_message VARCHAR(1024) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_jobs_asset_id (asset_id),
          CONSTRAINT fk_jobs_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
        )`);
      await pool.query(
        "INSERT INTO assets (id, title, playback_id, description) VALUES ('a1', 'Old video', 'pb1', 'legacy desc')",
      );
      await pool.query(
        "INSERT INTO renditions (id, asset_id, quality, width, height, bitrate_kbps, file_size_bytes, playlist_path) VALUES ('r1', 'a1', '720p', 1280, 720, 3000, 123456, 'playback/a1/720p/index.m3u8')",
      );
      await pool.query("INSERT INTO jobs (id, asset_id, type, status) VALUES ('j1', 'a1', 'transcode', 'completed')");

      const warnings = [];
      const r1 = await runMigrations(pool, { logger: { info() {}, warn: (m) => warnings.push(m) } });
      eq(r1.legacyRepaired, true, 'legacy install detected');
      eq(r1.applied, files.filter((f) => f !== BASELINE_MIGRATION), 'baseline not executed, later migrations applied');
      ok(warnings.some((w) => w.includes('legacy repair')), 'legacy repair is logged as a warning');
      eq(await applied(pool), files, 'baseline marked as applied');
      eq(await tables(pool), EXPECTED_TABLES, 'missing tables created by legacy repair');

      const orgId = await column(pool, 'assets', 'org_id');
      eq(orgId?.dataType, 'varchar', 'assets.org_id added');
      eq(orgId?.nullable, 'YES', 'assets.org_id stays NULL-able until bootstrapDefaultOrg()');
      eq((await column(pool, 'assets', 'custom_metadata'))?.dataType, 'json', 'assets.custom_metadata added');
      eq((await column(pool, 'assets', 'public_settings'))?.dataType, 'json', 'assets.public_settings added');
      eq((await column(pool, 'assets', 'custom_thumbnail_key'))?.dataType, 'varchar', 'assets.custom_thumbnail_key added');
      eq((await column(pool, 'assets', 'description'))?.dataType, 'text', 'assets.description widened to TEXT');
      eq((await column(pool, 'jobs', 'current_step'))?.dataType, 'varchar', 'jobs.current_step added');
      eq((await column(pool, 'renditions', 'file_size_bytes'))?.dataType, 'bigint', 'renditions.file_size_bytes widened to BIGINT');
      const [idx] = await pool.query(
        "SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assets' AND INDEX_NAME = 'idx_assets_org_id'",
      );
      eq(idx.length, 1, 'idx_assets_org_id created');

      const [rows] = await pool.query("SELECT title, description FROM assets WHERE id = 'a1'");
      eq(rows[0], { title: 'Old video', description: 'legacy desc' }, 'existing data preserved');
      const [rends] = await pool.query("SELECT file_size_bytes FROM renditions WHERE id = 'r1'");
      eq(Number(rends[0].file_size_bytes), 123456, 'rendition size preserved through BIGINT widening');

      const r2 = await runMigrations(pool, { logger: quietLogger });
      eq(r2.applied, [], 'second boot after legacy repair is a no-op');
      eq(r2.legacyRepaired, false, 'second boot is not a legacy repair');

      // A fresh and a repaired install must expose identical columns for the core tables.
      for (const t of ['assets', 'renditions', 'jobs']) {
        const cols = async (db) =>
          (await pool.query(
            `SELECT COLUMN_NAME AS c, COLUMN_TYPE AS ty, IS_NULLABLE AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
            [db, t],
          ))[0];
        const fresh = (await cols('hovod_fresh')).map((r) => `${r.c} ${r.ty} ${r.n}`).sort();
        const legacy = (await cols('hovod_legacy')).map((r) => `${r.c} ${r.ty} ${r.n}`).sort();
        // org_id nullability differs by design until bootstrapDefaultOrg() runs.
        const norm = (l) => l.map((s) => s.replace(/^org_id varchar\(36\) (YES|NO)$/, 'org_id varchar(36) *'));
        eq(norm(legacy), norm(fresh), `repaired "${t}" columns match fresh install`);
      }
    });

    /* 3. Failing migration aborts loudly and is not recorded */
    console.log('\n[3] failing migration');
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'hovod-mig-'));
    await cp(MIGRATIONS_DIR, tmp, { recursive: true });
    const badName = `${String(files.length + 1).padStart(4, '0')}_bad.sql`;
    await writeFile(
      path.join(tmp, badName),
      'ALTER TABLE assets ADD COLUMN extra_ok INT NULL;\n-- >statement-breakpoint\nALTER TABLE does_not_exist ADD COLUMN x INT;\n',
    );
    await withPool(dbUrl('hovod_fail'), async (pool) => {
      let caught;
      try {
        await runMigrations(pool, { migrationsDir: tmp, logger: quietLogger });
      } catch (err) {
        caught = err;
      }
      ok(caught instanceof MigrationError, 'runner throws MigrationError');
      ok(caught?.message.includes(badName), 'error names the failing file');
      ok(caught?.message.includes('statement #2'), 'error names the failing statement index');
      ok(/does_not_exist/.test(caught?.message ?? ''), 'error carries the MySQL message');
      eq(caught?.file, badName, 'error.file');
      eq(await applied(pool), files, 'failed file is not recorded');
      const [lock] = await pool.query("SELECT IS_FREE_LOCK('hovod_migrations') AS free");
      eq(Number(lock[0].free), 1, 'lock released after failure');

      // Fixing the file lets the next boot continue (statement #1 already ran — file authors must keep partial re-runs in mind).
      await writeFile(
        path.join(tmp, badName),
        'ALTER TABLE assets ADD COLUMN extra_ok2 INT NULL;\n',
      );
      const r = await runMigrations(pool, { migrationsDir: tmp, logger: quietLogger });
      eq(r.applied, [badName], 'fixed migration applies on next boot');
      eq(await applied(pool), [...files, badName].sort(), 'fixed migration recorded');
    });

    // Invalid file names are rejected before touching the database.
    await writeFile(path.join(tmp, 'not_a_migration.sql'), 'SELECT 1;');
    let nameErr;
    try {
      await listMigrationFiles(tmp);
    } catch (err) {
      nameErr = err;
    }
    ok(/Invalid migration file name/.test(nameErr?.message ?? ''), 'invalid file name rejected');
    await rm(path.join(tmp, 'not_a_migration.sql'));
    await writeFile(path.join(tmp, '0001_duplicate.sql'), 'SELECT 1;');
    let dupErr;
    try {
      await listMigrationFiles(tmp);
    } catch (err) {
      dupErr = err;
    }
    ok(/Duplicate migration sequence 0001/.test(dupErr?.message ?? ''), 'duplicate sequence rejected');
    await rm(tmp, { recursive: true, force: true });

    /* 4. Concurrent boots */
    console.log('\n[4] concurrent boots');
    const pools = [1, 2, 3].map(() => mysql.createPool({ uri: dbUrl('hovod_par'), connectionLimit: 3 }));
    try {
      const results = await Promise.all(pools.map((p) => runMigrations(p, { logger: quietLogger })));
      const appliers = results.filter((r) => r.applied.length > 0);
      eq(appliers.length, 1, 'exactly one replica applied the migrations');
      eq(results.filter((r) => r.applied.length === 0).length, 2, 'the other replicas were no-ops');
      eq(await applied(pools[0]), files, 'schema_migrations complete after concurrent boot');
      eq(await tables(pools[0]), EXPECTED_TABLES, 'tables complete after concurrent boot');
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  } finally {
    const rmRes = sh('docker', ['rm', '-f', CONTAINER]);
    console.log(`\n  removed container ${CONTAINER}${rmRes.code === 0 ? '' : ` (docker rm failed: ${rmRes.out})`}`);
  }
}

if (STATIC_ONLY) {
  console.log('\nDocker checks skipped (--static)');
} else if (!dockerAvailable()) {
  console.log('\nDocker checks skipped (docker CLI unavailable)');
} else {
  await dockerTests();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
