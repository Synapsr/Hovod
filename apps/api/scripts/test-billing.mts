#!/usr/bin/env tsx
/**
 * `syncSubscription()` mapping against a real (migrated) MySQL with a fake
 * Stripe client, plus the `/v1/auth/me`-facing entitlement after each sync.
 *
 *   HOVOD_TEST_DATABASE_URL=mysql://root:root@127.0.0.1:33307/hovod_c_fresh \
 *     npx tsx apps/api/scripts/test-billing.mts
 *
 * Skips (exit 0) when HOVOD_TEST_DATABASE_URL is unset. The database must have
 * the migrations applied (run packages/db/scripts/test-migration-0004.mjs first).
 */
import assert from 'node:assert/strict';

const DB_URL = process.env.HOVOD_TEST_DATABASE_URL;
if (!DB_URL) {
  console.log('HOVOD_TEST_DATABASE_URL not set — skipping billing sync tests');
  process.exit(0);
}

// Cloud-mode env with placeholders (no network call is made: Stripe is faked, Resend is stubbed).
Object.assign(process.env, {
  DATABASE_URL: DB_URL,
  S3_ENDPOINT: 'http://127.0.0.1:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'hovod-vod',
  S3_ACCESS_KEY_ID: 'x', S3_SECRET_ACCESS_KEY: 'y', S3_PUBLIC_BASE_URL: 'http://127.0.0.1:9000/hovod-vod',
  JWT_SECRET: 'x'.repeat(40),
  HOVOD_CLOUD: 'true', APP_URL: 'https://app.example.test',
  STRIPE_SECRET_KEY: 'sk_test_placeholder', STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
  STRIPE_PRICE_PRO: 'price_pro_test', STRIPE_PRICE_BUSINESS: 'price_biz_test',
  RESEND_API_KEY: 're_placeholder', EMAIL_FROM: 'Hovod <no-reply@example.test>',
});

// Capture outgoing emails instead of hitting Resend.
const sentEmails: { to: string; subject: string }[] = [];
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? '{}');
  sentEmails.push({ to: body.to?.[0], subject: body.subject });
  return new Response(JSON.stringify({ id: `email_${sentEmails.length}` }), { status: 200 });
}) as typeof fetch;

const { db, pool } = await import('../src/db.js');
const { users, organizations, GRACE_DAYS } = await import('@hovod/db');
const { eq } = await import('drizzle-orm');
const billing = await import('../src/services/billing.js');
const { getOrgEntitlement, clearEntitlementCache } = await import('../src/services/entitlements.js');

/* ─── Fake Stripe ────────────────────────────────────────── */

type FakeSub = {
  id: string; status: string; customer: string; cancel_at_period_end: boolean;
  metadata?: Record<string, string>;
  items: { data: { price: { id: string }; current_period_end?: number }[] };
  current_period_end?: number;
};
const subs = new Map<string, FakeSub>();
/** Customers Stripe knows about, plus every create() call, so the tests can assert both. */
const customers = new Map<string, { id: string; deleted?: boolean }>();
const customerCreates: { email: string; idempotencyKey?: string }[] = [];
const fakeStripe = {
  subscriptions: {
    retrieve: async (id: string) => {
      const sub = subs.get(id);
      if (!sub) throw new Error(`No such subscription: ${id}`);
      return sub;
    },
  },
  customers: {
    retrieve: async (id: string) => {
      const found = customers.get(id);
      if (!found) {
        // Shape of the real error, including the test/live wording Stripe adds.
        const err = Object.assign(new Error(`No such customer: '${id}'; a similar object exists in test mode, but a live mode key was used to make this request.`), {
          type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404,
        });
        throw err;
      }
      return found;
    },
    create: async (params: { email: string }, opts?: { idempotencyKey?: string }) => {
      customerCreates.push({ email: params.email, idempotencyKey: opts?.idempotencyKey });
      const created = { id: `cus_new${customerCreates.length}` };
      customers.set(created.id, created);
      return created;
    },
  },
};
billing.setStripeClient(fakeStripe as never);

const NOW = new Date('2026-09-04T12:00:00Z');
const PERIOD_END = Math.floor(new Date('2026-10-04T12:00:00Z').getTime() / 1000);

/* ─── Fixture ────────────────────────────────────────────── */

await pool.query('DELETE FROM organizations WHERE id LIKE ?', ['bt_%']);
await pool.query('DELETE FROM users WHERE id LIKE ?', ['bt_%']);
await db.insert(users).values({ id: 'bt_u1', email: 'owner@example.test', passwordHash: 'h', name: 'Owner' });
await db.insert(organizations).values({ id: 'bt_o1', name: 'Acme', slug: 'bt-acme', ownerId: 'bt_u1', plan: 'pro', stripeCustomerId: 'cus_bt1' });

async function org(id = 'bt_o1') {
  clearEntitlementCache();
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  return row;
}

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`  ok   ${label}`); };

/* 1. active (period end on the item, as in recent API versions) */
subs.set('sub_bt1', { id: 'sub_bt1', status: 'active', customer: 'cus_bt1', cancel_at_period_end: false, metadata: { orgId: 'bt_o1' }, items: { data: [{ price: { id: 'price_pro_test' }, current_period_end: PERIOD_END }] } });
let r = await billing.syncSubscription('sub_bt1', NOW);
assert.equal(r?.orgId, 'bt_o1'); assert.equal(r?.activated, true);
let o = await org();
assert.equal(o.subscriptionStatus, 'active'); assert.equal(o.plan, 'pro'); assert.equal(o.stripeSubscriptionId, 'sub_bt1'); assert.equal(o.stripePriceId, 'price_pro_test');
assert.equal(o.currentPeriodEnd?.toISOString(), new Date(PERIOD_END * 1000).toISOString());
assert.equal(o.activatedAt?.toISOString(), NOW.toISOString()); assert.equal(o.graceUntil, null); assert.equal(o.cancelAtPeriodEnd, 0);
ok('active → status/plan/price/period_end/activated_at mirrored (found via metadata.orgId)');
assert.equal((await getOrgEntitlement('bt_o1')).mode, 'active'); ok('entitlement active');
const [owner] = await db.select({ v: users.emailVerifiedAt }).from(users).where(eq(users.id, 'bt_u1'));
assert.ok(owner.v); ok('owner email_verified_at set at activation');
assert.deepEqual(sentEmails.map((e) => e.subject), ['Welcome to Hovod — your subscription is active']); ok('welcome email sent once');

/* 2. business price via legacy top-level current_period_end, cancel_at_period_end */
subs.set('sub_bt1', { ...subs.get('sub_bt1')!, cancel_at_period_end: true, items: { data: [{ price: { id: 'price_biz_test' } }] }, current_period_end: PERIOD_END + 86_400 });
r = await billing.syncSubscription('sub_bt1', NOW);
o = await org();
assert.equal(o.plan, 'business'); assert.equal(o.cancelAtPeriodEnd, 1);
assert.equal(o.currentPeriodEnd?.toISOString(), new Date((PERIOD_END + 86_400) * 1000).toISOString());
assert.equal(r?.activated, false); assert.equal(o.activatedAt?.toISOString(), NOW.toISOString());
ok('plan switch → business, cancel_at_period_end, legacy current_period_end, activated_at untouched');
assert.equal(sentEmails.length, 1); ok('no second welcome email');

/* 3. past_due → grace_until = now + 7 d, stable on re-sync */
subs.set('sub_bt1', { ...subs.get('sub_bt1')!, status: 'past_due', cancel_at_period_end: false });
r = await billing.syncSubscription('sub_bt1', NOW);
o = await org();
assert.equal(o.subscriptionStatus, 'past_due');
assert.equal(o.graceUntil?.toISOString(), new Date(NOW.getTime() + GRACE_DAYS * 86_400_000).toISOString());
assert.equal(r?.becamePastDue, true);
ok('past_due → grace_until = now + 7 days');
assert.equal((await getOrgEntitlement('bt_o1')).mode, 'grace'); ok('entitlement grace (inside the window)');
assert.equal(sentEmails.at(-1)?.subject, 'Payment failed for Acme'); ok('payment-failed email sent');
const later = new Date(NOW.getTime() + 2 * 86_400_000);
r = await billing.syncSubscription('sub_bt1', later);
o = await org();
assert.equal(o.graceUntil?.toISOString(), new Date(NOW.getTime() + GRACE_DAYS * 86_400_000).toISOString());
assert.equal(r?.becamePastDue, false);
ok('re-sync while past_due keeps the original grace deadline and sends no new email');
assert.equal(sentEmails.length, 2);

/* 4. recovery → grace cleared */
subs.set('sub_bt1', { ...subs.get('sub_bt1')!, status: 'active' });
await billing.syncSubscription('sub_bt1', later);
o = await org();
assert.equal(o.subscriptionStatus, 'active'); assert.equal(o.graceUntil, null);
ok('payment recovered → active, grace_until cleared');

/* 5. unknown price → plan kept, status still applied */
subs.set('sub_bt1', { ...subs.get('sub_bt1')!, items: { data: [{ price: { id: 'price_unknown' }, current_period_end: PERIOD_END }] } });
await billing.syncSubscription('sub_bt1', later);
o = await org();
assert.equal(o.plan, 'business'); assert.equal(o.stripePriceId, 'price_unknown');
ok('unknown price → current plan kept (logged), price id recorded');

/* 6. canceled → readonly + email */
subs.set('sub_bt1', { ...subs.get('sub_bt1')!, status: 'canceled', items: { data: [{ price: { id: 'price_biz_test' } }] } });
r = await billing.syncSubscription('sub_bt1', later);
o = await org();
assert.equal(o.subscriptionStatus, 'canceled'); assert.equal(r?.becameCanceled, true);
assert.equal((await getOrgEntitlement('bt_o1')).mode, 'readonly'); ok('canceled → readonly');
assert.equal(sentEmails.at(-1)?.subject, 'Your Hovod subscription for Acme has ended'); ok('canceled email sent');

/* 7. lookup by customer id when metadata and subscription id are unknown */
await db.insert(users).values({ id: 'bt_u2', email: 'two@example.test', passwordHash: 'h' });
await db.insert(organizations).values({ id: 'bt_o2', name: 'Two', slug: 'bt-two', ownerId: 'bt_u2', plan: 'pro', stripeCustomerId: 'cus_bt2' });
subs.set('sub_bt2', { id: 'sub_bt2', status: 'trialing', customer: 'cus_bt2', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_pro_test' }, current_period_end: PERIOD_END }] } });
r = await billing.syncSubscription('sub_bt2', NOW);
assert.equal(r?.orgId, 'bt_o2'); assert.equal((await org('bt_o2')).subscriptionStatus, 'trialing');
assert.equal((await getOrgEntitlement('bt_o2')).mode, 'active');
ok('org resolved through stripe_customer_id; trialing → active entitlement');

/* 8. orphan subscription → null, no throw */
subs.set('sub_none', { id: 'sub_none', status: 'active', customer: 'cus_nobody', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_pro_test' } }] } });
assert.equal(await billing.syncSubscription('sub_none', NOW), null); ok('subscription without an org → null (logged, not thrown)');

/* 9. event bookkeeping */
assert.equal(await billing.claimStripeEvent('evt_bt_1', 'invoice.paid'), true);
assert.equal(await billing.claimStripeEvent('evt_bt_1', 'invoice.paid'), false);
await billing.releaseStripeEvent('evt_bt_1');
assert.equal(await billing.claimStripeEvent('evt_bt_1', 'invoice.paid'), true);
ok('stripe_events claim/duplicate/release');

assert.equal(billing.subscriptionIdOfEvent({ type: 'invoice.paid', data: { object: { parent: { subscription_details: { subscription: 'sub_x' } } } } } as never), 'sub_x');
assert.equal(billing.subscriptionIdOfEvent({ type: 'invoice.paid', data: { object: { subscription: { id: 'sub_y' } } } } as never), 'sub_y');
assert.equal(billing.subscriptionIdOfEvent({ type: 'checkout.session.completed', data: { object: { subscription: 'sub_z' } } } as never), 'sub_z');
assert.equal(billing.subscriptionIdOfEvent({ type: 'customer.created', data: { object: {} } } as never), null);
ok('subscription id extracted from checkout / subscription / invoice (old and new shapes) events');

/* 10. ensureStripeCustomer: a customer id Stripe no longer knows */
const contact = { email: 'owner@example.test', name: 'Owner' };

// A live id that resolves is returned as-is, no creation.
customers.set('cus_live_ok', { id: 'cus_live_ok' });
const before = customerCreates.length;
assert.equal(await billing.ensureStripeCustomer({ id: 'bt_o1', name: 'Acme', stripeCustomerId: 'cus_live_ok' }, contact), 'cus_live_ok');
assert.equal(customerCreates.length, before);
ok('known customer reused, no second customer created');

// The test → live case: the stored id is gone, so a fresh customer replaces it.
await pool.query(
  'UPDATE organizations SET stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?, subscription_status = ? WHERE id = ?',
  ['cus_stale_test_mode', 'sub_stale', 'pro', 'active', 'bt_o1'],
);
const fresh = await billing.ensureStripeCustomer({ id: 'bt_o1', name: 'Acme', stripeCustomerId: 'cus_stale_test_mode' }, contact);
assert.notEqual(fresh, 'cus_stale_test_mode');
assert.equal(customerCreates.length, before + 1);
ok('customer missing in this mode → replaced instead of a 502');

// The idempotency key must not replay the customer we are replacing.
assert.equal(customerCreates.at(-1)?.idempotencyKey, 'customer:bt_o1:cus_stale_test_mode');
ok('idempotency key discriminated by the stale id');

// The subscription hanging off the dead customer must not survive it.
const [reset] = await db.select().from(organizations).where(eq(organizations.id, 'bt_o1'));
assert.equal(reset.stripeCustomerId, fresh);
assert.equal(reset.stripeSubscriptionId, null);
assert.equal(reset.plan, null);
assert.equal(reset.subscriptionStatus, null);
ok('stale subscription, plan and status cleared with the customer');

// A first-time org still gets the plain key.
await billing.ensureStripeCustomer({ id: 'bt_o2', name: 'Two', stripeCustomerId: null }, contact);
assert.equal(customerCreates.at(-1)?.idempotencyKey, 'customer:bt_o2');
ok('first customer of an org keeps the plain idempotency key');

await pool.query('DELETE FROM organizations WHERE id LIKE ?', ['bt_%']);
await pool.query('DELETE FROM users WHERE id LIKE ?', ['bt_%']);
await pool.query('DELETE FROM stripe_events WHERE id LIKE ?', ['evt_bt_%']);
await pool.end();
console.log(`\n${passed} checks passed`);
