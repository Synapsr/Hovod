import { eq, and } from 'drizzle-orm';
import { assets } from '@hovod/db';
import { S3_PATHS } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { NotFoundError } from '../middleware/error-handler.js';

/**
 * Find an asset by ID inside an organization, or throw NotFoundError.
 *
 * `orgId` is mandatory: an optional org scope made it too easy to write an
 * endpoint that reads any tenant's asset by id (the playback-info route did
 * exactly that). A missing org is treated like a missing asset — 404, never a
 * leak of whether the id exists.
 */
export async function findAssetOrFail(id: string, orgId: string | undefined) {
  if (!orgId) throw new NotFoundError('Asset not found');

  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.orgId, orgId)))
    .limit(1);
  if (!asset) throw new NotFoundError('Asset not found');
  return asset;
}

export function getThumbnailUrl(assetId: string, status: string, customThumbnailKey?: string | null): string | null {
  // Custom thumbnails use a unique, per-upload S3 key (custom-thumbnail-{token}.{ext}),
  // so the URL changes on every replacement — no extra cache-busting needed.
  if (customThumbnailKey) return `${env.S3_PUBLIC_BASE_URL}/${customThumbnailKey}`;
  if (status !== 'ready') return null;
  return `${env.S3_PUBLIC_BASE_URL}/${S3_PATHS.PLAYBACK_PREFIX}/${assetId}/${S3_PATHS.THUMBNAIL}`;
}

export function getPlaybackUrls(assetId: string, playbackId: string) {
  const baseUrl = `${env.S3_PUBLIC_BASE_URL}/${S3_PATHS.PLAYBACK_PREFIX}/${assetId}`;
  return {
    assetId,
    playbackId,
    manifestUrl: `${baseUrl}/${S3_PATHS.MASTER_PLAYLIST}`,
    thumbnailVttUrl: `${baseUrl}/${S3_PATHS.THUMBNAILS_VTT}`,
    playerUrl: `${env.DASHBOARD_URL}/embed/${playbackId}`,
  };
}

export function getSourceKey(assetId: string): string {
  return `${S3_PATHS.SOURCES_PREFIX}/${assetId}/input.mp4`;
}

/* ─── Keyset pagination ──────────────────────────────────── */

/** Position in the `(created_at DESC, id DESC)` ordering of a list page. */
export interface AssetCursor {
  /** `created_at` of the last row of the previous page, as an ISO string. */
  createdAt: string;
  /** `id` of that same row — breaks ties between rows sharing a timestamp. */
  id: string;
}

/** Encode a cursor as an opaque base64url token. */
export function encodeCursor(cursor: AssetCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

/** Decode a cursor token. Returns null for anything that is not one we issued. */
export function decodeCursor(token: string): AssetCursor | null {
  if (!token || token.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed as [unknown, unknown];
    if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
    if (!id || id.length > 36) return null;
    const date = new Date(createdAt);
    if (Number.isNaN(date.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Escape the wildcards of a user-supplied LIKE needle.
 *
 * `%`, `_` and the escape character itself become literals, so searching for
 * "100%" no longer matches every title.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
