-- Analytics v1: one row per playback session replaces the raw event log and the
-- hourly/daily aggregation tables. Every metric is computed from this table over
-- the requested period; timestamps are written by the API in UTC.
CREATE TABLE IF NOT EXISTS `playback_sessions` (
  `id` VARCHAR(40) PRIMARY KEY,
  `asset_id` VARCHAR(36) NOT NULL,
  `org_id` VARCHAR(36) NOT NULL,
  `playback_id` VARCHAR(64) NOT NULL,
  `viewer_id` VARCHAR(40) NULL,
  `player_type` VARCHAR(16) NULL,
  `device_type` VARCHAR(16) NULL,
  `country` VARCHAR(8) NULL,
  `referrer` VARCHAR(512) NULL,
  `user_agent` VARCHAR(256) NULL,
  `started_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `watched_sec` INT NOT NULL DEFAULT 0,
  `max_position_sec` INT NOT NULL DEFAULT 0,
  `duration_sec` INT NULL,
  `quality_height` INT NULL,
  `quality_changes` INT NOT NULL DEFAULT 0,
  `buffer_count` INT NOT NULL DEFAULT 0,
  `buffer_ms` INT NOT NULL DEFAULT 0,
  `error_count` INT NOT NULL DEFAULT 0,
  `seek_count` INT NOT NULL DEFAULT 0,
  `pause_count` INT NOT NULL DEFAULT 0,
  `completed` TINYINT(1) NOT NULL DEFAULT 0,
  `last_error` VARCHAR(255) NULL,
  INDEX `idx_playback_sessions_asset_started` (`asset_id`, `started_at`),
  INDEX `idx_playback_sessions_org_started` (`org_id`, `started_at`),
  INDEX `idx_playback_sessions_viewer` (`viewer_id`),
  CONSTRAINT `fk_playback_sessions_asset` FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
-- Import the existing history: one session per client session id. Server-side
-- sessions ('srv-…', the old per-fetch view counter) are dropped. Plain GROUP BY
-- so it runs on MariaDB 10.11 and MySQL 8.4 alike. `org_id` falls back to '' on
-- installs whose assets are not yet attached to an organization
-- (bootstrapDefaultOrg() fixes those rows right after the migrations).
INSERT IGNORE INTO `playback_sessions`
  (`id`, `asset_id`, `org_id`, `playback_id`, `player_type`, `device_type`, `country`, `referrer`, `user_agent`,
   `started_at`, `last_seen_at`, `watched_sec`, `max_position_sec`, `duration_sec`, `quality_height`,
   `quality_changes`, `buffer_count`, `buffer_ms`, `error_count`, `seek_count`, `pause_count`, `completed`, `last_error`)
SELECT
  e.`session_id`,
  MAX(a.`id`),
  COALESCE(MAX(a.`org_id`), ''),
  MAX(e.`playback_id`),
  MAX(e.`player_type`),
  MAX(e.`device_type`),
  MAX(e.`country`),
  LEFT(MAX(e.`referrer`), 512),
  LEFT(MAX(e.`user_agent`), 256),
  MIN(e.`created_at`),
  MAX(e.`created_at`),
  10 * SUM(CASE WHEN e.`event_type` = 'heartbeat' THEN 1 ELSE 0 END),
  COALESCE(MAX(e.`current_time`), 0),
  NULLIF(MAX(e.`duration`), 0),
  MAX(e.`quality_height`),
  SUM(CASE WHEN e.`event_type` = 'quality_change' THEN 1 ELSE 0 END),
  SUM(CASE WHEN e.`event_type` = 'buffer_end' THEN 1 ELSE 0 END),
  COALESCE(SUM(CASE WHEN e.`event_type` = 'buffer_end' THEN e.`buffer_duration_ms` ELSE 0 END), 0),
  SUM(CASE WHEN e.`event_type` = 'error' THEN 1 ELSE 0 END),
  SUM(CASE WHEN e.`event_type` = 'seek' THEN 1 ELSE 0 END),
  SUM(CASE WHEN e.`event_type` = 'pause' THEN 1 ELSE 0 END),
  CASE WHEN MAX(e.`duration`) > 0 AND MAX(e.`current_time`) >= 0.9 * MAX(e.`duration`) THEN 1 ELSE 0 END,
  LEFT(MAX(e.`error_message`), 255)
FROM `analytics_events` e
INNER JOIN `assets` a ON a.`id` = e.`asset_id`
WHERE e.`session_id` NOT LIKE 'srv-%'
GROUP BY e.`session_id`;
-- >statement-breakpoint
DROP TABLE IF EXISTS `analytics_events`;
-- >statement-breakpoint
DROP TABLE IF EXISTS `analytics_daily`;
-- >statement-breakpoint
DROP TABLE IF EXISTS `analytics_asset_stats`;
