#!/usr/bin/env node
/**
 * Create (or update) everything Hovod Cloud needs in a Stripe account, and print
 * the environment variables to deploy.
 *
 *   STRIPE_SECRET_KEY=sk_test_... APP_URL=https://app.hovod.dev node scripts/setup-stripe.mjs
 *
 * Idempotent: products and prices are matched on `metadata.hovod_plan`, the
 * portal configuration and the webhook endpoint on their url/name, so running it
 * twice changes nothing. Run it against a test key first, then the live key.
 *
 * Options:
 *   --currency=usd        primary currency (default usd)
 *   --also=eur,gbp        additional currencies, same amount, no conversion
 *   --pro=29 --business=99   monthly amounts, whole units
 *   --dry-run             print what would happen, touch nothing
 */
import Stripe from 'stripe';
import { PLAN, PLAN_LIMITS } from '@hovod/db';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DRY = process.argv.includes('--dry-run');

const key = process.env.STRIPE_SECRET_KEY;
if (!key) fail('STRIPE_SECRET_KEY is required.');
const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
if (!appUrl) fail('APP_URL is required, e.g. APP_URL=https://app.hovod.dev');

const primary = arg('currency', 'usd').toLowerCase();
const extra = arg('also', 'eur').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean).filter((c) => c !== primary);
const amounts = { [PLAN.PRO]: Number(arg('pro', 29)), [PLAN.BUSINESS]: Number(arg('business', 99)) };

const stripe = new Stripe(key);
const live = key.startsWith('sk_live') || key.startsWith('rk_live');

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}
const log = (...a) => console.log(' ', ...a);

/** Human description of a plan, built from the limits the product actually enforces. */
function describe(plan) {
  const l = PLAN_LIMITS[plan];
  const name = plan === PLAN.PRO ? 'Pro' : 'Business';
  return `Hovod Cloud ${name} — ${l.encodingMinutes.toLocaleString('en-US')} encoding minutes, ${l.aiMinutes} AI minutes, ${l.storageGb} GB storage, unlimited streaming, ${l.apiKeys} API keys, ${l.members} team members.`;
}

/** Amounts in the smallest unit, for every configured currency. */
function currencyOptions(plan) {
  return Object.fromEntries(extra.map((c) => [c, { unit_amount: amounts[plan] * 100 }]));
}

async function findByMetadata(list, plan) {
  for await (const item of list) {
    if (item.metadata?.hovod_plan === plan && item.active !== false) return item;
  }
  return null;
}

async function ensureProduct(plan) {
  const found = await findByMetadata(stripe.products.list({ limit: 100 }), plan);
  if (found) {
    log(`product ${plan}: reusing ${found.id}`);
    return found;
  }
  if (DRY) { log(`product ${plan}: would create`); return { id: `prod_DRY_${plan}` }; }
  const created = await stripe.products.create({
    name: `Hovod ${plan === PLAN.PRO ? 'Pro' : 'Business'}`,
    description: describe(plan),
    metadata: { hovod_plan: plan },
  });
  log(`product ${plan}: created ${created.id}`);
  return created;
}

async function ensurePrice(plan, productId) {
  // A dry run never created the product, so there is nothing to look up.
  if (DRY && productId.startsWith('prod_DRY')) {
    log(`price ${plan}: would create ${primary.toUpperCase()} ${amounts[plan]}${extra.length ? ' + ' + extra.map((c) => c.toUpperCase()).join(', ') : ''}`);
    return { id: `price_DRY_${plan}` };
  }
  const found = await findByMetadata(stripe.prices.list({ product: productId, limit: 100 }), plan);
  if (found) {
    log(`price ${plan}: reusing ${found.id} (${found.currency.toUpperCase()} ${found.unit_amount / 100})`);
    return found;
  }
  if (DRY) { log(`price ${plan}: would create ${primary.toUpperCase()} ${amounts[plan]} + ${extra.join(', ').toUpperCase()}`); return { id: `price_DRY_${plan}` }; }
  const created = await stripe.prices.create({
    product: productId,
    currency: primary,
    unit_amount: amounts[plan] * 100,
    recurring: { interval: 'month' },
    currency_options: currencyOptions(plan),
    nickname: `Hovod ${plan === PLAN.PRO ? 'Pro' : 'Business'} monthly`,
    metadata: { hovod_plan: plan },
  });
  log(`price ${plan}: created ${created.id} (${primary.toUpperCase()} ${amounts[plan]}${extra.length ? ' + ' + extra.map((c) => c.toUpperCase()).join(', ') : ''})`);
  return created;
}

async function ensurePortal(products) {
  const existing = [];
  for await (const c of stripe.billingPortal.configurations.list({ limit: 100, active: true })) {
    if (c.business_profile?.headline === 'Hovod Cloud') existing.push(c);
  }
  const payload = {
    business_profile: {
      headline: 'Hovod Cloud',
      privacy_policy_url: 'https://hovod.dev/en/privacy',
      terms_of_service_url: 'https://hovod.dev/en/terms',
    },
    default_return_url: `${appUrl}/settings`,
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        proration_behavior: 'create_prorations',
        products: products.map((p) => ({ product: p.product, prices: [p.price] })),
      },
    },
  };
  if (DRY) { log('portal: would create/update'); return { id: 'bpc_DRY' }; }
  const config = existing[0]
    ? await stripe.billingPortal.configurations.update(existing[0].id, payload)
    : await stripe.billingPortal.configurations.create(payload);
  log(`portal: ${existing[0] ? 'updated' : 'created'} ${config.id}`);
  if (!config.features.subscription_update.products) {
    log('  ⚠ Stripe accepted the plan list but did not store it. Open the Stripe');
    log('    Dashboard → Settings → Billing → Customer portal and tick "Customers');
    log('    can switch plans", adding both products. Everything else is set.');
  }
  return config;
}

const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
];

async function ensureWebhook() {
  const url = `${appUrl}/v1/billing/webhook`;
  for await (const e of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (e.url === url && e.status === 'enabled') {
      log(`webhook: reusing ${e.id} (secret not retrievable — keep the one you deployed)`);
      return { id: e.id, secret: null };
    }
  }
  if (DRY) { log(`webhook: would create for ${url}`); return { id: 'we_DRY', secret: 'whsec_DRY' }; }
  const created = await stripe.webhookEndpoints.create({
    url,
    description: 'Hovod Cloud',
    enabled_events: WEBHOOK_EVENTS,
  });
  log(`webhook: created ${created.id}`);
  return created;
}

/* ─── Run ──────────────────────────────────────────────────── */

console.log(`\nHovod Cloud — Stripe setup (${live ? 'LIVE' : 'test'} mode)${DRY ? ' [dry run]' : ''}\n`);
if (live && !DRY && !process.argv.includes('--yes')) {
  fail('Refusing to touch a live account without --yes. Review the output of --dry-run first.');
}

const out = {};
for (const plan of [PLAN.PRO, PLAN.BUSINESS]) {
  const product = await ensureProduct(plan);
  const price = await ensurePrice(plan, product.id);
  out[plan] = { product: product.id, price: price.id };
}
const portal = await ensurePortal(Object.values(out));
const webhook = await ensureWebhook();

console.log('\n  ── Environment ───────────────────────────────────────────\n');
console.log(`  HOVOD_CLOUD=true`);
console.log(`  APP_URL=${appUrl}`);
console.log(`  STRIPE_SECRET_KEY=${key.slice(0, 12)}…    (the key you passed)`);
console.log(`  STRIPE_WEBHOOK_SECRET=${webhook.secret ?? '…keep the deployed one…'}`);
console.log(`  STRIPE_PRICE_PRO=${out[PLAN.PRO].price}`);
console.log(`  STRIPE_PRICE_BUSINESS=${out[PLAN.BUSINESS].price}`);
console.log(`  STRIPE_PORTAL_CONFIGURATION_ID=${portal.id}`);
console.log('\n  Still to do by hand: Stripe Tax registrations, and dunning set to');
console.log('  "cancel after all retries fail" so it matches Hovod\'s grace period.\n');
