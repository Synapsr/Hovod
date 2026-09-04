-- 0001_baseline: full Hovod schema as of v0.2.0.
--
-- Fresh installs run this file. Installs created before the migration system
-- existed are repaired in place by `legacyRepair()` (packages/db/src/migrations.ts)
-- and this file is then recorded as applied without being executed, so it MUST
-- contain only CREATE TABLE statements.
--
-- Column order of `assets`, `renditions` and `jobs` reflects the historical
-- `ALTER TABLE ... AFTER ...` additions so fresh and upgraded installs match.

CREATE TABLE `assets` (
  `id` VARCHAR(36) PRIMARY KEY,
  `org_id` VARCHAR(36) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'created',
  `source_type` VARCHAR(32) NOT NULL DEFAULT 'upload',
  `source_key` VARCHAR(512) NULL,
  `source_url` VARCHAR(2048) NULL,
  `title` VARCHAR(255) NOT NULL,
  `playback_id` VARCHAR(64) NOT NULL UNIQUE,
  `metadata` JSON NULL,
  `description` TEXT NULL,
  `public_settings` JSON NULL,
  `custom_thumbnail_key` VARCHAR(512) NULL,
  `custom_metadata` JSON NULL,
  `duration_sec` INT NULL,
  `error_message` VARCHAR(1024) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_assets_status` (`status`),
  INDEX `idx_assets_org_id` (`org_id`)
);
-- >statement-breakpoint
CREATE TABLE `renditions` (
  `id` VARCHAR(36) PRIMARY KEY,
  `asset_id` VARCHAR(36) NOT NULL,
  `quality` VARCHAR(32) NOT NULL,
  `width` INT NOT NULL,
  `height` INT NOT NULL,
  `bitrate_kbps` INT NOT NULL,
  `file_size_bytes` BIGINT NULL,
  `codec` VARCHAR(32) NOT NULL DEFAULT 'h264',
  `playlist_path` VARCHAR(1024) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_renditions_asset_id` (`asset_id`),
  CONSTRAINT `fk_renditions_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
CREATE TABLE `jobs` (
  `id` VARCHAR(36) PRIMARY KEY,
  `asset_id` VARCHAR(36) NOT NULL,
  `type` VARCHAR(32) NOT NULL,
  `status` VARCHAR(32) NOT NULL,
  `current_step` VARCHAR(64) NULL,
  `attempts` INT NOT NULL DEFAULT 0,
  `error_message` VARCHAR(1024) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_jobs_asset_id` (`asset_id`),
  CONSTRAINT `fk_jobs_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
CREATE TABLE `analytics_events` (
  `id` VARCHAR(36) PRIMARY KEY,
  `session_id` VARCHAR(36) NOT NULL,
  `asset_id` VARCHAR(36) NOT NULL,
  `playback_id` VARCHAR(64) NOT NULL,
  `event_type` VARCHAR(32) NOT NULL,
  `current_time` INT NULL,
  `duration` INT NULL,
  `quality_height` INT NULL,
  `buffer_duration_ms` INT NULL,
  `error_message` VARCHAR(512) NULL,
  `user_agent` VARCHAR(512) NULL,
  `country` VARCHAR(8) NULL,
  `device_type` VARCHAR(16) NULL,
  `referrer` VARCHAR(2048) NULL,
  `player_type` VARCHAR(16) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_ae_asset_id` (`asset_id`),
  INDEX `idx_ae_session_id` (`session_id`),
  INDEX `idx_ae_created_at` (`created_at`),
  INDEX `idx_ae_event_type` (`event_type`),
  INDEX `idx_ae_asset_event` (`asset_id`, `event_type`, `created_at`)
);
-- >statement-breakpoint
CREATE TABLE `analytics_daily` (
  `id` VARCHAR(36) PRIMARY KEY,
  `asset_id` VARCHAR(36) NOT NULL,
  `date` VARCHAR(10) NOT NULL,
  `hour` INT NULL,
  `view_count` INT NOT NULL DEFAULT 0,
  `unique_sessions` INT NOT NULL DEFAULT 0,
  `total_watch_time_sec` INT NOT NULL DEFAULT 0,
  `quality_distribution` JSON NULL,
  `device_distribution` JSON NULL,
  `buffer_count` INT NOT NULL DEFAULT 0,
  `total_buffer_ms` INT NOT NULL DEFAULT 0,
  `error_count` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX `idx_ad_asset_date_hour` (`asset_id`, `date`, `hour`),
  INDEX `idx_ad_date` (`date`),
  INDEX `idx_ad_asset_id` (`asset_id`)
);
-- >statement-breakpoint
CREATE TABLE `analytics_asset_stats` (
  `asset_id` VARCHAR(36) PRIMARY KEY,
  `total_views` INT NOT NULL DEFAULT 0,
  `total_unique_sessions` INT NOT NULL DEFAULT 0,
  `total_watch_time_sec` INT NOT NULL DEFAULT 0,
  `avg_watch_percent` INT NOT NULL DEFAULT 0,
  `engagement_score` INT NOT NULL DEFAULT 0,
  `retention_curve` JSON NULL,
  `peak_hour` INT NULL,
  `quality_distribution` JSON NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
-- >statement-breakpoint
CREATE TABLE `ai_jobs` (
  `id` VARCHAR(36) PRIMARY KEY,
  `asset_id` VARCHAR(36) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
  `transcription_status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `subtitles_status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `chapters_status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `transcript_path` VARCHAR(1024) NULL,
  `subtitles_path` VARCHAR(1024) NULL,
  `chapters_path` VARCHAR(1024) NULL,
  `language` VARCHAR(16) NULL,
  `error_message` VARCHAR(1024) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_ai_jobs_asset_id` (`asset_id`),
  INDEX `idx_ai_jobs_status` (`status`),
  CONSTRAINT `fk_ai_jobs_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
CREATE TABLE `users` (
  `id` VARCHAR(36) PRIMARY KEY,
  `email` VARCHAR(255) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `name` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_users_email` (`email`)
);
-- >statement-breakpoint
CREATE TABLE `organizations` (
  `id` VARCHAR(36) PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(100) NOT NULL UNIQUE,
  `owner_id` VARCHAR(36) NOT NULL,
  `tier` VARCHAR(32) NOT NULL DEFAULT 'free',
  `stripe_customer_id` VARCHAR(255) NULL,
  `stripe_subscription_id` VARCHAR(255) NULL,
  `webhook_url` VARCHAR(2048) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_orgs_owner` (`owner_id`),
  INDEX `idx_orgs_stripe` (`stripe_customer_id`),
  CONSTRAINT `fk_orgs_owner` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`)
);
-- >statement-breakpoint
CREATE TABLE `org_members` (
  `id` VARCHAR(36) PRIMARY KEY,
  `org_id` VARCHAR(36) NOT NULL,
  `user_id` VARCHAR(36) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'member',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX `idx_om_org_user` (`org_id`, `user_id`),
  INDEX `idx_om_user` (`user_id`),
  CONSTRAINT `fk_om_org` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_om_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
CREATE TABLE `api_keys` (
  `id` VARCHAR(36) PRIMARY KEY,
  `org_id` VARCHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `key_hash` VARCHAR(64) NOT NULL UNIQUE,
  `key_prefix` VARCHAR(12) NOT NULL,
  `last_used_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_ak_org` (`org_id`),
  INDEX `idx_ak_hash` (`key_hash`),
  CONSTRAINT `fk_ak_org` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
CREATE TABLE `settings` (
  `id` VARCHAR(36) PRIMARY KEY,
  `org_id` VARCHAR(36) NULL,
  `primary_color` VARCHAR(7) NOT NULL DEFAULT '#4f46e5',
  `theme` VARCHAR(8) NOT NULL DEFAULT 'dark',
  `logo_key` VARCHAR(512) NULL,
  `ai_auto_transcribe` VARCHAR(5) NOT NULL DEFAULT 'true',
  `ai_auto_chapter` VARCHAR(5) NOT NULL DEFAULT 'true',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_settings_org_id` (`org_id`),
  UNIQUE INDEX `idx_settings_org_unique` (`org_id`),
  CONSTRAINT `fk_settings_org` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
CREATE TABLE `comments` (
  `id` VARCHAR(36) PRIMARY KEY,
  `asset_id` VARCHAR(36) NOT NULL,
  `playback_id` VARCHAR(64) NOT NULL,
  `author_name` VARCHAR(100) NOT NULL,
  `author_email` VARCHAR(255) NOT NULL,
  `body` VARCHAR(2000) NOT NULL,
  `timestamp_sec` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_comments_playback_id` (`playback_id`),
  INDEX `idx_comments_asset_id` (`asset_id`),
  INDEX `idx_comments_created_at` (`created_at`),
  CONSTRAINT `fk_comments_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
CREATE TABLE `reactions` (
  `id` VARCHAR(36) PRIMARY KEY,
  `asset_id` VARCHAR(36) NOT NULL,
  `playback_id` VARCHAR(64) NOT NULL,
  `emoji` VARCHAR(20) NOT NULL,
  `session_id` VARCHAR(64) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_reactions_playback_emoji` (`playback_id`, `emoji`),
  INDEX `idx_reactions_asset_id` (`asset_id`),
  CONSTRAINT `fk_reactions_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE CASCADE
);
