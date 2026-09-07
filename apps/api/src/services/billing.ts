import { eq, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import {
  organizations,
  users,
  stripeEvents,
  GRACE_DAYS,
  PLAN,
  SUBSCRIPTION_STATUS,
  type Plan,
} from '@hovod/db';
import { db } from '../db.js';
import { env, appUrl } from '../env.js';
import { AppError } from '../middleware/error-handler.js';
import { invalidateEntitlement } from './entitlements.js';
import { sendEmail, welcomeTemplate, paymentFailedTemplate, subscriptionCanceledTemplate } from './email.js';

/**
 * Stripe is the source of truth for the subscription of an organization.
 *
 * Every path that learns something about a subscription (Checkout return,
 * webhook, nightly reconcile) funnels into {@link syncSubscription}, which
 * re-reads the subscription from Stripe and mirrors it into `organizations`.
 */

/* ─── Client ─────────────────────────────────────────────── */

let stripeClient: Stripe | null = null;

/** Lazily created Stripe client (cloud only). Tests replace it with {@link setStripeClient}. */
export function getStripe(): Stripe {
  if (stripeClient) return stripeClient;
  if (!env.STRIPE_SECRET_KEY) throw new AppError(503, 'Billing is not configured on this server');
  stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
    appInfo: { name: 'Hovod', url: 'https://github.com/synapsr/hovod' },
    maxNetworkRetries: 2,
  });
  return stripeClient;
}

/** Inject a fake / mocked client (unit tests). */
export function setStripeClient(client: Stripe | null): void {
  stripeClient = client;
}

/* ─── Prices ─────────────────────────────────────────────── */

export function priceIdFor(plan: Plan): string {
  const id = plan === PLAN.PRO ? env.STRIPE_PRICE_PRO : env.STRIPE_PRICE_BUSINESS;
  if (!id) throw new AppError(503, `No Stripe price configured for plan "${plan}"`);
  return id;
}

/** Stripe price id → plan, from the env (unknown prices map to `null`). */
export function planForPrice(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_PRO) return PLAN.PRO;
  if (priceId === env.STRIPE_PRICE_BUSINESS) return PLAN.BUSINESS;
  return null;
}

/* ─── Error mapping ──────────────────────────────────────── */

/** Stripe API / network failures surface as 502 with a short, safe message. */
export function stripeError(err: unknown, context: string): AppError {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[billing] ${context}: ${message}`);
  return new AppError(502, `Billing provider error while ${context}. Please try again in a moment.`, 'stripe_unavailable');
}

async function stripeCall<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw stripeError(err, context);
  }
}

/* ─── Customer ───────────────────────────────────────────── */

export interface OrgForBilling {
  id: string;
  name: string;
  stripeCustomerId: string | null;
}

/**
 * Stripe customer of an org, created on first use and persisted immediately
 * (before Checkout) so a crash between the two calls never orphans a customer.
 */
export async function ensureStripeCustomer(org: OrgForBilling, contact: { email: string; name?: string | null; userId?: string }): Promise<string> {
  if (org.stripeCustomerId) return org.stripeCustomerId;

  const customer = await stripeCall('creating the billing account', () =>
    getStripe().customers.create({
      email: contact.email,
      name: contact.name || org.name,
      metadata: { orgId: org.id, ...(contact.userId ? { userId: contact.userId } : {}) },
    }, { idempotencyKey: `customer:${org.id}` }),
  );

  await db.update(organizations)
    .set({ stripeCustomerId: customer.id })
    .where(eq(organizations.id, org.id));

  return customer.id;
}

/* ─── Checkout ───────────────────────────────────────────── */

/** UTC day stamp used in Checkout idempotency keys (one session per org/plan/day is reused). */
export function dayStamp(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Hosted Checkout URL for a subscription of `plan` on the org's customer. */
export async function createCheckoutSession(orgId: string, customerId: string, plan: Plan): Promise<string> {
  const session = await stripeCall('starting the checkout', () =>
    getStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceIdFor(plan), quantity: 1 }],
      client_reference_id: orgId,
      subscription_data: { metadata: { orgId } },
      success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/billing/cancel`,
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
      customer_update: { name: 'auto', address: 'auto' },
      allow_promotion_codes: true,
      payment_method_collection: 'always',
    }, { idempotencyKey: `checkout:${orgId}:${plan}:${dayStamp()}` }),
  );

  if (!session.url) throw new AppError(502, 'Billing provider did not return a checkout URL', 'stripe_unavailable');
  return session.url;
}

/** Customer/Checkout in one go — used by signup and org creation in cloud mode. */
export async function startCheckout(org: OrgForBilling, plan: Plan, contact: { email: string; name?: string | null; userId?: string }): Promise<string> {
  const customerId = await ensureStripeCustomer(org, contact);
  return createCheckoutSession(org.id, customerId, plan);
}

/** Retrieve a Checkout Session with its subscription expanded (the `/billing/sync` path). */
export async function retrieveCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  return stripeCall('reading the checkout session', () =>
    getStripe().checkout.sessions.retrieve(sessionId, { expand: ['subscription'] }),
  );
}

/* ─── Portal ─────────────────────────────────────────────── */

export async function createPortalSession(customerId: string): Promise<string> {
  const session = await stripeCall('opening the billing portal', () =>
    getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/settings`,
      // Without an explicit configuration Stripe uses the account default, which
      // is wrong when the account also serves another product.
      ...(env.STRIPE_PORTAL_CONFIGURATION_ID
        ? { configuration: env.STRIPE_PORTAL_CONFIGURATION_ID }
        : {}),
    }),
  );
  return session.url;
}

/* ─── Sync ───────────────────────────────────────────────── */

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

function unixToDate(seconds: number | null | undefined): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

/**
 * `current_period_end` moved from the subscription to its items in recent
 * Stripe API versions — read whichever is present.
 */
export function periodEndOf(sub: Stripe.Subscription): Date | null {
  const item = sub.items?.data?.[0] as { current_period_end?: number } | undefined;
  const legacy = (sub as unknown as { current_period_end?: number }).current_period_end;
  return unixToDate(item?.current_period_end ?? legacy);
}

export interface SyncResult {
  orgId: string;
  plan: Plan | null;
  status: string;
  /** First activation happened during this sync. */
  activated: boolean;
  /** Status transitions worth an email. */
  becamePastDue: boolean;
  becameCanceled: boolean;
}

/**
 * Mirror a Stripe subscription into `organizations` and fire the matching
 * side effects (idempotent, best effort). Resolves to `null` when no org owns
 * the subscription (logged, never thrown — a webhook must still return 200).
 */
export async function syncSubscription(subscriptionId: string, now: Date = new Date()): Promise<SyncResult | null> {
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
  return applySubscription(sub, now);
}

/** Same as {@link syncSubscription} for a subscription object already in hand (webhook payload, tests). */
export async function applySubscription(sub: Stripe.Subscription, now: Date = new Date()): Promise<SyncResult | null> {
  const customerId = idOf(sub.customer as string | { id: string } | null);
  const metadataOrgId = sub.metadata?.orgId || null;

  // Org lookup order: by subscription id → by metadata.orgId → by customer id.
  let org = await findOrg((o) => eq(o.stripeSubscriptionId, sub.id));
  if (!org && metadataOrgId) org = await findOrg((o) => eq(o.id, metadataOrgId));
  if (!org && customerId) org = await findOrg((o) => eq(o.stripeCustomerId, customerId));
  if (!org) {
    console.error(`[billing] subscription ${sub.id} (customer ${customerId ?? '?'}) matches no organization`);
    return null;
  }

  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  const mappedPlan = planForPrice(priceId);
  if (priceId && !mappedPlan) {
    console.error(`[billing] subscription ${sub.id} has unknown price ${priceId} — keeping plan "${org.plan}"`);
  }
  const plan = (mappedPlan ?? (org.plan as Plan | null)) ?? null;

  const status = sub.status;
  const previousStatus = org.subscriptionStatus;
  const isLive = status === SUBSCRIPTION_STATUS.ACTIVE || status === SUBSCRIPTION_STATUS.TRIALING;

  const graceUntil = status === SUBSCRIPTION_STATUS.PAST_DUE
    ? (org.graceUntil ?? new Date(now.getTime() + GRACE_DAYS * 86_400_000))
    : null;
  const activatedAt = org.activatedAt ?? (isLive ? now : null);
  const activated = !org.activatedAt && !!activatedAt;

  await db.update(organizations)
    .set({
      plan,
      subscriptionStatus: status,
      stripeSubscriptionId: sub.id,
      stripeCustomerId: customerId ?? org.stripeCustomerId,
      stripePriceId: priceId,
      currentPeriodEnd: periodEndOf(sub),
      cancelAtPeriodEnd: sub.cancel_at_period_end ? 1 : 0,
      graceUntil,
      activatedAt,
    })
    .where(eq(organizations.id, org.id));

  invalidateEntitlement(org.id);

  // Activation doubles as email verification: Stripe collected the address.
  if (isLive) {
    await db.update(users)
      .set({ emailVerifiedAt: now })
      .where(sql`${users.id} = ${org.ownerId} AND ${users.emailVerifiedAt} IS NULL`)
      .catch(() => {});
  }

  const result: SyncResult = {
    orgId: org.id,
    plan,
    status,
    activated,
    becamePastDue: status === SUBSCRIPTION_STATUS.PAST_DUE && previousStatus !== SUBSCRIPTION_STATUS.PAST_DUE,
    becameCanceled: status === SUBSCRIPTION_STATUS.CANCELED && previousStatus !== SUBSCRIPTION_STATUS.CANCELED,
  };

  await notify(org, result, graceUntil).catch((err) => {
    console.warn(`[billing] notification for org ${org.id} failed: ${(err as Error).message}`);
  });

  return result;
}

type OrgRow = typeof organizations.$inferSelect;

async function findOrg(where: (o: typeof organizations) => ReturnType<typeof eq>): Promise<OrgRow | null> {
  const [row] = await db.select().from(organizations).where(where(organizations)).limit(1);
  return row ?? null;
}

async function ownerContact(org: OrgRow): Promise<{ email: string; name: string | null } | null> {
  const [owner] = await db.select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, org.ownerId))
    .limit(1);
  return owner ?? null;
}

/** Welcome / payment-failed / canceled emails — one per transition, best effort. */
async function notify(org: OrgRow, result: SyncResult, graceUntil: Date | null): Promise<void> {
  if (!result.activated && !result.becamePastDue && !result.becameCanceled) return;
  const owner = await ownerContact(org);
  if (!owner) return;

  if (result.activated) {
    await sendEmail({ to: owner.email, ...welcomeTemplate({ name: owner.name, orgName: org.name, plan: result.plan ?? 'pro' }) });
  }
  if (result.becamePastDue) {
    await sendEmail({ to: owner.email, ...paymentFailedTemplate({ orgName: org.name, graceUntil }) });
  }
  if (result.becameCanceled) {
    await sendEmail({ to: owner.email, ...subscriptionCanceledTemplate({ orgName: org.name }) });
  }
}

/* ─── Webhook ────────────────────────────────────────────── */

/** `INSERT IGNORE` — false when the event was already processed. */
export async function claimStripeEvent(eventId: string, type: string): Promise<boolean> {
  const [result] = await db.insert(stripeEvents)
    .ignore()
    .values({ id: eventId, type });
  return result.affectedRows > 0;
}

/** Forget a claimed event so Stripe's retry gets processed (after an internal error). */
export async function releaseStripeEvent(eventId: string): Promise<void> {
  await db.delete(stripeEvents).where(eq(stripeEvents.id, eventId)).catch(() => {});
}

/** Subscription id an event refers to, or null when the event carries none. */
export function subscriptionIdOfEvent(event: Stripe.Event): string | null {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      return idOf(session.subscription as string | { id: string } | null);
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const sub = event.data.object as Stripe.Subscription;
      return sub.id;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.payment_action_required': {
      const invoice = event.data.object as Stripe.Invoice & {
        subscription?: string | { id: string } | null;
        parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
      };
      // Recent API versions moved `invoice.subscription` under `parent.subscription_details`.
      return idOf(invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null);
    }
    default:
      return null;
  }
}

/** Route a verified webhook event. Returns what was done (for the response / logs). */
export async function handleStripeEvent(event: Stripe.Event): Promise<{ handled: boolean; subscriptionId: string | null }> {
  const subscriptionId = subscriptionIdOfEvent(event);
  if (!subscriptionId) return { handled: false, subscriptionId: null };
  await syncSubscription(subscriptionId);
  return { handled: true, subscriptionId };
}

/* ─── Pending customers (reconcile) ──────────────────────── */

/** Orgs whose subscription must be re-read from Stripe. */
export async function orgsWithSubscription(): Promise<{ id: string; stripeSubscriptionId: string }[]> {
  const rows = await db.select({ id: organizations.id, stripeSubscriptionId: organizations.stripeSubscriptionId })
    .from(organizations)
    .where(sql`${organizations.stripeSubscriptionId} IS NOT NULL`);
  return rows.filter((r): r is { id: string; stripeSubscriptionId: string } => !!r.stripeSubscriptionId);
}

/** Orgs that started a checkout but never activated (kept pending; the paywall handles them). */
export async function countPendingOrgs(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`COUNT(*)` })
    .from(organizations)
    .where(sql`${organizations.stripeCustomerId} IS NOT NULL AND ${organizations.stripeSubscriptionId} IS NULL AND ${organizations.activatedAt} IS NULL`);
  return Number(row?.count ?? 0);
}
