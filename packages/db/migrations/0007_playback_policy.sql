-- Per-asset playback policy.
--
-- `public` (default, every existing asset): playback files live under
-- `playback/{assetId}/`, a prefix the bucket serves anonymously.
-- `signed`: files live under `private/{assetId}/`, which is never public; the
-- API checks a playback token, serves the playlists itself and rewrites every
-- segment / thumbnail / text-track reference to a short-lived presigned URL.
ALTER TABLE `assets` ADD COLUMN `playback_policy` VARCHAR(16) NOT NULL DEFAULT 'public' AFTER `playback_id`;
