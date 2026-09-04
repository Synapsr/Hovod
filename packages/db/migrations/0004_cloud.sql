-- 0004_cloud: Hovod Cloud (paid plans, Stripe as source of truth, usage
-- counters, invitations, password resets).
--
-- 1. `organizations` gains the subscription mirror (`plan`, `subscription_status`,
--    `stripe_price_id`, `current_period_end`, `cancel_at_period_end`,
--    `grace_until`, `activated_at`). The old `tier` column is migrated
--    (`pro`/`business` → `plan`, `free` → NULL) and dropped.
-- 2. `users.email_verified_at` (set at subscription activation).
-- 3. `stripe_events` — webhook idempotency (INSERT IGNORE on the event id).
-- 4. `usage_monthly` — per-org monthly encoding / AI seconds (UTC YYYY-MM).
-- 5. `org_invitations`, `password_resets` — hashed one-time tokens.
-- 6. `assets.storage_bytes` — source + renditions + thumbnails + AI outputs,
--    written by the worker; storage usage is SUM(storage_bytes) per org.
--
-- Self-host installs run this too: every new column is nullable or defaulted
-- and stays unused (no plan, no limits).

ALTER TABLE `organizations`
  ADD COLUMN `plan` VARCHAR(32) NULL AFTER `owner_id`,
  ADD COLUMN `subscription_status` VARCHAR(32) NULL AFTER `plan`,
  ADD COLUMN `stripe_price_id` VARCHAR(255) NULL AFTER `stripe_subscription_id`,
  ADD COLUMN `current_period_end` TIMESTAMP NULL AFTER `stripe_price_id`,
  ADD COLUMN `cancel_at_period_end` TINYINT(1) NOT NULL DEFAULT 0 AFTER `current_period_end`,
  ADD COLUMN `grace_until` TIMESTAMP NULL AFTER `cancel_at_period_end`,
  ADD COLUMN `activated_at` TIMESTAMP NULL AFTER `grace_until`;
-- >statement-breakpoint
-- Data migration: paid tiers become the plan, `free` (and anything else) becomes NULL.
UPDATE `organizations` SET `plan` = `tier` WHERE `tier` IN ('pro', 'business');
-- >statement-breakpoint
-- An org that already carried a Stripe subscription was paying: keep it usable
-- until the first reconcile / webhook overwrites the status from Stripe.
UPDATE `organizations`
   SET `subscription_status` = 'active', `activated_at` = `created_at`
 WHERE `plan` IS NOT NULL AND `stripe_subscription_id` IS NOT NULL;
-- >statement-breakpoint
ALTER TABLE `organizations` DROP COLUMN `tier`;
-- >statement-breakpoint
ALTER TABLE `organizations` ADD INDEX `idx_orgs_stripe_subscription` (`stripe_subscription_id`);
-- >statement-breakpoint
ALTER TABLE `users` ADD COLUMN `email_verified_at` TIMESTAMP NULL AFTER `token_version`;
-- >statement-breakpoint
CREATE TABLE `stripe_events` (
  `id` VARCHAR(255) PRIMARY KEY,
  `type` VARCHAR(64) NOT NULL,
  `processed_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- >statement-breakpoint
CREATE TABLE `usage_monthly` (
  `org_id` VARCHAR(36) NOT NULL,
  `month` CHAR(7) NOT NULL,
  `encoding_sec` BIGINT NOT NULL DEFAULT 0,
  `ai_sec` BIGINT NOT NULL DEFAULT 0,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`org_id`, `month`),
  CONSTRAINT `fk_usage_monthly_org` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
CREATE TABLE `org_invitations` (
  `id` VARCHAR(36) PRIMARY KEY,
  `org_id` VARCHAR(36) NOT NULL,
  `email` VARCHAR(255) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'member',
  `token_hash` VARCHAR(64) NOT NULL UNIQUE,
  `invited_by` VARCHAR(36) NULL,
  `expires_at` TIMESTAMP NOT NULL,
  `accepted_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_org_invitations_org_id` (`org_id`),
  INDEX `idx_org_invitations_email` (`email`),
  CONSTRAINT `fk_org_invitations_org` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
CREATE TABLE `password_resets` (
  `id` VARCHAR(36) PRIMARY KEY,
  `user_id` VARCHAR(36) NOT NULL,
  `token_hash` VARCHAR(64) NOT NULL UNIQUE,
  `expires_at` TIMESTAMP NOT NULL,
  `used_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_password_resets_user_id` (`user_id`),
  CONSTRAINT `fk_password_resets_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
-- >statement-breakpoint
ALTER TABLE `assets` ADD COLUMN `storage_bytes` BIGINT NOT NULL DEFAULT 0 AFTER `duration_sec`;
