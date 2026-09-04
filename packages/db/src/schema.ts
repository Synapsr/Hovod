import { bigint, char, int, json, mysqlTable, primaryKey, text, timestamp, tinyint, varchar, index, uniqueIndex } from 'drizzle-orm/mysql-core';

export const assets = mysqlTable('assets', {
  id: varchar('id', { length: 36 }).primaryKey(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('created'),
  sourceType: varchar('source_type', { length: 32 }).notNull().default('upload'),
  sourceKey: varchar('source_key', { length: 512 }),
  sourceUrl: varchar('source_url', { length: 2048 }),
  title: varchar('title', { length: 255 }).notNull(),
  playbackId: varchar('playback_id', { length: 64 }).notNull().unique(),
  metadata: json('metadata'),
  customMetadata: json('custom_metadata'),
  description: text('description'),
  publicSettings: json('public_settings'),
  customThumbnailKey: varchar('custom_thumbnail_key', { length: 512 }),
  durationSec: int('duration_sec'),
  /** Source + every rendition + thumbnails + AI outputs, in bytes. Written by the worker at job end. */
  storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),
  errorMessage: varchar('error_message', { length: 1024 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => ({
  statusIdx: index('idx_assets_status').on(table.status),
  orgIdIdx: index('idx_assets_org_id').on(table.orgId),
}));

export const renditions = mysqlTable('renditions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  assetId: varchar('asset_id', { length: 36 }).notNull().references(() => assets.id, { onDelete: 'cascade' }),
  quality: varchar('quality', { length: 32 }).notNull(),
  width: int('width').notNull(),
  height: int('height').notNull(),
  bitrateKbps: int('bitrate_kbps').notNull(),
  fileSizeBytes: bigint('file_size_bytes', { mode: 'number' }),
  codec: varchar('codec', { length: 32 }).notNull().default('h264'),
  playlistPath: varchar('playlist_path', { length: 1024 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  assetIdIdx: index('idx_renditions_asset_id').on(table.assetId),
  // One row per quality per asset — re-processing replaces rather than appends.
  assetQualityUnique: uniqueIndex('uq_renditions_asset_quality').on(table.assetId, table.quality),
}));

export const jobs = mysqlTable('jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  assetId: varchar('asset_id', { length: 36 }).notNull().references(() => assets.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 32 }).notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  currentStep: varchar('current_step', { length: 64 }),
  attempts: int('attempts').notNull().default(0),
  errorMessage: varchar('error_message', { length: 1024 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => ({
  assetIdIdx: index('idx_jobs_asset_id').on(table.assetId),
  statusIdx: index('idx_jobs_status').on(table.status),
}));

/* ─── AI Processing tables ───────────────────────────────── */

export const aiJobs = mysqlTable('ai_jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  assetId: varchar('asset_id', { length: 36 }).notNull().references(() => assets.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 32 }).notNull().default('queued'),
  transcriptionStatus: varchar('transcription_status', { length: 32 }).notNull().default('pending'),
  subtitlesStatus: varchar('subtitles_status', { length: 32 }).notNull().default('pending'),
  chaptersStatus: varchar('chapters_status', { length: 32 }).notNull().default('pending'),
  transcriptPath: varchar('transcript_path', { length: 1024 }),
  subtitlesPath: varchar('subtitles_path', { length: 1024 }),
  chaptersPath: varchar('chapters_path', { length: 1024 }),
  language: varchar('language', { length: 16 }),
  errorMessage: varchar('error_message', { length: 1024 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => ({
  assetIdIdx: index('idx_ai_jobs_asset_id').on(table.assetId),
}));

/* ─── Analytics tables ───────────────────────────────────── */

/**
 * One row per playback session (the client session id is the primary key).
 * Written exclusively by the ingestion upsert in apps/api/src/services/analytics.ts;
 * every analytics number is derived from this table over the requested period.
 * Timestamps are stored in UTC (the mysql2 pool is pinned to `timezone: 'Z'`).
 */
export const playbackSessions = mysqlTable('playback_sessions', {
  id: varchar('id', { length: 40 }).primaryKey(),
  assetId: varchar('asset_id', { length: 36 }).notNull().references(() => assets.id, { onDelete: 'cascade' }),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  playbackId: varchar('playback_id', { length: 64 }).notNull(),
  /** Per-browser id (localStorage) — distinct viewers are counted on it. */
  viewerId: varchar('viewer_id', { length: 40 }),
  playerType: varchar('player_type', { length: 16 }),
  deviceType: varchar('device_type', { length: 16 }),
  country: varchar('country', { length: 8 }),
  referrer: varchar('referrer', { length: 512 }),
  userAgent: varchar('user_agent', { length: 256 }),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at').notNull().defaultNow(),
  /** Seconds actually played (wall-clock while playing, paused/hidden time excluded). */
  watchedSec: int('watched_sec').notNull().default(0),
  /** Furthest playhead position reached, in seconds. */
  maxPositionSec: int('max_position_sec').notNull().default(0),
  durationSec: int('duration_sec'),
  /** Last known rendition height (e.g. 720). */
  qualityHeight: int('quality_height'),
  qualityChanges: int('quality_changes').notNull().default(0),
  bufferCount: int('buffer_count').notNull().default(0),
  bufferMs: int('buffer_ms').notNull().default(0),
  errorCount: int('error_count').notNull().default(0),
  seekCount: int('seek_count').notNull().default(0),
  pauseCount: int('pause_count').notNull().default(0),
  /** 1 once max_position_sec >= 90% of duration_sec. */
  completed: tinyint('completed').notNull().default(0),
  lastError: varchar('last_error', { length: 255 }),
}, (table) => ({
  assetStartedIdx: index('idx_playback_sessions_asset_started').on(table.assetId, table.startedAt),
  orgStartedIdx: index('idx_playback_sessions_org_started').on(table.orgId, table.startedAt),
  viewerIdx: index('idx_playback_sessions_viewer').on(table.viewerId),
}));

/* ─── Platform Settings table ────────────────────────────── */

export const settings = mysqlTable('settings', {
  id: varchar('id', { length: 36 }).primaryKey(),
  orgId: varchar('org_id', { length: 36 }).references(() => organizations.id, { onDelete: 'cascade' }),
  primaryColor: varchar('primary_color', { length: 7 }).notNull().default('#4f46e5'),
  theme: varchar('theme', { length: 8 }).notNull().default('dark'),
  logoKey: varchar('logo_key', { length: 512 }),
  aiAutoTranscribe: varchar('ai_auto_transcribe', { length: 5 }).notNull().default('true'),
  aiAutoChapter: varchar('ai_auto_chapter', { length: 5 }).notNull().default('true'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => ({
  orgIdIdx: index('idx_settings_org_id').on(table.orgId),
}));

/* ─── Comments table ────────────────────────────────────── */

export const comments = mysqlTable('comments', {
  id: varchar('id', { length: 36 }).primaryKey(),
  assetId: varchar('asset_id', { length: 36 }).notNull().references(() => assets.id, { onDelete: 'cascade' }),
  playbackId: varchar('playback_id', { length: 64 }).notNull(),
  authorName: varchar('author_name', { length: 100 }).notNull(),
  authorEmail: varchar('author_email', { length: 255 }).notNull(),
  body: varchar('body', { length: 2000 }).notNull(),
  timestampSec: int('timestamp_sec'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  playbackIdIdx: index('idx_comments_playback_id').on(table.playbackId),
  assetIdIdx: index('idx_comments_asset_id').on(table.assetId),
  createdAtIdx: index('idx_comments_created_at').on(table.createdAt),
}));

/* ─── Reactions table ──────────────────────────────────── */

export const reactions = mysqlTable('reactions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  assetId: varchar('asset_id', { length: 36 }).notNull().references(() => assets.id, { onDelete: 'cascade' }),
  playbackId: varchar('playback_id', { length: 64 }).notNull(),
  emoji: varchar('emoji', { length: 20 }).notNull(),
  sessionId: varchar('session_id', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  playbackEmojiIdx: index('idx_reactions_playback_emoji').on(table.playbackId, table.emoji),
  assetIdIdx: index('idx_reactions_asset_id').on(table.assetId),
}));

/* ─── Auth & Organization tables ─────────────────────────── */

export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  /** Bumped on password change / "sign out everywhere" — access tokens carrying an older value are rejected. */
  tokenVersion: int('token_version').notNull().default(0),
  /** Set at subscription activation (cloud) — no separate verification email. */
  emailVerifiedAt: timestamp('email_verified_at'),
  name: varchar('name', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export const organizations = mysqlTable('organizations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  ownerId: varchar('owner_id', { length: 36 }).notNull().references(() => users.id),
  /** `pro` | `business` (cloud) — NULL for self-host installs. */
  plan: varchar('plan', { length: 32 }),
  /** Stripe subscription status, verbatim (`active`, `trialing`, `past_due`, `canceled`, …). NULL = no subscription. */
  subscriptionStatus: varchar('subscription_status', { length: 32 }),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
  stripePriceId: varchar('stripe_price_id', { length: 255 }),
  currentPeriodEnd: timestamp('current_period_end'),
  cancelAtPeriodEnd: tinyint('cancel_at_period_end').notNull().default(0),
  /** Set the first time `past_due` is seen (now + GRACE_DAYS); cleared once the subscription recovers. */
  graceUntil: timestamp('grace_until'),
  /** First time the subscription became active / trialing. */
  activatedAt: timestamp('activated_at'),
  webhookUrl: varchar('webhook_url', { length: 2048 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
});

export const orgMembers = mysqlTable('org_members', {
  id: varchar('id', { length: 36 }).primaryKey(),
  orgId: varchar('org_id', { length: 36 }).notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 32 }).notNull().default('member'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index('idx_org_members_org_id').on(table.orgId),
  userIdIdx: index('idx_org_members_user_id').on(table.userId),
}));

export const apiKeys = mysqlTable('api_keys', {
  id: varchar('id', { length: 36 }).primaryKey(),
  orgId: varchar('org_id', { length: 36 }).notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
  keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
  /** User who created the key — their keys are revoked when they leave the org. */
  createdBy: varchar('created_by', { length: 36 }),
  /** NULL = never expires. */
  expiresAt: timestamp('expires_at'),
  /** NULL = full access. `["read"]` = GET only, `["read","write"]` = full access. */
  scopes: json('scopes').$type<string[] | null>(),
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index('idx_api_keys_org_id').on(table.orgId),
  createdByIdx: index('idx_ak_created_by').on(table.createdBy),
}));

/* ─── Cloud: billing, usage, invitations, password resets ── */

/** Processed Stripe webhook events — `INSERT IGNORE` on the event id dedupes retries. */
export const stripeEvents = mysqlTable('stripe_events', {
  id: varchar('id', { length: 255 }).primaryKey(),
  type: varchar('type', { length: 64 }).notNull(),
  processedAt: timestamp('processed_at').notNull().defaultNow(),
});

/**
 * Per-organization monthly counters (UTC `YYYY-MM`), written by the worker with
 * `INSERT ... ON DUPLICATE KEY UPDATE`. Storage is not here: it is the live
 * `SUM(assets.storage_bytes)` of the org.
 */
export const usageMonthly = mysqlTable('usage_monthly', {
  orgId: varchar('org_id', { length: 36 }).notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  month: char('month', { length: 7 }).notNull(),
  encodingSec: bigint('encoding_sec', { mode: 'number' }).notNull().default(0),
  aiSec: bigint('ai_sec', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.orgId, table.month] }),
}));

export const orgInvitations = mysqlTable('org_invitations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  orgId: varchar('org_id', { length: 36 }).notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 32 }).notNull().default('member'),
  /** sha256 of the raw token that is emailed / shown to the inviter. */
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  invitedBy: varchar('invited_by', { length: 36 }),
  expiresAt: timestamp('expires_at').notNull(),
  acceptedAt: timestamp('accepted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  orgIdIdx: index('idx_org_invitations_org_id').on(table.orgId),
  emailIdx: index('idx_org_invitations_email').on(table.email),
}));

export const passwordResets = mysqlTable('password_resets', {
  id: varchar('id', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** sha256 of the raw token in the reset link. */
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  userIdIdx: index('idx_password_resets_user_id').on(table.userId),
}));
