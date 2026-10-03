import { sql } from 'drizzle-orm';
import { assets, ASSET_STATUS, METADATA_LIMITS, SOURCE_TYPE } from '@hovod/db';
import { z } from 'zod';

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

const LISTABLE_STATUSES = [
  ASSET_STATUS.CREATED,
  ASSET_STATUS.UPLOADED,
  ASSET_STATUS.QUEUED,
  ASSET_STATUS.PROCESSING,
  ASSET_STATUS.READY,
  ASSET_STATUS.ERROR,
] as const;

const listAssetsQuery = z.object({
  q: z.string().trim().max(255).optional(),
  status: z.string().max(1024)
    .transform((value) => [...new Set(value.split(',').map((status) => status.trim()).filter(Boolean))])
    .pipe(z.array(z.enum(LISTABLE_STATUSES)).nonempty())
    .optional(),
  sourceType: z.enum([SOURCE_TYPE.UPLOAD, SOURCE_TYPE.URL]).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
  cursor: z.string().max(512).optional(),
  fields: z.enum(['default', 'full']).optional(),
});

// Keep entries as pairs: metadata keys (including dots and quotes) are literal
// object keys, not JSON paths. The limits match custom-metadata writes.
const metadataFiltersSchema = z.array(z.tuple([
  z.string().min(1).max(METADATA_LIMITS.MAX_KEY_LENGTH),
  z.string().max(METADATA_LIMITS.MAX_VALUE_LENGTH),
])).max(METADATA_LIMITS.MAX_KEYS);

export function parseAssetListQuery(input: Record<string, unknown>) {
  const metadataFilters = metadataFiltersSchema.parse(
    Object.entries(input)
      .filter(([key]) => key.startsWith('metadata.'))
      .map(([key, value]) => [key.slice('metadata.'.length), value]),
  );
  return { ...listAssetsQuery.parse(input), metadataFilters };
}

export type AssetListQuery = ReturnType<typeof parseAssetListQuery>;

export function metadataFilterConditions(filters: AssetListQuery['metadataFilters']) {
  return filters.map(([key, value]) =>
    sql`JSON_CONTAINS(${assets.customMetadata}, JSON_OBJECT(${key}, ${value}))`,
  );
}

/** Filtered lists omit the expensive total count, including metadata-only lists. */
export function hasAssetListFilters(query: AssetListQuery): boolean {
  return !!(query.q || query.status?.length || query.sourceType || query.metadataFilters.length);
}
