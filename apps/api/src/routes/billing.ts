import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import Stripe from 'stripe';
import { organizations, ORG_TIER } from '@hovod/db';
import { db } from '../db.js';
import { env } from '../env.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';

const checkoutBody = z.object({
  tier: z.enum([ORG_TIER.PRO, ORG_TIER.BUSINESS]),
});

function getStripe(): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY!);
}

function getPriceId(tier: string): string {
  if (tier === ORG_TIER.PRO) return env.STRIPE_PRO_PRICE_ID!;
  if (tier === ORG_TIER.BUSINESS) return env.STRIPE_BUSINESS_PRICE_ID!;
  throw new AppError(400, `No price configured for tier: ${tier}`);
}

export async function billingRoutes(app: FastifyInstance) {
  /* ─── Create checkout session ────────────────────────────── */
  app.post('/v1/billing/checkout', async (request) => {
    if (!request.orgId) throw new AppError(401, 'Authentication required');
    const body = checkoutBody.parse(request.body);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, request.orgId)).limit(1);
    if (!org) throw new NotFoundError('Organization not found');

    const stripe = getStripe();
    const priceId = getPriceId(body.tier);

    const session = await stripe.checkout.sessions.create({
      customer: org.stripeCustomerId || undefined,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${env.DASHBOARD_URL}/settings?checkout=success`,
      cancel_url: `${env.DASHBOARD_URL}/settings?checkout=cancel`,
      metadata: { orgId: org.id, tier: body.tier },
    });

    return { data: { url: session.url } };
  });

  /* ─── Customer portal ────────────────────────────────────── */
  app.post('/v1/billing/portal', async (request) => {
    if (!request.orgId) throw new AppError(401, 'Authentication required');

    const [org] = await db.select({ stripeCustomerId: organizations.stripeCustomerId })
      .from(organizations)
      .where(eq(organizations.id, request.orgId))
      .limit(1);
    if (!org?.stripeCustomerId) throw new AppError(400, 'No billing account found. Subscribe to a plan first.');

    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${env.DASHBOARD_URL}/settings`,
    });

    return { data: { url: session.url } };
  });

  /* ─── Get subscription status ────────────────────────────── */
  app.get('/v1/billing/subscription', async (request) => {
    if (!request.orgId) throw new AppError(401, 'Authentication required');

    const [org] = await db.select({
      tier: organizations.tier,
      stripeCustomerId: organizations.stripeCustomerId,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
    }).from(organizations).where(eq(organizations.id, request.orgId)).limit(1);
    if (!org) throw new NotFoundError('Organization not found');

    return { data: { tier: org.tier, hasSubscription: !!org.stripeSubscriptionId } };
  });

  /* ─── Stripe webhook ─────────────────────────────────────── */
  app.register(async function stripeWebhook(scope) {
    // Parse raw body for Stripe signature verification
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', function (_req, payload, done) {
      const chunks: Buffer[] = [];
      payload.on('data', (chunk: Buffer) => chunks.push(chunk));
      payload.on('end', () => done(null, Buffer.concat(chunks)));
      payload.on('error', done);
    });

    scope.post('/v1/billing/webhook', async (request, reply) => {
      const stripe = getStripe();
      const signature = request.headers['stripe-signature'] as string;

      if (!signature || !env.STRIPE_WEBHOOK_SECRET) {
        return reply.code(400).send({ error: 'Missing Stripe signature' });
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(request.body as Buffer, signature, env.STRIPE_WEBHOOK_SECRET);
      } catch {
        return reply.code(400).send({ error: 'Invalid Stripe signature' });
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          const orgId = session.metadata?.orgId;
          const tier = session.metadata?.tier;
          if (orgId && tier) {
            await db.update(organizations).set({
              tier,
              stripeCustomerId: session.customer as string,
              stripeSubscriptionId: session.subscription as string,
            }).where(eq(organizations.id, orgId));
          }
          break;
        }

        case 'customer.subscription.updated': {
          const sub = event.data.object as Stripe.Subscription;
          const customerId = sub.customer as string;
          // Sync status — if subscription is cancelled, downgrade
          if (sub.status === 'canceled' || sub.status === 'unpaid') {
            await db.update(organizations)
              .set({ tier: ORG_TIER.FREE, stripeSubscriptionId: null })
              .where(eq(organizations.stripeCustomerId, customerId));
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object as Stripe.Subscription;
          await db.update(organizations)
            .set({ tier: ORG_TIER.FREE, stripeSubscriptionId: null })
            .where(eq(organizations.stripeCustomerId, sub.customer as string));
          break;
        }
      }

      reply.code(200);
      return { received: true };
    });
  });
}
