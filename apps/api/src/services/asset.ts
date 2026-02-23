import { eq, and, type SQL } from 'drizzle-orm';
import { assets } from '@hovod/db';
import { S3_PATHS } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { NotFoundError } from '../middleware/error-handler.js';

/**
 * Find an asset by ID or throw NotFoundError.
 * When orgId is provided (cloud mode), also verifies the asset belongs to that org.
 */
export async function findAssetOrFail(id: string, orgId?: string) {
  const conditions: SQL[] = [eq(assets.id, id)];
  if (orgId) conditions.push(eq(assets.orgId, orgId));

  const [asset] = await db.select().from(assets).where(and(...conditions)).limit(1);
  if (!asset) throw new NotFoundError('Asset not found');
  return asset;
}

export function getThumbnailUrl(assetId: string, status: string, customThumbnailKey?: string | null): string | null {
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
