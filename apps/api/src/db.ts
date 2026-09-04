import os from 'node:os';
import { nanoid } from 'nanoid';
import {
  createDb,
  ID_LENGTH,
  ORG_ROLE,
  MIGRATIONS_DIR,
  runMigrations as runDbMigrations,
  type MigrationLogger,
} from '@hovod/db';
import { env } from './env.js';
import { hashPassword } from './services/cloud.js';

/* ─── Auto-detect DB pool size from hardware ──────────────── */
const totalMemGB = os.totalmem() / (1024 ** 3);
// ~3 connections per GB, capped at [10, 50]
const autoPoolSize = Math.min(50, Math.max(10, Math.floor(totalMemGB * 3)));
const poolSize = env.DB_POOL_SIZE ?? autoPoolSize;

export const { db, pool } = createDb(env.DATABASE_URL, {
  connectionLimit: poolSize,
  idleTimeout: 60_000,
});

/**
 * Apply pending SQL migrations from `packages/db/migrations`.
 *
 * Delegates to the shared runner in `@hovod/db` (advisory lock, `schema_migrations`
 * bookkeeping, legacy-install repair). Any failure is rethrown so the boot aborts.
 */
export async function runMigrations(logger: MigrationLogger = console): Promise<void> {
  await runDbMigrations(pool, { migrationsDir: MIGRATIONS_DIR, logger });
}

/**
 * Bootstrap migration for self-hosted → unified mode.
 *
 * When upgrading from a self-hosted instance (no auth), existing assets have
 * org_id = NULL. This function creates a default admin user and organization,
 * assigns orphaned assets, and applies the NOT NULL constraint.
 */
export async function bootstrapDefaultOrg(): Promise<void> {
  const [result] = await pool.query(
    'SELECT COUNT(*) as cnt FROM assets WHERE org_id IS NULL',
  ) as any;
  const nullCount = result?.[0]?.cnt ?? 0;

  if (nullCount === 0) {
    // Ensure NOT NULL constraint (idempotent)
    await pool.query(
      'ALTER TABLE assets MODIFY org_id VARCHAR(36) NOT NULL',
    ).catch(() => { /* already NOT NULL */ });
    return;
  }

  // Check if a default org already exists
  const DEFAULT_ORG_SLUG = 'default';
  const [existingOrg] = await pool.query(
    'SELECT id FROM organizations WHERE slug = ?',
    [DEFAULT_ORG_SLUG],
  ) as any;

  let defaultOrgId: string;

  if (existingOrg?.[0]?.id) {
    defaultOrgId = existingOrg[0].id;
  } else {
    const userId = nanoid(ID_LENGTH.USER);
    const orgId = nanoid(ID_LENGTH.ORG);
    const memberId = nanoid(ID_LENGTH.MEMBER);
    const tempPassword = nanoid(32);

    await pool.query(
      'INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)',
      [userId, 'admin@localhost', hashPassword(tempPassword), 'Admin'],
    );

    await pool.query(
      'INSERT INTO organizations (id, name, slug, owner_id) VALUES (?, ?, ?, ?)',
      [orgId, 'Default', DEFAULT_ORG_SLUG, userId],
    );

    await pool.query(
      'INSERT INTO org_members (id, org_id, user_id, role) VALUES (?, ?, ?, ?)',
      [memberId, orgId, userId, ORG_ROLE.OWNER],
    );

    defaultOrgId = orgId;

    console.log('='.repeat(60));
    console.log('MIGRATION: Created default organization and admin user');
    console.log(`  Email:    admin@localhost`);
    console.log(`  Password: ${tempPassword}`);
    console.log('  IMPORTANT: Change this password after login!');
    console.log('='.repeat(60));
  }

  // Assign orphaned assets and settings to the default org
  await pool.query('UPDATE assets SET org_id = ? WHERE org_id IS NULL', [defaultOrgId]);
  await pool.query('UPDATE settings SET org_id = ? WHERE org_id IS NULL', [defaultOrgId]);
  // Sessions imported by migration 0002 from assets that had no org yet
  await pool.query("UPDATE playback_sessions SET org_id = ? WHERE org_id = ''", [defaultOrgId]);

  // Apply NOT NULL constraint
  await pool.query(
    'ALTER TABLE assets MODIFY org_id VARCHAR(36) NOT NULL',
  ).catch(() => { /* already NOT NULL */ });

  console.log(`Migration complete: ${nullCount} assets assigned to org ${defaultOrgId}`);
}
