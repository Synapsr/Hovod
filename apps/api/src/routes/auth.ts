import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { users, organizations, orgMembers, ID_LENGTH, ORG_TIER, ORG_ROLE } from '@hovod/db';
import { db } from '../db.js';
import { env, hasStripe } from '../env.js';
import { hashPassword, verifyPassword, signJwt } from '../services/cloud.js';
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
  app.post('/v1/auth/signup', async (request, reply) => {
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
      tier: ORG_TIER.FREE,
    });

    // Link user to org
    await db.insert(orgMembers).values({
      id: memberId,
      orgId,
      userId,
      role: ORG_ROLE.OWNER,
    });

    const token = signJwt({ sub: userId, org: orgId, tier: ORG_TIER.FREE }, env.JWT_SECRET);

    reply.code(201);
    return { data: { token, user: { id: userId, email: body.email, name: body.name }, org: { id: orgId, slug } } };
  });

  /* ─── Log in ─────────────────────────────────────────────── */
  app.post('/v1/auth/login', async (request) => {
    const body = loginBody.parse(request.body);

    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      throw new AppError(401, 'Invalid email or password');
    }

    // Find the user's first org (owner or member)
    const [membership] = await db
      .select({ orgId: orgMembers.orgId, role: orgMembers.role, tier: organizations.tier })
      .from(orgMembers)
      .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
      .where(eq(orgMembers.userId, user.id))
      .limit(1);

    if (!membership) throw new AppError(500, 'No organization found for this account');

    const token = signJwt({ sub: user.id, org: membership.orgId, tier: membership.tier }, env.JWT_SECRET);

    return { data: { token, user: { id: user.id, email: user.email, name: user.name } } };
  });

  /* ─── Switch organization ────────────────────────────────── */
  app.post('/v1/auth/switch-org', async (request) => {
    if (!request.userId) throw new AppError(401, 'Authentication required');

    const { orgId } = z.object({ orgId: z.string().min(1) }).parse(request.body);

    const [membership] = await db
      .select({ role: orgMembers.role, tier: organizations.tier })
      .from(orgMembers)
      .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, request.userId)))
      .limit(1);

    if (!membership) throw new AppError(403, 'You are not a member of this organization');

    const token = signJwt({ sub: request.userId, org: orgId, tier: membership.tier }, env.JWT_SECRET);

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

  app.post('/v1/auth/change-password', async (request) => {
    if (!request.userId) throw new AppError(401, 'Authentication required');
    const body = changePasswordBody.parse(request.body);

    const [user] = await db.select().from(users).where(eq(users.id, request.userId)).limit(1);
    if (!user || !verifyPassword(body.currentPassword, user.passwordHash)) {
      throw new AppError(401, 'Current password is incorrect');
    }

    await db.update(users).set({ passwordHash: hashPassword(body.newPassword) }).where(eq(users.id, user.id));

    return { data: { success: true } };
  });
}
