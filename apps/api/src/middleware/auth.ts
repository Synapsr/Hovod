import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { apiKeys, organizations } from '@hovod/db';
import { env } from '../env.js';
import { db } from '../db.js';
import { verifyJwt, hashApiKey } from '../services/cloud.js';

/* ─── Extend FastifyRequest with auth context ──────────── */

declare module 'fastify' {
  interface FastifyRequest {
    /** Organization ID (always set after auth) */
    orgId?: string;
    /** User ID from JWT (not set for API key auth) */
    userId?: string;
    /** Organization tier — 'free' | 'pro' | 'business' */
    orgTier?: string;
  }
}

/* ─── Public routes that bypass auth ─────────────────────── */

const PUBLIC_PREFIXES = [
  '/health/',
  '/v1/playback/',
  '/v1/analytics/events',
  '/v1/auth/signup',
  '/v1/auth/login',
  '/v1/billing/webhook',
  '/v1/settings/public',
];

function isPublicRoute(url: string): boolean {
  // API public routes
  if (PUBLIC_PREFIXES.some((prefix) => url.startsWith(prefix))) return true;
  // Everything outside /v1/ is the dashboard SPA (static assets, SPA routes)
  if (!url.startsWith('/v1/')) return true;
  return false;
}

/* ─── Register auth middleware ───────────────────────────── */

export function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPublicRoute(request.url)) return;

    const header = request.headers['x-api-key'] as string | undefined;
    const bearer = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7)
      : undefined;
    const token = header || bearer;

    if (!token) {
      return reply.code(401).send({ error: 'Unauthorized — provide an API key or Bearer token' });
    }

    try {
      if (token.startsWith('mk_')) {
        await resolveApiKey(request, token);
      } else {
        resolveJwt(request, token);
      }
    } catch (err) {
      return reply.code(401).send({ error: (err as Error).message || 'Invalid credentials' });
    }
  });
}

/* ─── Auth resolvers ─────────────────────────────────────── */

function resolveJwt(request: FastifyRequest, token: string): void {
  const payload = verifyJwt(token, env.JWT_SECRET);
  request.userId = payload.sub;
  request.orgId = payload.org;
  request.orgTier = payload.tier;
}

async function resolveApiKey(request: FastifyRequest, rawKey: string): Promise<void> {
  const hash = hashApiKey(rawKey, env.JWT_SECRET);
  const [row] = await db
    .select({
      orgId: apiKeys.orgId,
      tier: organizations.tier,
      keyId: apiKeys.id,
    })
    .from(apiKeys)
    .innerJoin(organizations, eq(apiKeys.orgId, organizations.id))
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);

  if (!row) throw new Error('Invalid API key');

  request.orgId = row.orgId;
  request.orgTier = row.tier;

  // Update last_used_at in background (fire-and-forget)
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.keyId))
    .catch(() => {});
}
