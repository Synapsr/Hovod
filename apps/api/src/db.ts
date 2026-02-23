import os from 'node:os';
import { nanoid } from 'nanoid';
import { createDb, ID_LENGTH, ORG_TIER, ORG_ROLE } from '@hovod/db';
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

export async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assets (
      id VARCHAR(36) PRIMARY KEY,
      org_id VARCHAR(36) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'created',
      source_type VARCHAR(32) NOT NULL DEFAULT 'upload',
      source_key VARCHAR(512) NULL,
      source_url VARCHAR(2048) NULL,
      title VARCHAR(255) NOT NULL,
      playback_id VARCHAR(64) NOT NULL UNIQUE,
      metadata JSON NULL,
      duration_sec INT NULL,
      error_message VARCHAR(1024) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_assets_status (status),
      INDEX idx_assets_org_id (org_id)
    )
  `);

  // Add custom_metadata column for user-defined key-value pairs
  await pool.query(`
    ALTER TABLE assets ADD COLUMN custom_metadata JSON NULL AFTER metadata
  `).catch(() => { /* column already exists */ });

  // Add public_settings column for per-video public page configuration
  await pool.query(`
    ALTER TABLE assets ADD COLUMN public_settings JSON NULL AFTER metadata
  `).catch(() => { /* column already exists */ });

  // Add description + custom thumbnail columns
  await pool.query(`
    ALTER TABLE assets ADD COLUMN description TEXT NULL AFTER metadata
  `).catch(() => { /* column already exists */ });
  // Widen from VARCHAR(2000) to TEXT for rich HTML content
  await pool.query(`
    ALTER TABLE assets MODIFY COLUMN description TEXT NULL
  `).catch(() => { /* already TEXT */ });
  await pool.query(`
    ALTER TABLE assets ADD COLUMN custom_thumbnail_key VARCHAR(512) NULL AFTER public_settings
  `).catch(() => { /* column already exists */ });

  // Add current_step column for granular processing progress
  await pool.query(`
    ALTER TABLE jobs ADD COLUMN current_step VARCHAR(64) NULL AFTER status
  `).catch(() => { /* column already exists */ });

  // Add org_id column if upgrading from a previous version
  await pool.query(`
    ALTER TABLE assets ADD COLUMN org_id VARCHAR(36) NULL AFTER id
  `).catch(() => { /* column already exists */ });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS renditions (
      id VARCHAR(36) PRIMARY KEY,
      asset_id VARCHAR(36) NOT NULL,
      quality VARCHAR(32) NOT NULL,
      width INT NOT NULL,
      height INT NOT NULL,
      bitrate_kbps INT NOT NULL,
      codec VARCHAR(32) NOT NULL DEFAULT 'h264',
      playlist_path VARCHAR(1024) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_renditions_asset_id (asset_id),
      CONSTRAINT fk_renditions_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
    )
  `);
  // Add file_size_bytes column for real rendition sizes
  await pool.query(`
    ALTER TABLE renditions ADD COLUMN file_size_bytes INT NULL AFTER bitrate_kbps
  `).catch(() => { /* column already exists */ });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
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
    )
  `);

  /* ─── Analytics tables ───────────────────────────────────── */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id VARCHAR(36) PRIMARY KEY,
      session_id VARCHAR(36) NOT NULL,
      asset_id VARCHAR(36) NOT NULL,
      playback_id VARCHAR(64) NOT NULL,
      event_type VARCHAR(32) NOT NULL,
      \`current_time\` INT NULL,
      \`duration\` INT NULL,
      quality_height INT NULL,
      buffer_duration_ms INT NULL,
      error_message VARCHAR(512) NULL,
      user_agent VARCHAR(512) NULL,
      country VARCHAR(8) NULL,
      device_type VARCHAR(16) NULL,
      referrer VARCHAR(2048) NULL,
      player_type VARCHAR(16) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ae_asset_id (asset_id),
      INDEX idx_ae_session_id (session_id),
      INDEX idx_ae_created_at (created_at),
      INDEX idx_ae_event_type (event_type),
      INDEX idx_ae_asset_event (asset_id, event_type, created_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_daily (
      id VARCHAR(36) PRIMARY KEY,
      asset_id VARCHAR(36) NOT NULL,
      date VARCHAR(10) NOT NULL,
      hour INT NULL,
      view_count INT NOT NULL DEFAULT 0,
      unique_sessions INT NOT NULL DEFAULT 0,
      total_watch_time_sec INT NOT NULL DEFAULT 0,
      quality_distribution JSON NULL,
      device_distribution JSON NULL,
      buffer_count INT NOT NULL DEFAULT 0,
      total_buffer_ms INT NOT NULL DEFAULT 0,
      error_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE INDEX idx_ad_asset_date_hour (asset_id, date, hour),
      INDEX idx_ad_date (date),
      INDEX idx_ad_asset_id (asset_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_asset_stats (
      asset_id VARCHAR(36) PRIMARY KEY,
      total_views INT NOT NULL DEFAULT 0,
      total_unique_sessions INT NOT NULL DEFAULT 0,
      total_watch_time_sec INT NOT NULL DEFAULT 0,
      avg_watch_percent INT NOT NULL DEFAULT 0,
      engagement_score INT NOT NULL DEFAULT 0,
      retention_curve JSON NULL,
      peak_hour INT NULL,
      quality_distribution JSON NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  /* ─── AI Processing tables ───────────────────────────────── */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_jobs (
      id VARCHAR(36) PRIMARY KEY,
      asset_id VARCHAR(36) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'queued',
      transcription_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      subtitles_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      chapters_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      transcript_path VARCHAR(1024) NULL,
      subtitles_path VARCHAR(1024) NULL,
      chapters_path VARCHAR(1024) NULL,
      language VARCHAR(16) NULL,
      error_message VARCHAR(1024) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ai_jobs_asset_id (asset_id),
      INDEX idx_ai_jobs_status (status),
      CONSTRAINT fk_ai_jobs_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
    )
  `);

  /* ─── Auth & Organization tables ─────────────────────────── */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_users_email (email)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(100) NOT NULL UNIQUE,
      owner_id VARCHAR(36) NOT NULL,
      tier VARCHAR(32) NOT NULL DEFAULT 'free',
      stripe_customer_id VARCHAR(255) NULL,
      stripe_subscription_id VARCHAR(255) NULL,
      webhook_url VARCHAR(2048) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_orgs_owner (owner_id),
      INDEX idx_orgs_stripe (stripe_customer_id),
      CONSTRAINT fk_orgs_owner FOREIGN KEY (owner_id) REFERENCES users(id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_members (
      id VARCHAR(36) PRIMARY KEY,
      org_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'member',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE INDEX idx_om_org_user (org_id, user_id),
      INDEX idx_om_user (user_id),
      CONSTRAINT fk_om_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
      CONSTRAINT fk_om_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id VARCHAR(36) PRIMARY KEY,
      org_id VARCHAR(36) NOT NULL,
      name VARCHAR(255) NOT NULL,
      key_hash VARCHAR(64) NOT NULL UNIQUE,
      key_prefix VARCHAR(12) NOT NULL,
      last_used_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ak_org (org_id),
      INDEX idx_ak_hash (key_hash),
      CONSTRAINT fk_ak_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
    )
  `);

  /* ─── Platform Settings table ────────────────────────────── */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      id VARCHAR(36) PRIMARY KEY,
      org_id VARCHAR(36) NULL,
      primary_color VARCHAR(7) NOT NULL DEFAULT '#4f46e5',
      theme VARCHAR(8) NOT NULL DEFAULT 'dark',
      logo_key VARCHAR(512) NULL,
      ai_auto_transcribe VARCHAR(5) NOT NULL DEFAULT 'true',
      ai_auto_chapter VARCHAR(5) NOT NULL DEFAULT 'true',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_settings_org_id (org_id),
      UNIQUE INDEX idx_settings_org_unique (org_id),
      CONSTRAINT fk_settings_org FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
    )
  `);

  /* ─── Comments table ────────────────────────────────────── */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id VARCHAR(36) PRIMARY KEY,
      asset_id VARCHAR(36) NOT NULL,
      playback_id VARCHAR(64) NOT NULL,
      author_name VARCHAR(100) NOT NULL,
      author_email VARCHAR(255) NOT NULL,
      body VARCHAR(2000) NOT NULL,
      timestamp_sec INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_comments_playback_id (playback_id),
      INDEX idx_comments_asset_id (asset_id),
      INDEX idx_comments_created_at (created_at),
      CONSTRAINT fk_comments_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
    )
  `);

  /* ─── Reactions table ──────────────────────────────────── */

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reactions (
      id VARCHAR(36) PRIMARY KEY,
      asset_id VARCHAR(36) NOT NULL,
      playback_id VARCHAR(64) NOT NULL,
      emoji VARCHAR(20) NOT NULL,
      session_id VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_reactions_playback_emoji (playback_id, emoji),
      INDEX idx_reactions_asset_id (asset_id),
      CONSTRAINT fk_reactions_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
    )
  `);

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
      'INSERT INTO organizations (id, name, slug, owner_id, tier) VALUES (?, ?, ?, ?, ?)',
      [orgId, 'Default', DEFAULT_ORG_SLUG, userId, ORG_TIER.FREE],
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

  // Apply NOT NULL constraint
  await pool.query(
    'ALTER TABLE assets MODIFY org_id VARCHAR(36) NOT NULL',
  ).catch(() => { /* already NOT NULL */ });

  console.log(`Migration complete: ${nullCount} assets assigned to org ${defaultOrgId}`);
}
