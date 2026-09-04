import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type Stripe from 'stripe';
import { organizations, orgMembers, ORG_ROLE, PLAN, SUBSCRIPTION_STATUS } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';
import {
  getStripe,
  startCheckout,
  createPortalSession,
  retrieveCheckoutSession,
  syncSubscription,
  applySubscription,
  claimStripeEvent,
  releaseStripeEvent,
  handleStripeEvent,
} from '../services/billing.js';
import { getOrgEntitlement, invalidateEntitlement } from '../services/entitlements.js';
import { users } from '@hovod/db';

/**
 * Billing routes — registered only in cloud mode (`HOVOD_CLOUD=true`).
 *
 *   POST /v1/billing/checkout { plan }     → { checkoutUrl }   (409 when already subscribed)
 *   POST /v1/billing/sync { sessionId }    → { status, entitlement }  (Checkout return, beats the webhook)
 *   POST /v1/billing/portal                → { url }
 *   POST /v1/billing/webhook               ← Stripe (raw body, signature verified, deduped)
 */

const checkoutBody = z.object({ plan: z.enum([PLAN.PRO, PLAN.BUSINESS]) });
const syncBody = z.object({ sessionId: z.string().min(1).max(255) });

/** Statuses for which a new Checkout makes no sense — the portal is the right tool. */
const SUBSCRIBED_STATUSES: string[] = [
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.TRIALING,
  SUBSCRIPTION_STATUS.PAST_DUE,
];

const BILLING_ADMINS: string[] = [ORG_ROLE.OWNER, ORG_ROLE.ADMIN];

async function requireMember(userId: string | undefined, orgId: string | undefined, roles?: string[]) {
  if (!userId || !orgId) throw new AppError(401, 'Sign in with your account to manage billing');
  const [member] = await db.select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  if (!member) throw new NotFoundError('Organization not found');
  if (roles && !roles.includes(member.role)) throw new AppError(403, 'Only owners and admins can manage billing');
  return member.role;
}

async function loadOrg(orgId: string) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new NotFoundError('Organization not found');
  return org;
}

export async function billingRoutes(app: FastifyInstance) {
  /* ─── New Checkout for an existing org (paywall) ─────────── */
  app.post('/v1/billing/checkout', async (request) => {
    await requireMember(request.userId, request.orgId);
    const body = checkoutBody.parse(request.body);
    const org = await loadOrg(request.orgId!);

    if (org.subscriptionStatus && SUBSCRIBED_STATUSES.includes(org.subscriptionStatus)) {
      throw new AppError(409, 'This organization already has a subscription — manage it from the billing portal', 'already_subscribed');
    }

    const [me] = await db.select({ email: users.email, name: users.name })
      .from(users).where(eq(users.id, request.userId!)).limit(1);
    if (!me) throw new AppError(401, 'Account not found');

    const checkoutUrl = await startCheckout(org, body.plan, { email: me.email, name: me.name, userId: request.userId });
    // Remember the plan the user picked so the paywall / limits know it before activation.
    if (org.plan !== body.plan) {
      await db.update(organizations).set({ plan: body.plan }).where(eq(organizations.id, org.id));
      invalidateEntitlement(org.id);
    }

    return { data: { checkoutUrl, url: checkoutUrl } };
  });

  /* ─── Checkout return: sync right away (no webhook race) ─── */
  app.post('/v1/billing/sync', async (request) => {
    await requireMember(request.userId, request.orgId);
    const body = syncBody.parse(request.body);
    const org = await loadOrg(request.orgId!);

    const session = await retrieveCheckoutSession(body.sessionId);
    const sessionCustomer = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
    const belongsToOrg = session.client_reference_id === org.id
      || (!!sessionCustomer && sessionCustomer === org.stripeCustomerId);
    if (!belongsToOrg) throw new AppError(403, 'This checkout session belongs to another organization');

    const sub = session.subscription;
    if (sub && typeof sub !== 'string') {
      await applySubscription(sub as Stripe.Subscription);
    } else if (typeof sub === 'string') {
      await syncSubscription(sub);
    }

    const entitlement = await getOrgEntitlement(org.id);
    return { data: { status: entitlement.status, entitlement: entitlement.mode, plan: entitlement.plan } };
  });

  /* ─── Customer portal ────────────────────────────────────── */
  app.post('/v1/billing/portal', async (request) => {
    await requireMember(request.userId, request.orgId, BILLING_ADMINS);
    const org = await loadOrg(request.orgId!);
    if (!org.stripeCustomerId) {
      throw new AppError(400, 'No billing account yet — complete the checkout first', 'no_billing_account');
    }
    const url = await createPortalSession(org.stripeCustomerId);
    return { data: { url } };
  });

  /* ─── Stripe webhook ─────────────────────────────────────── */
  app.register(async function stripeWebhook(scope) {
    // Raw body for signature verification (the global JSON parser would re-serialise it).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', function (_req, payload, done) {
      const chunks: Buffer[] = [];
      payload.on('data', (chunk: Buffer) => chunks.push(chunk));
      payload.on('end', () => done(null, Buffer.concat(chunks)));
      payload.on('error', done);
    });

    scope.post('/v1/billing/webhook', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string' || !signature || !env.STRIPE_WEBHOOK_SECRET) {
        return reply.code(400).send({ error: 'Missing Stripe signature' });
      }

      let event: Stripe.Event;
      try {
        event = getStripe().webhooks.constructEvent(request.body as Buffer, signature, env.STRIPE_WEBHOOK_SECRET);
      } catch {
        return reply.code(400).send({ error: 'Invalid Stripe signature' });
      }

      // 1. Dedupe on the event id — Stripe retries until it sees a 2xx.
      const fresh = await claimStripeEvent(event.id, event.type);
      if (!fresh) return { received: true, duplicate: true };

      // 2. Route; 3. internal failure → 500 and forget the event so the retry is processed.
      try {
        const outcome = await handleStripeEvent(event);
        request.log.info({ eventId: event.id, type: event.type, ...outcome }, 'stripe webhook processed');
        return { received: true, handled: outcome.handled };
      } catch (err) {
        request.log.error({ err, eventId: event.id, type: event.type }, 'stripe webhook failed');
        await releaseStripeEvent(event.id);
        return reply.code(500).send({ error: 'Webhook processing failed — Stripe will retry' });
      }
    });
  });
}
