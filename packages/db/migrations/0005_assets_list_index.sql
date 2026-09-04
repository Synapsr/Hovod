-- Composite index matching the asset list's keyset pagination.
--
-- `GET /v1/assets` filters on org_id and orders by (created_at DESC, id DESC).
-- With only `idx_assets_org_id (org_id)` MySQL resolves the org predicate from
-- the index but sorts the whole tenant's rows in a filesort on every page — the
-- dashboard polls that endpoint, so it is the hottest query in the product.
-- Reported by @leuwenn in PR #3.
--
-- The index is created only when it does not already exist: MySQL 8 and
-- MariaDB 10.11 both lack `CREATE INDEX IF NOT EXISTS` for this form, and the
-- migration must stay safe to re-run.
SET @exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assets' AND INDEX_NAME = 'idx_assets_org_created'
);
-- >statement-breakpoint
SET @stmt := IF(@exists = 0,
  'ALTER TABLE `assets` ADD INDEX `idx_assets_org_created` (`org_id`, `created_at`, `id`)',
  'DO 0');
-- >statement-breakpoint
PREPARE add_index FROM @stmt;
-- >statement-breakpoint
EXECUTE add_index;
-- >statement-breakpoint
DEALLOCATE PREPARE add_index;
