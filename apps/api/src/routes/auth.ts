import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { users, organizations, orgMembers, ID_LENGTH, ORG_ROLE } from '@hovod/db';
import { db } from '../db.js';
import { env, hasStripe } from '../env.js';
import { hashPassword, verifyPassword, signJwt } from '../services/cloud.js';
import { invalidateTokenVersion } from '../middleware/auth.js';
import { AppError } from '../middleware/error-handler.js';

const signupBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(255),
});

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Route-level rate limits for the credential endpoints.
 *
 * Exported so the cloud package can reuse the exact same budget on the routes it
 * adds (`/v1/auth/forgot-password`, magic links, SSO callbacks…).
 */
export const AUTH_RATE_LIMIT = {
  rateLimit: {
    max: 10,
    timeWindow: '1 minute',
    keyGenerator: (request: { ip: string }) => `auth:${request.ip}`,
  },
} as const;

/** Stricter still — endpoints that send mail or mint reset tokens. */
export const SENSITIVE_AUTH_RATE_LIMIT = {
  rateLimit: {
    max: 5,
    timeWindow: '1 minute',
    keyGenerator: (request: { ip: string }) => `auth-sensitive:${request.ip}`,
  },
} as const;

function slugFromEmail(email: string): string {
  const local = email.split('@')[0] || 'org';
  return local
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

export async function authRoutes(app: FastifyInstance) {
  /* ─── Sign up ────────────────────────────────────────────── */
  app.post('/v1/auth/signup', { config: AUTH_RATE_LIMIT }, async (request, reply) => {
    const body = signupBody.parse(request.body);

    // Check if registration is enabled
    if (!env.REGISTRATION_ENABLED) {
      throw new AppError(403, 'Registration is currently disabled');
    }

    // Check if email domain is allowed
    if (env.REGISTRATION_ALLOWED_DOMAINS) {
      const domain = body.email.split('@')[1]?.toLowerCase();
      if (!domain || !env.REGISTRATION_ALLOWED_DOMAINS.includes(domain)) {
        throw new AppError(403, 'Registration is not allowed for this email domain');
      }
    }

    // Check if email already exists
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) throw new AppError(409, 'An account with this email already exists');

    const userId = nanoid(ID_LENGTH.USER);
    const orgId = nanoid(ID_LENGTH.ORG);
    const memberId = nanoid(ID_LENGTH.MEMBER);

    // Ensure unique slug
    let slug = slugFromEmail(body.email);
    const [slugConflict] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
    if (slugConflict) slug = `${slug}-${nanoid(4)}`;

    // Create user
    await db.insert(users).values({
      id: userId,
      email: body.email,
      passwordHash: hashPassword(body.password),
      name: body.name,
    });

    // Create default organization
    await db.insert(organizations).values({
      id: orgId,
      name: body.name,
      slug,
      ownerId: userId,
    });

    // Link user to org
    await db.insert(orgMembers).values({
      id: memberId,
      orgId,
      userId,
      role: ORG_ROLE.OWNER,
    });

    const token = signJwt({ sub: userId, org: orgId, tv: 0 }, env.JWT_SECRET);

    reply.code(201);
    return { data: { token, user: { id: userId, email: body.email, name: body.name }, org: { id: orgId, slug } } };
  });

  /* ─── Log in ─────────────────────────────────────────────── */
  app.post('/v1/auth/login', { config: AUTH_RATE_LIMIT }, async (request) => {
    const body = loginBody.parse(request.body);

    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      throw new AppError(401, 'Invalid email or password');
    }

    // Most recently joined organization, with the id as a deterministic
    // tie-breaker — LIMIT 1 without an ORDER BY returned whatever InnoDB felt
    // like, so the same account could land in a different org between logins.
    const [membership] = await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
      .where(eq(orgMembers.userId, user.id))
      .orderBy(desc(orgMembers.createdAt), desc(orgMembers.id))
      .limit(1);

    if (!membership) throw new AppError(500, 'No organization found for this account');

    const token = signJwt(
      { sub: user.id, org: membership.orgId, tv: user.tokenVersion },
      env.JWT_SECRET,
    );

    return { data: { token, user: { id: user.id, email: user.email, name: user.name } } };
  });

  /* ─── Switch organization ────────────────────────────────── */
  app.post('/v1/auth/switch-org', async (request) => {
    if (!request.userId) throw new AppError(401, 'Authentication required');

    const { orgId } = z.object({ orgId: z.string().min(1).max(36) }).parse(request.body);

    const [membership] = await db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, request.userId)))
      .limit(1);

    if (!membership) throw new AppError(403, 'You are not a member of this organization');

    const token = signJwt(
      { sub: request.userId, org: orgId, tv: await tokenVersionOf(request.userId) },
      env.JWT_SECRET,
    );

    return { data: { token } };
  });

  /* ─── Current user ───────────────────────────────────────── */
  app.get('/v1/auth/me', async (request) => {
    if (!request.userId) throw new AppError(401, 'Authentication required');

    const [user] = await db.select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, request.userId))
      .limit(1);
    if (!user) throw new AppError(404, 'User not found');

    const [org] = await db.select({ id: organizations.id, name: organizations.name, slug: organizations.slug, tier: organizations.tier })
      .from(organizations)
      .where(eq(organizations.id, request.orgId!))
      .limit(1);

    return { data: { user, org, billingEnabled: hasStripe } };
  });

  /* ─── Change password ──────────────────────────────────── */
  const changePasswordBody = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8).max(128),
  });

  app.post('/v1/auth/change-password', { config: AUTH_RATE_LIMIT }, async (request) => {
    if (!request.userId) throw new AppError(401, 'Authentication required');
    const body = changePasswordBody.parse(request.body);

    const [user] = await db.select().from(users).where(eq(users.id, request.userId)).limit(1);
    if (!user || !verifyPassword(body.currentPassword, user.passwordHash)) {
      throw new AppError(401, 'Current password is incorrect');
    }

    // Bumping token_version invalidates every token minted before this call —
    // including the one used to make it, so a fresh token comes back with the
    // response and the caller stays signed in on this device only.
    const nextVersion = await bumpTokenVersion(user.id, { passwordHash: hashPassword(body.newPassword) });

    const token = signJwt(
      { sub: user.id, org: request.orgId!, tv: nextVersion },
      env.JWT_SECRET,
    );

    return { data: { success: true, token } };
  });

  /* ─── Sign out everywhere ──────────────────────────────── */
  app.post('/v1/auth/logout-all', async (request) => {
    if (!request.userId) throw new AppError(401, 'Authentication required');

    const nextVersion = await bumpTokenVersion(request.userId);
    const token = signJwt({ sub: request.userId, org: request.orgId!, tv: nextVersion }, env.JWT_SECRET);

    return { data: { success: true, token } };
  });
}

/* ─── token_version helpers ──────────────────────────────── */

async function tokenVersionOf(userId: string): Promise<number> {
  const [row] = await db.select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.tokenVersion ?? 0;
}

/**
 * Increment `users.token_version` (optionally alongside other column updates)
 * and return the new value. The increment happens in SQL so two concurrent
 * calls cannot settle on the same version.
 */
async function bumpTokenVersion(
  userId: string,
  extra: Partial<typeof users.$inferInsert> = {},
): Promise<number> {
  await db.update(users)
    .set({ ...extra, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, userId));
  invalidateTokenVersion(userId);
  return tokenVersionOf(userId);
}
