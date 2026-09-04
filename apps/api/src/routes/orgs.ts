import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { organizations, orgMembers, apiKeys, users, ID_LENGTH, ORG_ROLE, assertPublicHttpUrl, BlockedUrlError } from '@hovod/db';
import { db } from '../db.js';
import { generateApiKey, signJwt, API_KEY_SCOPES } from '../services/cloud.js';
import { env, apiKeySecret } from '../env.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';

/**
 * Resource limits.
 *
 * Everything is unlimited in the open-source build; the cloud package layers
 * per-plan entitlements on top instead of the API hard-coding a tier table.
 */
const LIMITS = {
  encodingMinutes: -1,
  storageGb: -1,
  deliveryMinutes: -1,
  maxAssets: -1,
  apiKeys: 100,
} as const;

/** Usage counters are reported by the cloud metering package; zero here. */
const NO_USAGE = { encodingMinutes: 0, storageGb: 0, deliveryMinutes: 0 } as const;

const ADMINS = [ORG_ROLE.OWNER, ORG_ROLE.ADMIN];

const createKeyBody = z.object({
  name: z.string().min(1).max(255),
  /** `['read']` = GET only. Omitted or `['read','write']` = full access. */
  scopes: z.array(z.enum([API_KEY_SCOPES.READ, API_KEY_SCOPES.WRITE])).min(1).max(2).optional(),
  /** ISO timestamp; must be in the future. */
  expiresAt: z.string().datetime().optional(),
});
const createOrgBody = z.object({ name: z.string().min(1).max(255) });
const updateOrgBody = z.object({
  name: z.string().min(1).max(255).optional(),
  webhookUrl: z.string().url().max(2048).nullable().optional(),
});

/** Ensure the user is a member of the org. */
async function assertMembership(userId: string | undefined, orgId: string) {
  if (!userId) throw new AppError(401, 'Authentication required');
  const [member] = await db.select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  if (!member) throw new NotFoundError('Organization not found');
}

/** Ensure the user has the required role. Returns the user's role. */
async function assertRole(userId: string | undefined, orgId: string, allowedRoles: string[]): Promise<string> {
  if (!userId) throw new AppError(401, 'Authentication required');
  const [member] = await db.select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  if (!member) throw new NotFoundError('Organization not found');
  if (!allowedRoles.includes(member.role)) {
    throw new AppError(403, 'Insufficient permissions');
  }
  return member.role;
}

export async function orgRoutes(app: FastifyInstance) {
  /* ─── List my orgs ───────────────────────────────────────── */
  app.get('/v1/orgs', async (request) => {
    if (!request.userId) throw new AppError(401, 'Authentication required');

    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        tier: organizations.tier,
        role: orgMembers.role,
      })
      .from(orgMembers)
      .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
      .where(eq(orgMembers.userId, request.userId));

    return { data: rows };
  });

  /* ─── Create organization ────────────────────────────────── */
  app.post('/v1/orgs', async (request, reply) => {
    if (!request.userId) throw new AppError(401, 'Authentication required');
    const body = createOrgBody.parse(request.body);

    const orgId = nanoid(ID_LENGTH.ORG);
    const memberId = nanoid(ID_LENGTH.MEMBER);

    // Generate slug from org name
    let slug = body.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'org';

    const [slugConflict] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
    if (slugConflict) slug = `${slug}-${nanoid(4)}`;

    await db.insert(organizations).values({
      id: orgId,
      name: body.name,
      slug,
      ownerId: request.userId,
    });

    await db.insert(orgMembers).values({
      id: memberId,
      orgId,
      userId: request.userId,
      role: ORG_ROLE.OWNER,
    });

    // Return a new JWT scoped to the new org so the user switches automatically
    const [me] = await db.select({ tokenVersion: users.tokenVersion })
      .from(users).where(eq(users.id, request.userId)).limit(1);
    const token = signJwt({ sub: request.userId, org: orgId, tv: me?.tokenVersion ?? 0 }, env.JWT_SECRET);

    reply.code(201);
    return { data: { id: orgId, name: body.name, slug, token } };
  });

  /* ─── Update organization ──────────────────────────────── */
  app.patch<{ Params: { orgId: string } }>('/v1/orgs/:orgId', async (request) => {
    // Renaming an org (and pointing its webhook somewhere) is an admin action.
    await assertRole(request.userId, request.params.orgId, ADMINS);
    const body = updateOrgBody.parse(request.body);

    const updates: Partial<typeof organizations.$inferInsert> = {};
    if (body.name) updates.name = body.name;
    if (body.webhookUrl !== undefined) {
      if (body.webhookUrl === null) {
        updates.webhookUrl = null;
      } else {
        // The API POSTs to this URL from inside the network — same SSRF rules as
        // an imported source, plus https so the payload is not sent in the clear.
        try {
          await assertPublicHttpUrl(body.webhookUrl, { requireHttps: true });
        } catch (err) {
          if (err instanceof BlockedUrlError) throw new AppError(400, err.message);
          throw err;
        }
        updates.webhookUrl = body.webhookUrl;
      }
    }

    if (Object.keys(updates).length > 0) {
      await db.update(organizations).set(updates).where(eq(organizations.id, request.params.orgId));
    }

    const [org] = await db.select().from(organizations).where(eq(organizations.id, request.params.orgId)).limit(1);
    if (!org) throw new NotFoundError('Organization not found');

    return { data: org };
  });

  /* ─── Get org details ────────────────────────────────────── */
  app.get<{ Params: { orgId: string } }>('/v1/orgs/:orgId', async (request) => {
    await assertMembership(request.userId, request.params.orgId);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, request.params.orgId)).limit(1);
    if (!org) throw new NotFoundError('Organization not found');

    return { data: { ...org, usage: NO_USAGE, limits: LIMITS } };
  });

  /* ─── Get org usage ──────────────────────────────────────── */
  app.get<{ Params: { orgId: string } }>('/v1/orgs/:orgId/usage', async (request) => {
    await assertMembership(request.userId, request.params.orgId);

    const [org] = await db.select({ tier: organizations.tier }).from(organizations).where(eq(organizations.id, request.params.orgId)).limit(1);
    if (!org) throw new NotFoundError('Organization not found');

    return { data: { usage: NO_USAGE, limits: LIMITS, tier: org.tier } };
  });

  /* ─── Create API key ─────────────────────────────────────── */
  app.post<{ Params: { orgId: string } }>('/v1/orgs/:orgId/api-keys', async (request, reply) => {
    // An API key is a bearer credential for the whole org — members cannot mint one.
    await assertRole(request.userId, request.params.orgId, ADMINS);
    const body = createKeyBody.parse(request.body);

    const existingKeys = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.orgId, request.params.orgId));
    if (existingKeys.length >= LIMITS.apiKeys) {
      throw new AppError(403, `API key limit reached (${LIMITS.apiKeys} keys per organization).`);
    }

    let expiresAt: Date | null = null;
    if (body.expiresAt) {
      expiresAt = new Date(body.expiresAt);
      if (expiresAt.getTime() <= Date.now()) throw new AppError(400, 'expiresAt must be in the future');
    }

    // Stored scopes are normalised: a key that can write can always read.
    const scopes = body.scopes
      ? (body.scopes.includes(API_KEY_SCOPES.WRITE)
        ? [API_KEY_SCOPES.READ, API_KEY_SCOPES.WRITE]
        : [API_KEY_SCOPES.READ])
      : null;

    const { raw, hash, prefix } = generateApiKey(apiKeySecret);
    const id = nanoid(ID_LENGTH.MEMBER);

    await db.insert(apiKeys).values({
      id,
      orgId: request.params.orgId,
      name: body.name,
      keyHash: hash,
      keyPrefix: prefix,
      createdBy: request.userId ?? null,
      expiresAt,
      scopes,
    });

    reply.code(201);
    return { data: { id, name: body.name, key: raw, prefix, scopes, expiresAt: expiresAt?.toISOString() ?? null } };
  });

  /* ─── List API keys ──────────────────────────────────────── */
  app.get<{ Params: { orgId: string } }>('/v1/orgs/:orgId/api-keys', async (request) => {
    await assertMembership(request.userId, request.params.orgId);

    const keys = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdBy: apiKeys.createdBy,
        expiresAt: apiKeys.expiresAt,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.orgId, request.params.orgId));

    return { data: keys };
  });

  /* ─── Revoke API key ─────────────────────────────────────── */
  app.delete<{ Params: { orgId: string; keyId: string } }>('/v1/orgs/:orgId/api-keys/:keyId', async (request) => {
    await assertRole(request.userId, request.params.orgId, ADMINS);

    const result = await db.delete(apiKeys).where(
      and(eq(apiKeys.id, request.params.keyId), eq(apiKeys.orgId, request.params.orgId)),
    );

    if (result[0].affectedRows === 0) throw new NotFoundError('API key not found');

    return { data: { id: request.params.keyId, deleted: true } };
  });

  /* ═══ Member Management ════════════════════════════════════ */

  const addMemberBody = z.object({
    email: z.string().email(),
    role: z.enum([ORG_ROLE.ADMIN, ORG_ROLE.MEMBER]).default(ORG_ROLE.MEMBER),
  });

  const updateRoleBody = z.object({
    role: z.enum([ORG_ROLE.ADMIN, ORG_ROLE.MEMBER]),
  });

  /* ─── List members ───────────────────────────────────────── */
  app.get<{ Params: { orgId: string } }>('/v1/orgs/:orgId/members', async (request) => {
    await assertMembership(request.userId, request.params.orgId);

    const members = await db
      .select({
        id: orgMembers.id,
        userId: orgMembers.userId,
        role: orgMembers.role,
        email: users.email,
        name: users.name,
        joinedAt: orgMembers.createdAt,
      })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .where(eq(orgMembers.orgId, request.params.orgId));

    return { data: members };
  });

  /* ─── Add member by email ────────────────────────────────── */
  app.post<{ Params: { orgId: string } }>('/v1/orgs/:orgId/members', async (request, reply) => {
    const callerRole = await assertRole(request.userId, request.params.orgId, ADMINS);
    const body = addMemberBody.parse(request.body);

    // Only owners can assign the admin role
    if (body.role === ORG_ROLE.ADMIN && callerRole !== ORG_ROLE.OWNER) {
      throw new AppError(403, 'Only org owners can assign admin roles');
    }

    // Find user by email
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (!user) throw new AppError(404, 'No user found with this email. They must sign up first.');

    // Check not already a member
    const [existing] = await db.select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, request.params.orgId), eq(orgMembers.userId, user.id)))
      .limit(1);
    if (existing) throw new AppError(409, 'User is already a member of this organization');

    const memberId = nanoid(ID_LENGTH.MEMBER);
    await db.insert(orgMembers).values({
      id: memberId,
      orgId: request.params.orgId,
      userId: user.id,
      role: body.role,
    });

    reply.code(201);
    return { data: { id: memberId, userId: user.id, email: body.email, role: body.role } };
  });

  /* ─── Change member role ─────────────────────────────────── */
  app.patch<{ Params: { orgId: string; memberId: string } }>('/v1/orgs/:orgId/members/:memberId', async (request) => {
    await assertRole(request.userId, request.params.orgId, ADMINS);
    const body = updateRoleBody.parse(request.body);

    const [target] = await db.select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.id, request.params.memberId), eq(orgMembers.orgId, request.params.orgId)))
      .limit(1);
    if (!target) throw new NotFoundError('Member not found');
    if (target.role === ORG_ROLE.OWNER) throw new AppError(403, 'Cannot change the owner role');

    await db.update(orgMembers).set({ role: body.role })
      .where(eq(orgMembers.id, request.params.memberId));

    return { data: { id: request.params.memberId, role: body.role } };
  });

  /* ─── Remove member ──────────────────────────────────────── */
  app.delete<{ Params: { orgId: string; memberId: string } }>('/v1/orgs/:orgId/members/:memberId', async (request) => {
    await assertRole(request.userId, request.params.orgId, ADMINS);

    const [target] = await db.select({ role: orgMembers.role, userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.id, request.params.memberId), eq(orgMembers.orgId, request.params.orgId)))
      .limit(1);
    if (!target) throw new NotFoundError('Member not found');
    if (target.role === ORG_ROLE.OWNER) throw new AppError(403, 'Cannot remove the org owner');

    await db.delete(orgMembers).where(eq(orgMembers.id, request.params.memberId));

    // Their API keys outlive the membership otherwise — a removed member would
    // keep full org access through a key they created before leaving.
    const revoked = await db.delete(apiKeys).where(
      and(eq(apiKeys.orgId, request.params.orgId), eq(apiKeys.createdBy, target.userId)),
    );

    return { data: { id: request.params.memberId, removed: true, revokedApiKeys: revoked[0].affectedRows } };
  });
}
