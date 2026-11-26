/**
 * Private playback: playback tokens, presigned URLs, playlist rewriting and the
 * storage move that follows a playback-policy change.
 *
 * A `signed` asset keeps its files under `private/{assetId}/`, a prefix the
 * bucket never serves anonymously. Viewers reach it only through the API:
 *
 *   /v1/playback/:pid/master.m3u8?token=…        master, variant URIs carry the token
 *   /v1/playback/:pid/:rendition/index.m3u8?…     media playlist, segments → presigned S3 GETs
 *   /v1/playback/:pid/thumbnails.vtt?token=…      sprite references → presigned S3 GETs
 *
 * Only the small text files pass through the API; segments go straight from S3.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assets,
  aiJobs,
  ASSET_STATUS,
  AI_JOB_STATUS,
  PLAYBACK_POLICY,
  PLAYBACK_TOKEN,
  S3_PATHS,
  playbackStoragePrefix,
  type PlaybackPolicy,
} from '@hovod/db';
import { db, pool } from '../db.js';
import { env, appUrl, playbackTokenSecret } from '../env.js';
import { s3Client, s3PublicClient } from '../s3.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';
import { identifyOrgOnPublicRoute } from '../middleware/auth.js';

export type AssetRow = typeof assets.$inferSelect;

/** The columns URL building needs — list endpoints select a subset of the row. */
export type AssetLocation = Pick<AssetRow, 'id' | 'status' | 'customThumbnailKey' | 'playbackPolicy'>;

export const PLAYBACK_ERROR = {
  TOKEN_REQUIRED: 'playback_token_required',
  TOKEN_INVALID: 'playback_token_invalid',
} as const;

export function isSigned(asset: Pick<AssetRow, 'playbackPolicy'>): boolean {
  return asset.playbackPolicy === PLAYBACK_POLICY.SIGNED;
}

/* ─── Playback tokens (HS256) ────────────────────────────── */

interface PlaybackTokenPayload {
  /** Fixed marker: a token signed for anything else never verifies here. */
  typ: 'playback';
  /** Playback id the token unlocks. */
  sub: string;
  iat: number;
  exp: number;
}

const TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const MAX_TOKEN_LENGTH = 1024;

function hmac(data: string): string {
  return createHmac('sha256', playbackTokenSecret).update(data).digest('base64url');
}

/** Mint a token that unlocks one playback id until `expiresAt`. */
export function signPlaybackToken(playbackId: string, ttlSec: number = PLAYBACK_TOKEN.DEFAULT_TTL_SEC): { token: string; expiresAt: Date } {
  const ttl = Math.min(PLAYBACK_TOKEN.MAX_TTL_SEC, Math.max(PLAYBACK_TOKEN.MIN_TTL_SEC, Math.floor(ttlSec)));
  const iat = Math.floor(Date.now() / 1000);
  const payload: PlaybackTokenPayload = { typ: 'playback', sub: playbackId, iat, exp: iat + ttl };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${TOKEN_HEADER}.${body}`;
  return { token: `${data}.${hmac(data)}`, expiresAt: new Date(payload.exp * 1000) };
}

/** True when `token` is a valid, unexpired token for exactly this playback id. */
export function verifyPlaybackToken(token: string, playbackId: string): boolean {
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [header, body, signature] = parts as [string, string, string];
  const expected = Buffer.from(hmac(`${header}.${body}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<PlaybackTokenPayload>;
    return payload.typ === 'playback'
      && payload.sub === playbackId
      && typeof payload.exp === 'number'
      && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/** Token sent by the viewer: `?token=` (players) or the `X-Playback-Token` header. */
function tokenFrom(request: FastifyRequest): string | undefined {
  const query = request.query as Record<string, unknown> | undefined;
  const fromQuery = typeof query?.token === 'string' ? query.token : undefined;
  const header = request.headers['x-playback-token'];
  return fromQuery || (typeof header === 'string' ? header : undefined) || undefined;
}

/* ─── Access resolution ──────────────────────────────────── */

export interface PlaybackAccess {
  asset: AssetRow;
  /** Token to propagate into URLs — null for public assets. */
  token: string | null;
  /** The caller is a member (session or API key) of the owning org. */
  isOwner: boolean;
}

/**
 * Resolve a public playback id to a READY asset the caller may play.
 *
 * Public assets: anyone. Signed assets: a valid playback token for this id, or
 * a credential of the owning org (a short-lived token is then minted so the
 * player's follow-up requests — playlists, comments — carry one).
 */
export async function resolvePlayback(request: FastifyRequest, playbackId: string): Promise<PlaybackAccess> {
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.playbackId, playbackId), eq(assets.status, ASSET_STATUS.READY)))
    .limit(1);
  if (!asset) throw new NotFoundError('Playback not found');

  const callerOrg = await identifyOrgOnPublicRoute(request);
  const isOwner = !!callerOrg && callerOrg === asset.orgId;

  if (!isSigned(asset)) return { asset, token: null, isOwner };

  const given = tokenFrom(request);
  if (given && verifyPlaybackToken(given, playbackId)) return { asset, token: given, isOwner };
  if (isOwner) return { asset, token: signPlaybackToken(playbackId).token, isOwner };

  if (given) throw new AppError(403, 'Playback token is invalid or expired', PLAYBACK_ERROR.TOKEN_INVALID);
  throw new AppError(403, 'This video is private — a playback token is required', PLAYBACK_ERROR.TOKEN_REQUIRED);
}

/* ─── Presigned URLs ─────────────────────────────────────── */

/**
 * Presigned URLs are signed for a time *window*, not "now": every viewer inside
 * the same 15-minute window gets byte-identical URLs, so browsers and CDNs can
 * cache them, and a rewritten media playlist can be cached and shared.
 */
const SIGNING_WINDOW_SEC = 15 * 60;

function signingWindowStart(now = Date.now()): number {
  return Math.floor(now / 1000 / SIGNING_WINDOW_SEC) * SIGNING_WINDOW_SEC;
}

/** Presigned GET for a private object, valid for at least PLAYBACK_URL_TTL_SEC. */
export async function presignGet(key: string, windowStart = signingWindowStart()): Promise<string> {
  return getSignedUrl(
    s3PublicClient,
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    { signingDate: new Date(windowStart * 1000), expiresIn: env.PLAYBACK_URL_TTL_SEC + SIGNING_WINDOW_SEC },
  );
}

/** Browser URL of a file under the asset's playback prefix (`relPath` like `ai/subtitles.vtt`). */
export async function playbackFileUrl(asset: Pick<AssetRow, 'id' | 'playbackPolicy'>, relPath: string): Promise<string> {
  const key = `${playbackStoragePrefix(asset.id, asset.playbackPolicy)}/${relPath}`;
  return isSigned(asset) ? presignGet(key) : `${env.S3_PUBLIC_BASE_URL}/${key}`;
}

/** Poster / list thumbnail: custom upload first, auto-generated frame once READY. */
export async function thumbnailUrlFor(asset: AssetLocation): Promise<string | null> {
  if (asset.customThumbnailKey) {
    return isSigned(asset) ? presignGet(asset.customThumbnailKey) : `${env.S3_PUBLIC_BASE_URL}/${asset.customThumbnailKey}`;
  }
  if (asset.status !== ASSET_STATUS.READY) return null;
  return playbackFileUrl(asset, S3_PATHS.THUMBNAIL);
}

/** URLs a player needs. Signed assets route through the API with the token attached. */
export function playbackUrls(asset: Pick<AssetRow, 'id' | 'playbackId' | 'playbackPolicy'>, token: string | null) {
  const embedUrl = `${appUrl}/embed/${asset.playbackId}`;
  if (!isSigned(asset)) {
    const base = `${env.S3_PUBLIC_BASE_URL}/${playbackStoragePrefix(asset.id, asset.playbackPolicy)}`;
    return {
      assetId: asset.id,
      playbackId: asset.playbackId,
      playbackPolicy: asset.playbackPolicy,
      manifestUrl: `${base}/${S3_PATHS.MASTER_PLAYLIST}`,
      thumbnailVttUrl: `${base}/${S3_PATHS.THUMBNAILS_VTT}`,
      playerUrl: embedUrl,
      playbackToken: null,
    };
  }
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const api = `${appUrl}/v1/playback/${asset.playbackId}`;
  return {
    assetId: asset.id,
    playbackId: asset.playbackId,
    playbackPolicy: asset.playbackPolicy,
    manifestUrl: `${api}/${S3_PATHS.MASTER_PLAYLIST}${q}`,
    thumbnailVttUrl: `${api}/thumbnails.vtt${q}`,
    playerUrl: `${embedUrl}${q}`,
    playbackToken: token,
  };
}

/* ─── Playlist rewriting ─────────────────────────────────── */

/** `720p` — the rendition directories the worker writes. */
export const RENDITION_RE = /^[a-z0-9]{1,16}$/i;
/** A bare file name inside a rendition / thumbnails directory. */
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VARIANT_URI_RE = /^([a-z0-9]{1,16})\/index\.m3u8$/i;

/** Apply `map` to every URI of a playlist: plain URI lines and `URI="…"` tag attributes. */
async function mapPlaylistUris(text: string, map: (uri: string) => Promise<string | null>): Promise<string> {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { out.push(line); continue; }
    if (trimmed.startsWith('#')) {
      const match = /URI="([^"]*)"/.exec(trimmed);
      if (!match) { out.push(line); continue; }
      const mapped = await map(match[1]!);
      out.push(mapped === null ? line : trimmed.replace(match[0], `URI="${mapped}"`));
      continue;
    }
    const mapped = await map(trimmed);
    if (mapped !== null) out.push(mapped);
  }
  return out.join('\n');
}

/** Master playlist: variant URIs stay relative (→ this API) and carry the token. */
export function rewriteMasterPlaylist(text: string, token: string | null): Promise<string> {
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  // Anything but `<rendition>/index.m3u8` is dropped rather than proxied blindly.
  return mapPlaylistUris(text, async (uri) => (VARIANT_URI_RE.test(uri) ? `${uri}${q}` : null));
}

/** Media playlist: every segment / init-section URI → presigned S3 URL. */
export function rewriteMediaPlaylist(text: string, dirKey: string, windowStart: number): Promise<string> {
  return mapPlaylistUris(text, async (uri) => (FILE_NAME_RE.test(uri) ? presignGet(`${dirKey}/${uri}`, windowStart) : null));
}

/** Thumbnail map: `sprite.jpg#xywh=…` → presigned sprite URL with the same fragment. */
export async function rewriteThumbnailVtt(text: string, dirKey: string, windowStart: number): Promise<string> {
  const signed = new Map<string, string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const hash = line.indexOf('#xywh=');
    const file = hash > 0 ? line.slice(0, hash).trim() : '';
    if (!file || !FILE_NAME_RE.test(file)) { out.push(line); continue; }
    let url = signed.get(file);
    if (!url) {
      url = await presignGet(`${dirKey}/${file}`, windowStart);
      signed.set(file, url);
    }
    out.push(`${url}${line.slice(hash)}`);
  }
  return out.join('\n');
}

/* ─── Rewritten-file cache ───────────────────────────────── */

/**
 * Media playlists and thumbnail maps do not depend on the viewer (no token in
 * them), only on the asset version and the signing window — one rewrite per
 * window serves every viewer, so a long playlist is presigned once, not per play.
 */
const CACHE_MAX_ENTRIES = 500;
const textCache = new Map<string, { value: string; expiresAt: number }>();

function cacheGet(key: string): string | undefined {
  const hit = textCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) { textCache.delete(key); return undefined; }
  return hit.value;
}

function cacheSet(key: string, value: string, ttlMs: number): void {
  if (textCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = textCache.keys().next().value;
    if (oldest !== undefined) textCache.delete(oldest);
  }
  textCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Drop every cached rewrite of an asset (policy change, delete). */
export function invalidatePlaybackCache(assetId: string): void {
  for (const key of textCache.keys()) if (key.startsWith(`${assetId}|`)) textCache.delete(key);
}

async function readObjectText(key: string): Promise<string> {
  try {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return (await res.Body?.transformToString('utf-8')) ?? '';
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (err as Error).name === 'NoSuchKey') throw new NotFoundError('Playlist not found');
    throw err;
  }
}

/**
 * Read a text file of the asset and rewrite it, through the cache. The cache
 * key includes `updatedAt` so a re-encode never serves the previous version.
 */
export async function cachedRewrite(
  asset: Pick<AssetRow, 'id' | 'playbackPolicy' | 'updatedAt'>,
  relPath: string,
  rewrite: (text: string, dirKey: string, windowStart: number) => Promise<string>,
): Promise<string> {
  const windowStart = signingWindowStart();
  const prefix = playbackStoragePrefix(asset.id, asset.playbackPolicy);
  const cacheKey = `${asset.id}|${asset.updatedAt.getTime()}|${relPath}|${windowStart}`;
  const hit = cacheGet(cacheKey);
  if (hit !== undefined) return hit;

  const key = `${prefix}/${relPath}`;
  const dirKey = key.slice(0, key.lastIndexOf('/'));
  const value = await rewrite(await readObjectText(key), dirKey, windowStart);
  const remainingMs = (windowStart + SIGNING_WINDOW_SEC) * 1000 - Date.now();
  cacheSet(cacheKey, value, Math.max(1_000, remainingMs));
  return value;
}

/** The master playlist depends on the viewer's token, so only its raw text is cached (60 s). */
export async function masterPlaylistFor(asset: Pick<AssetRow, 'id' | 'playbackPolicy' | 'updatedAt'>, token: string | null): Promise<string> {
  const cacheKey = `${asset.id}|${asset.updatedAt.getTime()}|raw-master`;
  let raw = cacheGet(cacheKey);
  if (raw === undefined) {
    raw = await readObjectText(`${playbackStoragePrefix(asset.id, asset.playbackPolicy)}/${S3_PATHS.MASTER_PLAYLIST}`);
    cacheSet(cacheKey, raw, 60_000);
  }
  return rewriteMasterPlaylist(raw, token);
}

/* ─── Object ACL for API-side writes ─────────────────────── */

/**
 * ACL for an object the API writes under an asset's playback prefix (transcript,
 * chapters, custom thumbnail). Public-read only for public assets on buckets
 * that use ACLs; never for signed assets.
 */
export function objectAclFor(asset: Pick<AssetRow, 'playbackPolicy'>): { ACL?: 'public-read' } {
  return env.S3_PUBLIC_ACL && !isSigned(asset) ? { ACL: 'public-read' } : {};
}

/* ─── Policy change (storage move) ───────────────────────── */

const MOVE_CONCURRENCY = 16;

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3Client.send(new ListObjectsV2Command({
      Bucket: env.S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of page.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/** Delete every object under `prefix` (must end with `/`). */
export async function deletePrefix(prefix: string): Promise<number> {
  const keys = await listKeys(prefix);
  for (let i = 0; i < keys.length; i += 1000) {
    await s3Client.send(new DeleteObjectsCommand({
      Bucket: env.S3_BUCKET,
      Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
    }));
  }
  return keys.length;
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** `CopySource` is `bucket/key`, URL-encoded per path segment. */
function copySource(key: string): string {
  return `${env.S3_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Serialise policy changes of one asset across API replicas (MySQL advisory lock). */
async function withAssetLock<T>(assetId: string, fn: () => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  const name = `hovod_playback_policy_${assetId}`;
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, 0) AS ok', [name]);
    if ((rows as Array<{ ok: number | null }>)[0]?.ok !== 1) {
      throw new AppError(409, 'The playback policy of this asset is already being changed');
    }
    try {
      return await fn();
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

/**
 * Switch an asset's playback policy and move its files to the matching prefix.
 *
 * Crash-safe ordering: copy to the new prefix → flip the DB row (readers switch
 * atomically to a complete copy) → delete the old prefix. Re-applying the
 * current policy only finishes that last step, so a PATCH that failed half-way
 * is repaired by sending it again.
 *
 * Refused while a transcode or AI job may still write to the old prefix.
 */
export async function changePlaybackPolicy(assetId: string, orgId: string, target: PlaybackPolicy): Promise<{ policy: PlaybackPolicy; movedObjects: number; removedObjects: number }> {
  return withAssetLock(assetId, async () => {
    const [asset] = await db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.orgId, orgId))).limit(1);
    if (!asset) throw new NotFoundError('Asset not found');

    if (asset.status === ASSET_STATUS.QUEUED || asset.status === ASSET_STATUS.PROCESSING) {
      throw new AppError(409, 'The playback policy cannot change while the asset is being processed');
    }
    const [aiJob] = await db.select({ status: aiJobs.status }).from(aiJobs)
      .where(and(eq(aiJobs.assetId, asset.id), inArray(aiJobs.status, [AI_JOB_STATUS.QUEUED, AI_JOB_STATUS.PROCESSING])))
      .orderBy(desc(aiJobs.createdAt)).limit(1);
    if (aiJob) {
      throw new AppError(409, 'The playback policy cannot change while AI processing is running');
    }

    const source = target === PLAYBACK_POLICY.SIGNED ? PLAYBACK_POLICY.PUBLIC : PLAYBACK_POLICY.SIGNED;
    const fromPrefix = playbackStoragePrefix(asset.id, source);
    const toPrefix = playbackStoragePrefix(asset.id, target);
    const acl = objectAclFor({ playbackPolicy: target });

    let movedObjects = 0;
    if (asset.playbackPolicy !== target) {
      const keys = await listKeys(`${fromPrefix}/`);
      await runPool(keys, MOVE_CONCURRENCY, async (key) => {
        await s3Client.send(new CopyObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: `${toPrefix}${key.slice(fromPrefix.length)}`,
          CopySource: copySource(key),
          ...acl,
        }));
      });
      movedObjects = keys.length;

      const thumbnailKey = asset.customThumbnailKey?.startsWith(`${fromPrefix}/`)
        ? `${toPrefix}${asset.customThumbnailKey.slice(fromPrefix.length)}`
        : asset.customThumbnailKey;
      await db.update(assets)
        .set({ playbackPolicy: target, customThumbnailKey: thumbnailKey })
        .where(eq(assets.id, asset.id));
    }
    invalidatePlaybackCache(asset.id);

    const removedObjects = await deletePrefix(`${fromPrefix}/`);
    return { policy: target, movedObjects, removedObjects };
  });
}
