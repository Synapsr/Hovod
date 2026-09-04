-- 0003_api_hardening: token invalidation, API key metadata, rendition uniqueness.
--
-- 1. `users.token_version` — bumped on password change / "sign out everywhere";
--    every access token carries the value it was minted with and is rejected on
--    mismatch.
-- 2. `api_keys.created_by` / `expires_at` / `scopes` — ownership, expiry and
--    read-only keys.
-- 3. `renditions` gains UNIQUE (asset_id, quality). Re-processing an asset used
--    to append a second row per quality, so duplicates are removed first,
--    keeping the newest row of each (asset_id, quality) group.

ALTER TABLE `users`
  ADD COLUMN `token_version` INT NOT NULL DEFAULT 0 AFTER `password_hash`;
-- >statement-breakpoint
ALTER TABLE `api_keys`
  ADD COLUMN `created_by` VARCHAR(36) NULL AFTER `key_prefix`,
  ADD COLUMN `expires_at` TIMESTAMP NULL AFTER `created_by`,
  ADD COLUMN `scopes` JSON NULL AFTER `expires_at`;
-- >statement-breakpoint
ALTER TABLE `api_keys` ADD INDEX `idx_ak_created_by` (`created_by`);
-- >statement-breakpoint
-- Drop every rendition that is superseded by a newer row with the same
-- (asset_id, quality). "Newer" = higher created_at, ties broken on id so the
-- statement is deterministic. Multi-table DELETE ... USING a self-join works on
-- both MySQL 8 and MariaDB (a subquery on the same table would not).
DELETE `r`
  FROM `renditions` AS `r`
  INNER JOIN `renditions` AS `keep`
    ON `keep`.`asset_id` = `r`.`asset_id`
   AND `keep`.`quality` = `r`.`quality`
   AND (
        `keep`.`created_at` > `r`.`created_at`
     OR (`keep`.`created_at` = `r`.`created_at` AND `keep`.`id` > `r`.`id`)
   );
-- >statement-breakpoint
ALTER TABLE `renditions`
  ADD UNIQUE KEY `uq_renditions_asset_quality` (`asset_id`, `quality`);
