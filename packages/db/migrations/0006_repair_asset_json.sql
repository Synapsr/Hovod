-- Older mysql2 writes stored object documents as JSON string scalars.
-- Repair only strings containing a valid JSON object, keeping existing objects,
-- arrays, primitive values and invalid inner text unchanged. The CASE guards
-- ensure JSON_TYPE never receives invalid JSON, on MySQL and MariaDB alike.
-- Once repaired, the value is an object and subsequent runs are a no-op.
-- Keep updated_at: this storage repair is not a user edit.
-- Reported by @leuwenn in PR #3.
UPDATE `assets`
SET `metadata` = JSON_UNQUOTE(`metadata`), `updated_at` = `updated_at`
WHERE CASE
  WHEN JSON_VALID(`metadata`) THEN CASE
    WHEN JSON_TYPE(`metadata`) = 'STRING' THEN CASE
      WHEN JSON_VALID(JSON_UNQUOTE(`metadata`)) THEN JSON_TYPE(JSON_UNQUOTE(`metadata`)) = 'OBJECT'
      ELSE FALSE
    END
    ELSE FALSE
  END
  ELSE FALSE
END;
-- >statement-breakpoint
UPDATE `assets`
SET `custom_metadata` = JSON_UNQUOTE(`custom_metadata`), `updated_at` = `updated_at`
WHERE CASE
  WHEN JSON_VALID(`custom_metadata`) THEN CASE
    WHEN JSON_TYPE(`custom_metadata`) = 'STRING' THEN CASE
      WHEN JSON_VALID(JSON_UNQUOTE(`custom_metadata`)) THEN JSON_TYPE(JSON_UNQUOTE(`custom_metadata`)) = 'OBJECT'
      ELSE FALSE
    END
    ELSE FALSE
  END
  ELSE FALSE
END;
