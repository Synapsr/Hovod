import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise';

/**
 * Plain-SQL migration runner.
 *
 * - Migrations live in `packages/db/migrations/NNNN_name.sql` and are applied
 *   in lexical order. Statements inside a file are separated by a line that is
 *   exactly `-- >statement-breakpoint`.
 * - Applied files are recorded in `schema_migrations` (name PRIMARY KEY).
 * - The whole run is serialised across replicas with `GET_LOCK('hovod_migrations')`.
 * - A failed statement aborts the boot with the file name + MySQL error.
 * - Installs that predate this runner (tables exist, no `schema_migrations`)
 *   get a one-time {@link legacyRepair} and the baseline is marked as applied
 *   without being executed.
 */

/** Absolute path of `packages/db/migrations` (works from `src/` via tsx and from `dist/`). */
export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export const MIGRATIONS_TABLE = 'schema_migrations';
export const MIGRATIONS_LOCK_NAME = 'hovod_migrations';
export const MIGRATIONS_LOCK_TIMEOUT_SEC = 120;
export const BASELINE_MIGRATION = '0001_baseline.sql';
export const STATEMENT_BREAKPOINT = '-- >statement-breakpoint';

const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface RunMigrationsOptions {
  /** Directory containing the `NNNN_name.sql` files (default: {@link MIGRATIONS_DIR}). */
  migrationsDir?: string;
  logger?: MigrationLogger;
}

export interface RunMigrationsResult {
  /** Files applied during this run, in order. */
  applied: string[];
  /** Files that were already recorded in `schema_migrations`. */
  skipped: string[];
  /** True when a pre-migration-system install was detected and repaired. */
  legacyRepaired: boolean;
}

export class MigrationError extends Error {
  constructor(
    public readonly file: string,
    public readonly statementIndex: number,
    public readonly statement: string,
    /** The underlying MySQL error. */
    public readonly dbError: unknown,
  ) {
    const detail = dbError instanceof Error ? dbError.message : String(dbError);
    super(
      `Migration ${file} failed at statement #${statementIndex + 1}: ${detail}\n` +
        `Statement:\n${statement}`,
      { cause: dbError },
    );
    this.name = 'MigrationError';
  }
}

/* ─── Parsing ────────────────────────────────────────────── */

/** True when a chunk of SQL contains nothing but whitespace and `--` line comments. */
function isBlankSql(chunk: string): boolean {
  return chunk
    .split('\n')
    .every((line) => {
      const t = line.trim();
      return t === '' || t.startsWith('--');
    });
}

/**
 * Split a migration file into individual statements on `-- >statement-breakpoint`
 * lines. Comment-only chunks are dropped, trailing semicolons are kept (MySQL
 * accepts them on single statements).
 */
export function parseMigrationSql(sql: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    if (line.trim() === STATEMENT_BREAKPOINT) {
      chunks.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  chunks.push(current.join('\n'));
  return chunks.map((c) => c.trim()).filter((c) => !isBlankSql(c));
}

/**
 * List migration files in `dir`, validating names (`NNNN_name.sql`), ordering
 * and uniqueness of the 4-digit sequence number. Returns sorted file names.
 */
export async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();

  const seen = new Map<string, string>();
  for (const name of files) {
    const m = MIGRATION_FILE_RE.exec(name);
    if (!m) {
      throw new Error(
        `Invalid migration file name "${name}" in ${dir} (expected NNNN_snake_case_name.sql)`,
      );
    }
    const dup = seen.get(m[1]);
    if (dup) {
      throw new Error(`Duplicate migration sequence ${m[1]}: "${dup}" and "${name}"`);
    }
    seen.set(m[1], name);
  }
  return files;
}

/* ─── INFORMATION_SCHEMA helpers ─────────────────────────── */

async function tableExists(conn: Connection, table: string): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT 1 AS present FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

async function columnType(conn: Connection, table: string, column: string): Promise<string | null> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT DATA_TYPE AS dataType FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column],
  );
  return rows.length > 0 ? String(rows[0].dataType).toLowerCase() : null;
}

async function indexExists(conn: Connection, table: string, index: string): Promise<boolean> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT 1 AS present FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, index],
  );
  return rows.length > 0;
}

async function addColumnIfMissing(
  conn: Connection,
  logger: MigrationLogger,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  if (await columnType(conn, table, column)) return;
  logger.info(`[migrations] legacy repair: adding ${table}.${column}`);
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function modifyColumnIfType(
  conn: Connection,
  logger: MigrationLogger,
  table: string,
  column: string,
  fromTypes: string[],
  definition: string,
): Promise<void> {
  const current = await columnType(conn, table, column);
  if (!current || !fromTypes.includes(current)) return;
  logger.info(`[migrations] legacy repair: changing ${table}.${column} from ${current} to ${definition}`);
  await conn.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${definition}`);
}

/* ─── Legacy repair ──────────────────────────────────────── */

const CREATE_TABLE_RE = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?/i;

/** Table name of a `CREATE TABLE` statement, or null for any other statement. */
export function createdTableName(statement: string): string | null {
  const withoutLeadingComments = statement
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();
  const m = CREATE_TABLE_RE.exec(withoutLeadingComments);
  return m ? m[1] : null;
}

/**
 * One-time repair for installs created before the migration system existed
 * (the API used to run `CREATE TABLE IF NOT EXISTS` + a list of `ALTER`s whose
 * errors were swallowed on every boot).
 *
 * Brings such a database up to the state described by `0001_baseline.sql`:
 *  1. creates every baseline table that is missing (each `CREATE TABLE` of the
 *     baseline is executed only when INFORMATION_SCHEMA says the table is absent);
 *  2. adds the columns that older versions lacked, only when absent;
 *  3. widens `assets.description` to TEXT and `renditions.file_size_bytes` to BIGINT.
 *
 * Every step is idempotent. This function does NOT touch `schema_migrations`.
 */
export async function legacyRepair(
  conn: Connection,
  opts: RunMigrationsOptions = {},
): Promise<void> {
  const logger = opts.logger ?? console;
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;

  // 1. Missing tables — taken from the baseline so the DDL lives in one place.
  const baselineSql = await readFile(path.join(dir, BASELINE_MIGRATION), 'utf8');
  for (const statement of parseMigrationSql(baselineSql)) {
    const table = createdTableName(statement);
    if (!table) {
      throw new Error(
        `${BASELINE_MIGRATION} must contain only CREATE TABLE statements (legacy repair relies on it)`,
      );
    }
    if (await tableExists(conn, table)) continue;
    logger.info(`[migrations] legacy repair: creating missing table ${table}`);
    await conn.query(statement);
  }

  // 2. Columns added by successive versions (previously blind ALTERs).
  await addColumnIfMissing(conn, logger, 'assets', 'org_id', 'VARCHAR(36) NULL AFTER id');
  await addColumnIfMissing(conn, logger, 'assets', 'custom_metadata', 'JSON NULL AFTER metadata');
  await addColumnIfMissing(conn, logger, 'assets', 'public_settings', 'JSON NULL AFTER metadata');
  await addColumnIfMissing(conn, logger, 'assets', 'description', 'TEXT NULL AFTER metadata');
  await addColumnIfMissing(conn, logger, 'assets', 'custom_thumbnail_key', 'VARCHAR(512) NULL AFTER public_settings');
  await addColumnIfMissing(conn, logger, 'jobs', 'current_step', 'VARCHAR(64) NULL AFTER status');
  await addColumnIfMissing(conn, logger, 'renditions', 'file_size_bytes', 'BIGINT NULL AFTER bitrate_kbps');

  // 3. Type widenings.
  await modifyColumnIfType(conn, logger, 'assets', 'description', ['varchar'], 'TEXT NULL');
  await modifyColumnIfType(conn, logger, 'renditions', 'file_size_bytes', ['int', 'mediumint', 'smallint'], 'BIGINT NULL');

  // 4. Index that the old ALTER path never created on upgraded installs.
  if (!(await indexExists(conn, 'assets', 'idx_assets_org_id'))) {
    logger.info('[migrations] legacy repair: adding index assets.idx_assets_org_id');
    await conn.query('ALTER TABLE `assets` ADD INDEX `idx_assets_org_id` (`org_id`)');
  }
}

/* ─── Runner ─────────────────────────────────────────────── */

/**
 * Apply every migration file not yet recorded in `schema_migrations`.
 *
 * Safe to run from several API replicas at once: the run is serialised with a
 * MySQL advisory lock and the second replica sees an up-to-date table.
 * Throws a {@link MigrationError} (with file name and MySQL error) on the first
 * failing statement — callers must let it crash the boot.
 */
export async function runMigrations(
  pool: Pool,
  opts: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  const logger = opts.logger ?? console;
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const files = await listMigrationFiles(dir);

  const conn = await pool.getConnection();
  try {
    const [lockRows] = await conn.query<RowDataPacket[]>(
      'SELECT GET_LOCK(?, ?) AS locked',
      [MIGRATIONS_LOCK_NAME, MIGRATIONS_LOCK_TIMEOUT_SEC],
    );
    if (Number(lockRows[0]?.locked) !== 1) {
      throw new Error(
        `Could not acquire migration lock "${MIGRATIONS_LOCK_NAME}" within ${MIGRATIONS_LOCK_TIMEOUT_SEC}s`,
      );
    }

    try {
      return await runLocked(conn, files, dir, logger);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [MIGRATIONS_LOCK_NAME]);
    }
  } finally {
    conn.release();
  }
}

async function runLocked(
  conn: Connection,
  files: string[],
  dir: string,
  logger: MigrationLogger,
): Promise<RunMigrationsResult> {
  // Legacy detection must happen before the migrations table is created.
  const hasMigrationsTable = await tableExists(conn, MIGRATIONS_TABLE);
  const legacy = !hasMigrationsTable && (await tableExists(conn, 'assets'));

  await conn.query(
    `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  );

  if (legacy) {
    logger.warn(
      `[migrations] existing install without ${MIGRATIONS_TABLE} detected — running legacy repair and marking ${BASELINE_MIGRATION} as applied`,
    );
    if (!files.includes(BASELINE_MIGRATION)) {
      throw new Error(`Legacy install detected but ${BASELINE_MIGRATION} is missing from ${dir}`);
    }
    await legacyRepair(conn, { migrationsDir: dir, logger });
    await conn.query(`INSERT IGNORE INTO \`${MIGRATIONS_TABLE}\` (name) VALUES (?)`, [BASELINE_MIGRATION]);
  }

  const [appliedRows] = await conn.query<RowDataPacket[]>(
    `SELECT name FROM \`${MIGRATIONS_TABLE}\``,
  );
  const alreadyApplied = new Set(appliedRows.map((r) => String(r.name)));

  const result: RunMigrationsResult = { applied: [], skipped: [], legacyRepaired: legacy };

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      result.skipped.push(file);
      continue;
    }

    const statements = parseMigrationSql(await readFile(path.join(dir, file), 'utf8'));
    logger.info(`[migrations] applying ${file} (${statements.length} statement${statements.length === 1 ? '' : 's'})`);

    for (let i = 0; i < statements.length; i++) {
      try {
        await conn.query(statements[i]);
      } catch (err) {
        // DDL is not transactional in MySQL: surface exactly where it stopped and abort the boot.
        throw new MigrationError(file, i, statements[i], err);
      }
    }

    await conn.query(`INSERT INTO \`${MIGRATIONS_TABLE}\` (name) VALUES (?)`, [file]);
    result.applied.push(file);
  }

  if (result.applied.length === 0) {
    logger.info(`[migrations] schema up to date (${result.skipped.length} applied)`);
  } else {
    logger.info(`[migrations] applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
  }
  return result;
}
