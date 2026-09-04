import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, and, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { users, organizations, orgMembers, orgInvitations, ID_LENGTH } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { hashPassword, verifyPassword, signJwt, verifyJwt } from '../services/cloud.js';
import { extractCredential } from '../middleware/auth.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';
import { hashToken, tokenVersionOf, AUTH_RATE_LIMIT } from './auth.js';

/**
 * Public invitation endpoints (the token in the URL is the credential):
 *
 *   GET  /v1/invitations/:token          → { orgName, email, role, requiresSignup, expiresAt }
 *   POST /v1/invitations/:token/accept   → { token, org } (creates the account when needed)
 *
 * Invitations are created/listed/revoked under /v1/orgs/:orgId/… (routes/orgs.ts).
 */

const tokenParam = z.object({ token: z.string().min(16).max(128) });
const acceptBody = z.object({
  password: z.string().min(8).max(128).optional(),
  name: z.string().min(1).max(255).optional(),
}).default({});

async function loadInvitation(rawToken: string) {
  const [invite] = await db.select({
    id: orgInvitations.id,
    orgId: orgInvitations.orgId,
    email: orgInvitations.email,
    role: orgInvitations.role,
    expiresAt: orgInvitations.expiresAt,
    acceptedAt: orgInvitations.acceptedAt,
    orgName: organizations.name,
    orgSlug: organizations.slug,
  })
    .from(orgInvitations)
    .innerJoin(organizations, eq(orgInvitations.orgId, organizations.id))
    .where(eq(orgInvitations.tokenHash, hashToken(rawToken)))
    .limit(1);

  if (!invite) throw new NotFoundError('This invitation does not exist');
  if (invite.acceptedAt) throw new AppError(410, 'This invitation has already been accepted');
  if (invite.expiresAt.getTime() <= Date.now()) throw new AppError(410, 'This invitation has expired');
  return invite;
}

/**
 * The route is public (the auth hook skips it), but an already signed-in user
 * may accept with their session instead of retyping a password. Resolve the
 * bearer token by hand; anything invalid simply means "not signed in".
 */
async function optionalUserId(request: FastifyRequest): Promise<string | null> {
  const credential = extractCredential(request);
  if (!credential || credential.startsWith('mk_')) return null;
  try {
    const payload = verifyJwt(credential, env.JWT_SECRET);
    if ((await tokenVersionOf(payload.sub)) !== payload.tv) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export async function invitationRoutes(app: FastifyInstance) {
  /* ─── Preview ────────────────────────────────────────────── */
  app.get<{ Params: z.infer<typeof tokenParam> }>('/v1/invitations/:token', async (request) => {
    const { token } = tokenParam.parse(request.params);
    const invite = await loadInvitation(token);

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, invite.email)).limit(1);

    return {
      data: {
        orgName: invite.orgName,
        email: invite.email,
        role: invite.role,
        requiresSignup: !existing,
        expiresAt: invite.expiresAt,
      },
    };
  });

  /* ─── Accept ─────────────────────────────────────────────── */
  app.post<{ Params: z.infer<typeof tokenParam> }>('/v1/invitations/:token/accept', { config: AUTH_RATE_LIMIT }, async (request, reply) => {
    const { token } = tokenParam.parse(request.params);
    const body = acceptBody.parse(request.body ?? {});
    const invite = await loadInvitation(token);

    const [existing] = await db.select({ id: users.id, passwordHash: users.passwordHash })
      .from(users).where(eq(users.email, invite.email)).limit(1);

    let userId: string;

    if (existing) {
      // The invite link is also shown to the inviter, so possessing it must not
      // be enough to act as an existing account: require that account's session
      // or its password.
      const sessionUser = await optionalUserId(request);
      const viaSession = sessionUser === existing.id;
      const viaPassword = !!body.password && verifyPassword(body.password, existing.passwordHash);
      if (!viaSession && !viaPassword) {
        throw new AppError(401, 'Sign in as the invited account (or provide its password) to accept this invitation', 'password_required');
      }
      userId = existing.id;
    } else {
      if (!body.password) throw new AppError(400, 'Choose a password to create your account', 'password_required');
      userId = nanoid(ID_LENGTH.USER);
      await db.insert(users).values({
        id: userId,
        email: invite.email,
        passwordHash: hashPassword(body.password),
        name: body.name?.trim() || invite.email.split('@')[0] || null,
        // The invitation was delivered to this address.
        emailVerifiedAt: new Date(),
      });
    }

    // Join (idempotent when a membership already exists) and burn the invitation.
    await db.transaction(async (tx) => {
      const [member] = await tx.select({ id: orgMembers.id })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, invite.orgId), eq(orgMembers.userId, userId)))
        .limit(1);
      if (!member) {
        await tx.insert(orgMembers).values({
          id: nanoid(ID_LENGTH.MEMBER),
          orgId: invite.orgId,
          userId,
          role: invite.role,
        });
      }
      const [claimed] = await tx.update(orgInvitations)
        .set({ acceptedAt: new Date() })
        .where(and(eq(orgInvitations.id, invite.id), isNull(orgInvitations.acceptedAt)));
      if (claimed.affectedRows === 0) throw new AppError(410, 'This invitation has already been accepted');
    });

    const jwt = signJwt({ sub: userId, org: invite.orgId, tv: await tokenVersionOf(userId) }, env.JWT_SECRET);

    reply.code(existing ? 200 : 201);
    return {
      data: {
        token: jwt,
        created: !existing,
        org: { id: invite.orgId, name: invite.orgName, slug: invite.orgSlug, role: invite.role },
      },
    };
  });
}
