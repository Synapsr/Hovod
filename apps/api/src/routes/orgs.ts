import type { FastifyInstance } from 'fastify';
import { eq, and, gt, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  organizations,
  orgMembers,
  orgInvitations,
  apiKeys,
  users,
  ID_LENGTH,
  ORG_ROLE,
  PLAN,
  TOKEN_TTL,
  assertPublicHttpUrl,
  BlockedUrlError,
  type Plan,
} from '@hovod/db';
import { db } from '../db.js';
import { generateApiKey, signJwt, API_KEY_SCOPES } from '../services/cloud.js';
import { env, apiKeySecret, isCloud, appUrl } from '../env.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';
import { startCheckout } from '../services/billing.js';
import { getOrgEntitlement, LimitError } from '../services/entitlements.js';
import { getUsageSummary } from '../services/usage.js';
import { sendEmail, invitationTemplate } from '../services/email.js';
import { hashToken, newRawToken, tokenVersionOf, uniqueSlug } from './auth.js';

const ADMINS = [ORG_ROLE.OWNER, ORG_ROLE.ADMIN];

const createKeyBody = z.object({
  name: z.string().min(1).max(255),
  /** `['read']` = GET only. Omitted or `['read','write']` = full access. */
  scopes: z.array(z.enum([API_KEY_SCOPES.READ, API_KEY_SCOPES.WRITE])).min(1).max(2).optional(),
  /** ISO timestamp; must be in the future. */
  expiresAt: z.string().datetime().optional(),
});
const createOrgBody = z.object({
  name: z.string().min(1).max(255),
  /** Cloud only: every org has its own subscription. */
  plan: z.enum([PLAN.PRO, PLAN.BUSINESS]).optional(),
});
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

async function countRows(table: typeof apiKeys | typeof orgMembers, orgId: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`COUNT(*)` }).from(table).where(eq(table.orgId, orgId));
  return Number(row?.count ?? 0);
}

async function countPendingInvitations(orgId: string): Promise<number> {
  const [row] = await db.select({ count: sql<number>`COUNT(*)` })
    .from(orgInvitations)
    .where(and(eq(orgInvitations.orgId, orgId), isNull(orgInvitations.acceptedAt), gt(orgInvitations.expiresAt, new Date())));
  return Number(row?.count ?? 0);
}

/** Org projection shared by the list / detail endpoints (no Stripe ids, no webhook secret). */
const ORG_COLUMNS = {
  id: organizations.id,
  name: organizations.name,
  slug: organizations.slug,
  ownerId: organizations.ownerId,
  plan: organizations.plan,
  subscriptionStatus: organizations.subscriptionStatus,
  currentPeriodEnd: organizations.currentPeriodEnd,
  cancelAtPeriodEnd: organizations.cancelAtPeriodEnd,
  graceUntil: organizations.graceUntil,
  activatedAt: organizations.activatedAt,
  webhookUrl: organizations.webhookUrl,
  createdAt: organizations.createdAt,
  updatedAt: organizations.updatedAt,
};

export async function orgRoutes(app: FastifyInstance) {
  /* ─── List my orgs ───────────────────────────────────────── */
  app.get('/v1/orgs', async (request) => {
    if (!request.userId) throw new AppError(401, 'Authentication required');

    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        plan: organizations.plan,
        subscriptionStatus: organizations.subscriptionStatus,
        role: orgMembers.role,
      })
      .from(orgMembers)
      .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
      .where(eq(orgMembers.userId, request.userId));

    const data = await Promise.all(rows.map(async (row) => ({
      ...row,
      entitlement: (await getOrgEntitlement(row.id)).mode,
    })));

    return { data };
  });

  /* ─── Create organization ────────────────────────────────── */
  app.post('/v1/orgs', async (request, reply) => {
    if (!request.userId) throw new AppError(401, 'Authentication required');
    const body = createOrgBody.parse(request.body);

    const plan: Plan | null = isCloud ? (body.plan ?? null) : null;
    if (isCloud && !plan) throw new AppError(400, 'Choose a plan (pro or business) for the new organization');

    const orgId = nanoid(ID_LENGTH.ORG);
    const memberId = nanoid(ID_LENGTH.MEMBER);

    // Generate slug from org name
    const slug = await uniqueSlug(
      body.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80),
    );

    await db.transaction(async (tx) => {
      await tx.insert(organizations).values({
        id: orgId,
        name: body.name,
        slug,
        ownerId: request.userId!,
        plan,
      });
      await tx.insert(orgMembers).values({
        id: memberId,
        orgId,
        userId: request.userId!,
        role: ORG_ROLE.OWNER,
      });
    });

    // Return a new JWT scoped to the new org so the user switches automatically
    const token = signJwt({ sub: request.userId, org: orgId, tv: await tokenVersionOf(request.userId) }, env.JWT_SECRET);

    if (!isCloud) {
      reply.code(201);
      return { data: { id: orgId, name: body.name, slug, token } };
    }

    const [me] = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, request.userId)).limit(1);
    if (!me) throw new AppError(401, 'Account not found');
    const checkoutUrl = await startCheckout(
      { id: orgId, name: body.name, stripeCustomerId: null },
      plan!,
      { email: me.email, name: me.name, userId: request.userId },
    );

    reply.code(201);
    return { data: { id: orgId, name: body.name, slug, token, checkoutUrl } };
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

    const [org] = await db.select(ORG_COLUMNS).from(organizations).where(eq(organizations.id, request.params.orgId)).limit(1);
    if (!org) throw new NotFoundError('Organization not found');

    return { data: org };
  });

  /* ─── Get org details ────────────────────────────────────── */
  app.get<{ Params: { orgId: string } }>('/v1/orgs/:orgId', async (request) => {
    await assertMembership(request.userId, request.params.orgId);

    const [org] = await db.select(ORG_COLUMNS).from(organizations).where(eq(organizations.id, request.params.orgId)).limit(1);
    if (!org) throw new NotFoundError('Organization not found');

    const [entitlement, usage] = await Promise.all([
      getOrgEntitlement(org.id),
      getUsageSummary(org.id),
    ]);

    return { data: { ...org, cancelAtPeriodEnd: !!org.cancelAtPeriodEnd, usage, limits: entitlement.limits, entitlement: entitlement.mode } };
  });

  /* ─── Get org usage ──────────────────────────────────────── */
  app.get<{ Params: { orgId: string } }>('/v1/orgs/:orgId/usage', async (request) => {
    await assertMembership(request.userId, request.params.orgId);

    const [entitlement, usage, apiKeyCount, memberCount, invitationCount] = await Promise.all([
      getOrgEntitlement(request.params.orgId),
      getUsageSummary(request.params.orgId),
      countRows(apiKeys, request.params.orgId),
      countRows(orgMembers, request.params.orgId),
      countPendingInvitations(request.params.orgId),
    ]);

    return {
      data: {
        usage: { ...usage, apiKeys: apiKeyCount, members: memberCount, pendingInvitations: invitationCount },
        limits: entitlement.limits,
        plan: entitlement.plan,
        entitlement: entitlement.mode,
      },
    };
  });

  /* ─── Create API key ─────────────────────────────────────── */
  app.post<{ Params: { orgId: string } }>('/v1/orgs/:orgId/api-keys', async (request, reply) => {
    // An API key is a bearer credential for the whole org — members cannot mint one.
    await assertRole(request.userId, request.params.orgId, ADMINS);
    const body = createKeyBody.parse(request.body);

    // Plan limit (cloud only — self-host is unlimited).
    const entitlement = await getOrgEntitlement(request.params.orgId);
    if (entitlement.limits) {
      const existing = await countRows(apiKeys, request.params.orgId);
      if (existing >= entitlement.limits.apiKeys) {
        throw new LimitError('api_keys_limit', `API key limit reached (${entitlement.limits.apiKeys} keys on the ${entitlement.plan} plan). Revoke one or upgrade.`);
      }
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

  const inviteBody = z.object({
    email: z.string().email().max(255).transform((v) => v.trim().toLowerCase()),
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

  /* ─── Invite by email ────────────────────────────────────── */
  app.post<{ Params: { orgId: string } }>('/v1/orgs/:orgId/members/invite', async (request, reply) => {
    const callerRole = await assertRole(request.userId, request.params.orgId, ADMINS);
    const body = inviteBody.parse(request.body);
    const orgId = request.params.orgId;

    // Only owners can assign the admin role
    if (body.role === ORG_ROLE.ADMIN && callerRole !== ORG_ROLE.OWNER) {
      throw new AppError(403, 'Only org owners can assign admin roles');
    }

    // Already a member?
    const [member] = await db.select({ id: orgMembers.id })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .where(and(eq(orgMembers.orgId, orgId), eq(users.email, body.email)))
      .limit(1);
    if (member) throw new AppError(409, 'This person is already a member of the organization');

    // Plan limit: members + open invitations (cloud only).
    const entitlement = await getOrgEntitlement(orgId);
    if (entitlement.limits) {
      const [members, pending] = await Promise.all([countRows(orgMembers, orgId), countPendingInvitations(orgId)]);
      if (members + pending >= entitlement.limits.members) {
        throw new LimitError('members_limit', `Member limit reached (${entitlement.limits.members} on the ${entitlement.plan} plan). Remove a member, revoke an invitation or upgrade.`);
      }
    }

    // A fresh invitation replaces any open one for the same address.
    await db.delete(orgInvitations)
      .where(and(eq(orgInvitations.orgId, orgId), eq(orgInvitations.email, body.email), isNull(orgInvitations.acceptedAt)));

    const raw = newRawToken();
    const id = nanoid(ID_LENGTH.INVITATION);
    const expiresAt = new Date(Date.now() + TOKEN_TTL.INVITATION_DAYS * 86_400_000);
    await db.insert(orgInvitations).values({
      id,
      orgId,
      email: body.email,
      role: body.role,
      tokenHash: hashToken(raw),
      invitedBy: request.userId ?? null,
      expiresAt,
    });

    const inviteUrl = `${appUrl}/invite/${raw}`;

    const [[org], [inviter]] = await Promise.all([
      db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1),
      db.select({ name: users.name }).from(users).where(eq(users.id, request.userId!)).limit(1),
    ]);
    const email = await sendEmail({
      to: body.email,
      ...invitationTemplate({ orgName: org?.name ?? 'your team', inviterName: inviter?.name ?? null, role: body.role, inviteUrl, expiresAt }),
    });

    reply.code(201);
    return { data: { id, email: body.email, role: body.role, inviteUrl, expiresAt, emailSent: email.sent } };
  });

  /* ─── Pending invitations ────────────────────────────────── */
  app.get<{ Params: { orgId: string } }>('/v1/orgs/:orgId/invitations', async (request) => {
    await assertRole(request.userId, request.params.orgId, ADMINS);

    const rows = await db.select({
      id: orgInvitations.id,
      email: orgInvitations.email,
      role: orgInvitations.role,
      invitedBy: orgInvitations.invitedBy,
      expiresAt: orgInvitations.expiresAt,
      createdAt: orgInvitations.createdAt,
    })
      .from(orgInvitations)
      .where(and(eq(orgInvitations.orgId, request.params.orgId), isNull(orgInvitations.acceptedAt), gt(orgInvitations.expiresAt, new Date())))
      .orderBy(orgInvitations.createdAt);

    return { data: rows };
  });

  /* ─── Revoke invitation ──────────────────────────────────── */
  app.delete<{ Params: { orgId: string; invitationId: string } }>('/v1/orgs/:orgId/invitations/:invitationId', async (request) => {
    await assertRole(request.userId, request.params.orgId, ADMINS);

    const [result] = await db.delete(orgInvitations).where(
      and(eq(orgInvitations.id, request.params.invitationId), eq(orgInvitations.orgId, request.params.orgId), isNull(orgInvitations.acceptedAt)),
    );
    if (result.affectedRows === 0) throw new NotFoundError('Invitation not found');

    return { data: { id: request.params.invitationId, revoked: true } };
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
