import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { users, organizations, orgMembers, passwordResets, ID_LENGTH, ORG_ROLE, PLAN, TOKEN_TTL, type Plan } from '@hovod/db';
import { db } from '../db.js';
import { env, isCloud, appUrl, emailEnabled } from '../env.js';
import { hashPassword, verifyPassword, signJwt } from '../services/cloud.js';
import { invalidateTokenVersion } from '../middleware/auth.js';
import { AppError } from '../middleware/error-handler.js';
import { startCheckout } from '../services/billing.js';
import { getOrgEntitlement } from '../services/entitlements.js';
import { getUsageSummary } from '../services/usage.js';
import { sendEmail, passwordResetTemplate } from '../services/email.js';

const signupBody = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(255),
  orgName: z.string().min(1).max(255).optional(),
  /** Cloud only — which subscription the Checkout starts with. */
  plan: z.enum([PLAN.PRO, PLAN.BUSINESS]).optional(),
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

/** Slug that is not taken yet (a 4-char suffix is appended on conflict). */
export async function uniqueSlug(base: string): Promise<string> {
  const slug = base || 'org';
  const [conflict] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
  return conflict ? `${slug}-${nanoid(4)}` : slug;
}

/* ─── One-time tokens (password reset) ───────────────────── */

/** sha256 hex of a raw token — what the DB stores. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** 32 random bytes as base64url (43 chars) — safe in a URL path segment. */
export function newRawToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Mint a password-reset token for a user and return the one-time link.
 * Shared by `POST /v1/auth/forgot-password` and the `hovod-cli reset-password` fallback.
 */
export async function createPasswordReset(userId: string): Promise<{ resetUrl: string; expiresAt: Date }> {
  const raw = newRawToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL.PASSWORD_RESET_HOURS * 3_600_000);
  await db.insert(passwordResets).values({
    id: nanoid(ID_LENGTH.PASSWORD_RESET),
    userId,
    tokenHash: hashToken(raw),
    expiresAt,
  });
  return { resetUrl: `${appUrl}/reset-password/${raw}`, expiresAt };
}

/** Public projection of an org for `/me` and org listings. */
export async function describeOrgForUser(orgId: string, role: string) {
  const [org] = await db.select({
    id: organizations.id,
    name: organizations.name,
    slug: organizations.slug,
    plan: organizations.plan,
    subscriptionStatus: organizations.subscriptionStatus,
    currentPeriodEnd: organizations.currentPeriodEnd,
    cancelAtPeriodEnd: organizations.cancelAtPeriodEnd,
    graceUntil: organizations.graceUntil,
  }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return null;
  const entitlement = await getOrgEntitlement(orgId);
  return {
    org: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role,
      plan: org.plan,
      subscriptionStatus: org.subscriptionStatus,
      currentPeriodEnd: org.currentPeriodEnd,
      cancelAtPeriodEnd: !!org.cancelAtPeriodEnd,
      graceUntil: org.graceUntil,
      entitlement: entitlement.mode,
    },
    entitlement,
  };
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

    // In cloud mode every org starts with a subscription: the plan is mandatory.
    const plan: Plan | null = isCloud ? (body.plan ?? null) : null;
    if (isCloud && !plan) throw new AppError(400, 'Choose a plan (pro or business) to sign up');

    // Check if email already exists
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) throw new AppError(409, 'An account with this email already exists');

    const userId = nanoid(ID_LENGTH.USER);
    const orgId = nanoid(ID_LENGTH.ORG);
    const memberId = nanoid(ID_LENGTH.MEMBER);
    const orgName = body.orgName?.trim() || body.name;
    const slug = await uniqueSlug(slugFromEmail(body.email));

    // User + org + owner membership are one unit of work.
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email: body.email,
        passwordHash: hashPassword(body.password),
        name: body.name,
      });
      await tx.insert(organizations).values({
        id: orgId,
        name: orgName,
        slug,
        ownerId: userId,
        plan,
      });
      await tx.insert(orgMembers).values({
        id: memberId,
        orgId,
        userId,
        role: ORG_ROLE.OWNER,
      });
    });

    const token = signJwt({ sub: userId, org: orgId, tv: 0 }, env.JWT_SECRET);
    const base = { token, user: { id: userId, email: body.email, name: body.name }, org: { id: orgId, slug, name: orgName } };

    if (!isCloud) {
      reply.code(201);
      return { data: base };
    }

    // Cloud: customer + Checkout. The account exists already; a Stripe failure
    // leaves the org pending and the paywall lets the user retry the checkout.
    const checkoutUrl = await startCheckout(
      { id: orgId, name: orgName, stripeCustomerId: null },
      plan!,
      { email: body.email, name: body.name, userId },
    );

    reply.code(201);
    return { data: { ...base, checkoutUrl } };
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

    const [user] = await db.select({ id: users.id, email: users.email, name: users.name, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, request.userId))
      .limit(1);
    if (!user) throw new AppError(404, 'User not found');

    const [membership] = await db.select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, request.orgId!), eq(orgMembers.userId, request.userId)))
      .limit(1);
    if (!membership) throw new AppError(403, 'You are not a member of this organization');

    const described = await describeOrgForUser(request.orgId!, membership.role);
    if (!described) throw new AppError(404, 'Organization not found');

    const usage = await getUsageSummary(request.orgId!);

    return {
      data: {
        user: { id: user.id, email: user.email, name: user.name, emailVerified: !!user.emailVerifiedAt },
        org: described.org,
        cloud: isCloud,
        limits: described.entitlement.limits,
        usage,
      },
    };
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

  /* ─── Forgot password (public, always 200) ─────────────── */
  const forgotBody = z.object({ email: z.string().email().max(255) });

  app.post('/v1/auth/forgot-password', { config: SENSITIVE_AUTH_RATE_LIMIT }, async (request) => {
    const body = forgotBody.parse(request.body);

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (user) {
      const { resetUrl, expiresAt } = await createPasswordReset(user.id);
      if (emailEnabled) {
        await sendEmail({ to: body.email, ...passwordResetTemplate({ resetUrl, expiresAt }) });
      } else {
        // Self-host without email: the operator issues the link from the CLI.
        request.log.warn({ email: body.email }, 'password reset requested but email is not configured — use `hovod-cli reset-password <email>`');
      }
    }

    // Same answer whether or not the account exists (no enumeration).
    return { data: { sent: true, emailEnabled } };
  });

  /* ─── Reset password (public) ──────────────────────────── */
  const resetBody = z.object({
    token: z.string().min(16).max(128),
    password: z.string().min(8).max(128),
  });

  app.post('/v1/auth/reset-password', { config: SENSITIVE_AUTH_RATE_LIMIT }, async (request) => {
    const body = resetBody.parse(request.body);

    const [reset] = await db.select()
      .from(passwordResets)
      .where(eq(passwordResets.tokenHash, hashToken(body.token)))
      .limit(1);
    if (!reset || reset.usedAt || reset.expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, 'This reset link is invalid or has expired');
    }

    // Mark the token used first (atomically) so two concurrent submissions cannot both succeed.
    const [claimed] = await db.update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.id, reset.id), sql`${passwordResets.usedAt} IS NULL`));
    if (claimed.affectedRows === 0) throw new AppError(400, 'This reset link has already been used');

    const nextVersion = await bumpTokenVersion(reset.userId, { passwordHash: hashPassword(body.password) });

    // Sign the user straight in on their most recent org.
    const [membership] = await db.select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, reset.userId))
      .orderBy(desc(orgMembers.createdAt), desc(orgMembers.id))
      .limit(1);
    const token = membership
      ? signJwt({ sub: reset.userId, org: membership.orgId, tv: nextVersion }, env.JWT_SECRET)
      : null;

    return { data: { success: true, token } };
  });
}

/* ─── token_version helpers ──────────────────────────────── */

export async function tokenVersionOf(userId: string): Promise<number> {
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
export async function bumpTokenVersion(
  userId: string,
  extra: Partial<typeof users.$inferInsert> = {},
): Promise<number> {
  await db.update(users)
    .set({ ...extra, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, userId));
  invalidateTokenVersion(userId);
  return tokenVersionOf(userId);
}
