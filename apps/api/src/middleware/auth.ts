import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { apiKeys, users } from '@hovod/db';
import { env, apiKeySecret } from '../env.js';
import { db } from '../db.js';
import { verifyJwt, hashApiKey, scopesAllowWrite } from '../services/cloud.js';

/* ─── Extend FastifyRequest with auth context ──────────── */

declare module 'fastify' {
  interface FastifyRequest {
    /** Organization ID (always set after auth) */
    orgId?: string;
    /** User ID from JWT (not set for API key auth) */
    userId?: string;
    /** API key id, when the request authenticated with one */
    apiKeyId?: string;
  }
}

/* ─── Public routes that bypass auth ─────────────────────── */

const PUBLIC_PREFIXES = [
  '/health/',
  '/v1/config',
  '/v1/playback/',
  '/v1/analytics/events',
  '/v1/auth/signup',
  '/v1/auth/login',
  '/v1/auth/forgot-password',
  '/v1/auth/reset-password',
  '/v1/billing/webhook',
  '/v1/invitations/',
  '/v1/settings/public',
];

/** Path part of a request URL (query strings must never widen the public set). */
function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function isPublicRoute(url: string): boolean {
  const path = pathOf(url);
  // API public routes
  if (PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  // Everything outside /v1/ is the dashboard SPA (static assets, SPA routes)
  if (!path.startsWith('/v1/')) return true;
  return false;
}

/** The credential a request carries, if any (used by the rate limiter before auth runs). */
export function extractCredential(request: FastifyRequest): string | undefined {
  const header = request.headers['x-api-key'];
  const apiKey = typeof header === 'string' && header.length > 0 ? header : undefined;
  const auth = request.headers.authorization;
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
  return apiKey || bearer || undefined;
}

/* ─── token_version cache ────────────────────────────────── */

const TOKEN_VERSION_TTL_MS = 60_000;
const tokenVersionCache = new Map<string, { value: number; expiresAt: number }>();

/** Drop a user's cached token_version so a bump takes effect immediately in this process. */
export function invalidateTokenVersion(userId: string): void {
  tokenVersionCache.delete(userId);
}

/** Current `users.token_version`, cached for 60 s. Returns null when the user is gone. */
async function currentTokenVersion(userId: string): Promise<number | null> {
  const cached = tokenVersionCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [row] = await db
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    tokenVersionCache.delete(userId);
    return null;
  }
  tokenVersionCache.set(userId, { value: row.tokenVersion, expiresAt: Date.now() + TOKEN_VERSION_TTL_MS });
  return row.tokenVersion;
}

/* ─── Rate limiters injected from the app ────────────────── */

export type RateLimitCheck = (request: FastifyRequest) => Promise<{ isAllowed: boolean; ttl?: number }>;

export interface AuthLimiters {
  /** Consumed on every rejected credential, keyed by IP. */
  authFailure?: RateLimitCheck;
  /** Consumed after a successful auth, keyed by org. */
  perOrg?: RateLimitCheck;
}

async function tooManyRequests(
  reply: FastifyReply,
  check: RateLimitCheck | undefined,
  request: FastifyRequest,
): Promise<boolean> {
  if (!check) return false;
  let result: { isAllowed: boolean; ttl?: number };
  try {
    result = await check(request);
  } catch {
    return false; // never fail a request because the limiter store misbehaved
  }
  if (result.isAllowed) return false;
  const retryAfter = Math.max(1, Math.ceil((result.ttl ?? 60_000) / 1000));
  reply.header('retry-after', String(retryAfter));
  await reply.code(429).send({ error: 'Too many requests — slow down and try again shortly' });
  return true;
}

/* ─── Register auth middleware ───────────────────────────── */

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

class AuthError extends Error {
  constructor(message: string, public readonly statusCode = 401) {
    super(message);
  }
}

export function registerAuth(app: FastifyInstance, limiters: AuthLimiters = {}) {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublicRoute(request.url)) return;

    const token = extractCredential(request);

    if (!token) {
      if (await tooManyRequests(reply, limiters.authFailure, request)) return;
      return reply.code(401).send({ error: 'Unauthorized — provide an API key or Bearer token' });
    }

    try {
      if (token.startsWith('mk_')) {
        await resolveApiKey(request, token);
      } else {
        await resolveJwt(request, token);
      }
    } catch (err) {
      const status = err instanceof AuthError ? err.statusCode : 401;
      // Only rejected *credentials* burn the brute-force budget; a valid but
      // insufficiently scoped key must keep getting its deterministic 403.
      if (status === 401 && (await tooManyRequests(reply, limiters.authFailure, request))) return;
      return reply.code(status).send({ error: (err as Error).message || 'Invalid credentials' });
    }

    if (await tooManyRequests(reply, limiters.perOrg, request)) return;
  });
}

/* ─── Auth resolvers ─────────────────────────────────────── */

async function resolveJwt(request: FastifyRequest, token: string): Promise<void> {
  const payload = verifyJwt(token, env.JWT_SECRET);

  const tokenVersion = await currentTokenVersion(payload.sub);
  if (tokenVersion === null) throw new AuthError('Account no longer exists');
  if (tokenVersion !== payload.tv) {
    throw new AuthError('Session expired — please sign in again');
  }

  request.userId = payload.sub;
  request.orgId = payload.org;
}

async function resolveApiKey(request: FastifyRequest, rawKey: string): Promise<void> {
  const hash = hashApiKey(rawKey, apiKeySecret);
  const [row] = await db
    .select({
      orgId: apiKeys.orgId,
      keyId: apiKeys.id,
      expiresAt: apiKeys.expiresAt,
      scopes: apiKeys.scopes,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);

  if (!row) throw new AuthError('Invalid API key');
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw new AuthError('API key has expired');
  }
  if (!READ_ONLY_METHODS.has(request.method) && !scopesAllowWrite(row.scopes)) {
    throw new AuthError('This API key is read-only', 403);
  }

  request.orgId = row.orgId;
  request.apiKeyId = row.keyId;

  // Update last_used_at in background (fire-and-forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.keyId))
    .catch(() => {});
}
