#!/usr/bin/env node
/**
 * Cloud-mode integration: boots the built API (apps/api/dist) in self-host mode
 * and in cloud mode with placeholder Stripe keys against a real MySQL / Redis / S3
 * and exercises the HTTP contracts (signup, /me, entitlement 402s, plan limits,
 * invitations, password reset + CLI, signed-webhook dedupe, boot refusal).
 *
 * Needs `npm run build -w @hovod/api` and a test stack. Enable with HOVOD_TEST_STACK=1
 * (skips otherwise); override the defaults with:
 *   HOVOD_TEST_MYSQL_ROOT_URL  (default mysql://root:root@127.0.0.1:33307/mysql — must allow CREATE DATABASE)
 *   HOVOD_TEST_REDIS_URL       (default redis://127.0.0.1:63790)
 *   HOVOD_TEST_S3_ENDPOINT / HOVOD_TEST_S3_KEY / HOVOD_TEST_S3_SECRET / HOVOD_TEST_S3_BUCKET
 *   HOVOD_TEST_PORT            (default 3456; the cloud boot uses PORT + 1)
 *
 * Stripe is contacted with the fake key (expected: 502 from signup / checkout, 500 from
 * subscription webhooks) — no real Stripe account is touched.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import Stripe from 'stripe';

if (!process.env.HOVOD_TEST_STACK) {
  console.log('HOVOD_TEST_STACK not set — skipping cloud integration tests');
  process.exit(0);
}

const WT = process.cwd();
const ROOT = process.env.HOVOD_TEST_MYSQL_ROOT_URL ?? 'mysql://root:root@127.0.0.1:33307/mysql';
/** Same server/credentials as ROOT, another database. */
const dbUrl = (name) => ROOT.replace(/\/[^/?]*(\?.*)?$/, `/${name}$1`);
const S3_ENDPOINT = process.env.HOVOD_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const S3_BUCKET = process.env.HOVOD_TEST_S3_BUCKET ?? 'hovod-vod';
const BASE_PORT = Number(process.env.HOVOD_TEST_PORT ?? 3456);
const BASE_ENV = {
  PATH: process.env.PATH,
  REDIS_URL: process.env.HOVOD_TEST_REDIS_URL ?? 'redis://127.0.0.1:63790',
  S3_ENDPOINT, S3_REGION: 'us-east-1', S3_BUCKET,
  S3_ACCESS_KEY_ID: process.env.HOVOD_TEST_S3_KEY ?? 'minioadmin', S3_SECRET_ACCESS_KEY: process.env.HOVOD_TEST_S3_SECRET ?? 'minioadmin',
  S3_PUBLIC_BASE_URL: `${S3_ENDPOINT}/${S3_BUCKET}`,
  JWT_SECRET: 'integration-secret-'.repeat(3),
  NODE_ENV: 'test',
};
const CLOUD_ENV = {
  HOVOD_CLOUD: 'true', APP_URL: 'https://app.example.test/',
  STRIPE_SECRET_KEY: 'sk_test_placeholder_not_a_real_key', STRIPE_WEBHOOK_SECRET: 'whsec_test_integration_secret',
  STRIPE_PRICE_PRO: 'price_pro_placeholder', STRIPE_PRICE_BUSINESS: 'price_biz_placeholder',
  RESEND_API_KEY: 're_placeholder', EMAIL_FROM: 'Hovod <no-reply@example.test>',
};

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ok   ${label}`); };

async function resetDb(name) {
  const c = await mysql.createConnection(ROOT);
  await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await c.query(`CREATE DATABASE \`${name}\``);
  await c.end();
}

function boot(env, port) {
  const child = spawn('node', ['apps/api/dist/index.js'], {
    cwd: WT, env: { ...BASE_ENV, ...env, PORT: String(port), DATABASE_URL: dbUrl(env.DB) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, log: () => out };
}

async function waitReady(port, exited, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 300))]);
    if (done !== null) throw new Error(`API exited early with code ${done}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health/ready`);
      if (r.ok) return;
    } catch {}
  }
  throw new Error('API did not become ready');
}

async function api(port, method, path, body, token, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

/* ═══ 1. Self-host ═══════════════════════════════════════════ */
console.log('\n[1] self-host boot (HOVOD_CLOUD unset)');
await resetDb('hovod_it_selfhost');
{
  const port = BASE_PORT;
  const p = boot({ DB: 'hovod_it_selfhost' }, port);
  try {
    await waitReady(port, p.exited);
    ok('API ready');
    let r = await api(port, 'GET', '/v1/config');
    assert.equal(r.json.data.cloud, false); assert.deepEqual(r.json.data.plans, []); assert.equal(r.json.data.emailEnabled, false);
    ok('/v1/config → cloud:false, plans:[], emailEnabled:false');

    r = await api(port, 'POST', '/v1/auth/signup', { email: 'owner@example.test', password: 'password123', name: 'Owner' });
    assert.equal(r.status, 201); assert.ok(r.json.data.token); assert.equal(r.json.data.checkoutUrl, undefined);
    const token = r.json.data.token;
    ok('signup → 201 { token } and no checkoutUrl');

    r = await api(port, 'GET', '/v1/auth/me', undefined, token);
    assert.equal(r.status, 200);
    assert.equal(r.json.data.cloud, false); assert.equal(r.json.data.limits, null);
    assert.equal(r.json.data.org.entitlement, 'selfhost'); assert.equal(r.json.data.org.role, 'owner');
    assert.equal(r.json.data.org.plan, null); assert.equal(r.json.data.org.subscriptionStatus, null);
    assert.deepEqual(r.json.data.usage, { encodingMinutes: 0, aiMinutes: 0, storageBytes: 0 });
    assert.ok(!('tier' in r.json.data.org)); assert.ok(!('billingEnabled' in r.json.data));
    ok('/v1/auth/me → { user, org{…entitlement:selfhost}, cloud:false, limits:null, usage }');
    const orgId = r.json.data.org.id;

    r = await api(port, 'POST', '/v1/assets', { title: 'Video' }, token);
    assert.equal(r.status, 201); ok('POST /v1/assets → 201 (no 402)');
    const assetId = r.json.data.id;
    r = await api(port, 'PATCH', `/v1/assets/${assetId}`, { title: 'Renamed' }, token);
    assert.equal(r.status, 200); ok('PATCH /v1/assets/:id → 200');
    r = await api(port, 'PATCH', `/v1/orgs/${orgId}`, { name: 'Acme' }, token);
    assert.equal(r.status, 200); assert.ok(!('tier' in r.json.data)); ok('PATCH /v1/orgs/:id → 200, no tier field');
    r = await api(port, 'GET', `/v1/orgs/${orgId}/usage`, undefined, token);
    assert.equal(r.json.data.limits, null); assert.equal(r.json.data.entitlement, 'selfhost'); ok('GET /v1/orgs/:id/usage → limits:null');

    // API keys are unlimited in self-host (old cap was 100; the old tier table had 1/5/20)
    for (let i = 0; i < 6; i++) {
      r = await api(port, 'POST', `/v1/orgs/${orgId}/api-keys`, { name: `k${i}` }, token);
      assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    ok('6 API keys created (no plan cap in self-host)');
    const apiKey = r.json.data.key;
    r = await api(port, 'POST', '/v1/assets', { title: 'By key' }, undefined, { 'x-api-key': apiKey });
    assert.equal(r.status, 201); ok('API-key auth still creates assets (201)');

    r = await api(port, 'POST', '/v1/orgs', { name: 'Second' }, token);
    assert.equal(r.status, 201); assert.ok(r.json.data.token); assert.equal(r.json.data.checkoutUrl, undefined);
    ok('POST /v1/orgs → 201 { token }, no checkout in self-host');

    // Invitations (email not configured → link only)
    r = await api(port, 'POST', `/v1/orgs/${orgId}/members/invite`, { email: 'Invitee@Example.test', role: 'member' }, token);
    assert.equal(r.status, 201); assert.equal(r.json.data.emailSent, false); assert.match(r.json.data.inviteUrl, /^http:\/\/localhost:3000\/invite\//);
    ok(`invite → 201 { inviteUrl, emailSent:false } (${r.json.data.inviteUrl.slice(0, 40)}…)`);
    const inviteToken = r.json.data.inviteUrl.split('/invite/')[1];
    r = await api(port, 'GET', `/v1/orgs/${orgId}/invitations`, undefined, token);
    assert.equal(r.json.data.length, 1); ok('pending invitations listed');
    r = await api(port, 'GET', `/v1/invitations/${inviteToken}`);
    assert.equal(r.status, 200); assert.equal(r.json.data.requiresSignup, true); assert.equal(r.json.data.email, 'invitee@example.test'); assert.equal(r.json.data.orgName, 'Acme');
    ok('GET /v1/invitations/:token (public) → { orgName, email, requiresSignup:true }');
    r = await api(port, 'POST', `/v1/invitations/${inviteToken}/accept`, {});
    assert.equal(r.status, 400); ok('accept without password for a new account → 400');
    r = await api(port, 'POST', `/v1/invitations/${inviteToken}/accept`, { password: 'password123', name: 'Invitee' });
    assert.equal(r.status, 201); assert.ok(r.json.data.token); assert.equal(r.json.data.org.id, orgId);
    const inviteeToken = r.json.data.token;
    ok('accept → 201 { token } (account created, joined org)');
    r = await api(port, 'POST', `/v1/invitations/${inviteToken}/accept`, { password: 'password123' });
    assert.equal(r.status, 410); ok('accepting twice → 410');
    r = await api(port, 'GET', `/v1/orgs/${orgId}/members`, undefined, inviteeToken);
    assert.equal(r.json.data.length, 2); ok('invitee sees 2 members');
    r = await api(port, 'POST', `/v1/orgs/${orgId}/members/invite`, { email: 'invitee@example.test' }, token);
    assert.equal(r.status, 409); ok('inviting an existing member → 409');
    r = await api(port, 'POST', `/v1/orgs/${orgId}/members`, { email: 'x@y.z' }, token);
    assert.equal(r.status, 404); ok('old POST /members endpoint is gone (404)');

    // Existing-user invitation needs session or password
    r = await api(port, 'POST', '/v1/auth/signup', { email: 'third@example.test', password: 'password123', name: 'Third' });
    const thirdToken = r.json.data.token;
    r = await api(port, 'POST', `/v1/orgs/${orgId}/members/invite`, { email: 'third@example.test' }, token);
    const t2 = r.json.data.inviteUrl.split('/invite/')[1];
    r = await api(port, 'GET', `/v1/invitations/${t2}`);
    assert.equal(r.json.data.requiresSignup, false);
    r = await api(port, 'POST', `/v1/invitations/${t2}/accept`, {});
    assert.equal(r.status, 401); ok('existing account: accept without credentials → 401');
    r = await api(port, 'POST', `/v1/invitations/${t2}/accept`, {}, thirdToken);
    assert.equal(r.status, 200); assert.ok(r.json.data.token); ok('existing account: accept with its session → 200 { token }');

    // Password reset: forgot → always 200; CLI link → reset → new password works, old token invalid
    r = await api(port, 'POST', '/v1/auth/forgot-password', { email: 'nobody@example.test' });
    assert.equal(r.status, 200); assert.equal(r.json.data.sent, true); assert.equal(r.json.data.emailEnabled, false);
    ok('forgot-password → 200 { sent:true, emailEnabled:false } even for unknown email');
    const cli = spawn('node', ['apps/api/dist/cli.js', 'reset-password', 'owner@example.test'], { cwd: WT, env: { ...BASE_ENV, DATABASE_URL: dbUrl('hovod_it_selfhost') } });
    let cliOut = '';
    cli.stdout.on('data', (d) => { cliOut += d; });
    const cliCode = await new Promise((res) => cli.on('exit', res));
    assert.equal(cliCode, 0);
    const resetUrl = cliOut.match(/https?:\/\/\S+/)[0];
    assert.match(resetUrl, /\/reset-password\//); ok(`hovod-cli reset-password prints a link (${resetUrl.slice(0, 45)}…)`);
    const resetToken = resetUrl.split('/reset-password/')[1];
    r = await api(port, 'POST', '/v1/auth/reset-password', { token: resetToken, password: 'newpassword1' });
    assert.equal(r.status, 200); assert.ok(r.json.data.token); ok('reset-password → 200 { token }');
    r = await api(port, 'POST', '/v1/auth/reset-password', { token: resetToken, password: 'newpassword2' });
    assert.equal(r.status, 400); ok('reset token is single-use (400)');
    r = await api(port, 'GET', '/v1/auth/me', undefined, token);
    assert.equal(r.status, 401); ok('old session invalidated after reset (401)');
    r = await api(port, 'POST', '/v1/auth/login', { email: 'owner@example.test', password: 'newpassword1' });
    assert.equal(r.status, 200); ok('login with the new password → 200');
    const freshToken = r.json.data.token;

    r = await api(port, 'POST', '/v1/billing/checkout', { plan: 'pro' }, freshToken);
    assert.equal(r.status, 404); ok('/v1/billing/* not registered in self-host (404)');
    assert.ok(!/"statusCode":402/.test(p.log()), 'no 402 anywhere');
    assert.ok(/self-host \(unlimited\)/.test(p.log())); ok('banner shows self-host (unlimited)');
  } finally {
    p.child.kill('SIGTERM');
    await p.exited;
  }
}

/* ═══ 2. Cloud: refuse half-configured ═══════════════════════ */
console.log('\n[2] cloud boot with a missing variable');
await resetDb('hovod_it_cloud');
{
  const { STRIPE_PRICE_BUSINESS, ...partial } = CLOUD_ENV;
  const p = boot({ DB: 'hovod_it_cloud', ...partial }, BASE_PORT + 1);
  const code = await Promise.race([p.exited, new Promise((r) => setTimeout(() => r('timeout'), 15_000))]);
  assert.notEqual(code, 0); assert.notEqual(code, 'timeout');
  assert.match(p.log(), /HOVOD_CLOUD=true requires STRIPE_PRICE_BUSINESS/);
  ok(`exit ${code} — "${p.log().match(/HOVOD_CLOUD=true requires [^"]+/)[0]}"`);
  const q = boot({ DB: 'hovod_it_cloud', RESEND_API_KEY: 're_x' }, BASE_PORT + 1);
  const c2 = await Promise.race([q.exited, new Promise((r) => setTimeout(() => r('timeout'), 15_000))]);
  assert.notEqual(c2, 0); assert.match(q.log(), /EMAIL_FROM is required when RESEND_API_KEY is set/);
  ok('self-host with RESEND_API_KEY but no EMAIL_FROM refuses to boot');
}

/* ═══ 3. Cloud: full boot with placeholders ══════════════════ */
console.log('\n[3] cloud boot with all variables (placeholder keys)');
{
  const port = BASE_PORT + 1;
  const p = boot({ DB: 'hovod_it_cloud', ...CLOUD_ENV }, port);
  try {
    await waitReady(port, p.exited);
    ok('API ready');
    let r = await api(port, 'GET', '/v1/config');
    assert.equal(r.json.data.cloud, true); assert.equal(r.json.data.emailEnabled, true);
    assert.deepEqual(r.json.data.plans.map((x) => x.id), ['pro', 'business']); assert.equal(r.json.data.plans[0].limits.encodingMinutes, 500);
    ok('/v1/config → cloud:true, plans:[pro, business], emailEnabled:true');

    r = await api(port, 'POST', '/v1/auth/signup', { email: 'cloud@example.test', password: 'password123', name: 'Cloud' });
    assert.equal(r.status, 400); ok('signup without plan → 400');
    r = await api(port, 'POST', '/v1/auth/signup', { email: 'cloud@example.test', password: 'password123', name: 'Cloud', plan: 'pro' });
    assert.equal(r.status, 502); assert.equal(r.json.code, 'stripe_unavailable');
    ok(`signup with plan → Stripe call attempted with the fake key → 502 { code: stripe_unavailable } ("${r.json.error}")`);

    // The account + pending org exist → paywall path
    r = await api(port, 'POST', '/v1/auth/login', { email: 'cloud@example.test', password: 'password123' });
    assert.equal(r.status, 200); const token = r.json.data.token; ok('login works for the pending org');
    r = await api(port, 'GET', '/v1/auth/me', undefined, token);
    assert.equal(r.json.data.cloud, true); assert.equal(r.json.data.org.entitlement, 'pending'); assert.equal(r.json.data.org.plan, 'pro'); assert.equal(r.json.data.limits.storageGb, 50);
    ok('/v1/auth/me → entitlement:pending, plan:pro, limits of pro');
    const orgId = r.json.data.org.id;
    r = await api(port, 'GET', '/v1/assets', undefined, token);
    assert.equal(r.status, 200); ok('GET /v1/assets allowed while pending');
    r = await api(port, 'POST', '/v1/assets', { title: 'x' }, token);
    assert.equal(r.status, 402); assert.equal(r.json.code, 'subscription_required'); assert.equal(r.json.error, 'subscription_required');
    ok('POST /v1/assets while pending → 402 { error, code: subscription_required }');
    r = await api(port, 'POST', `/v1/orgs/${orgId}/api-keys`, { name: 'k' }, token);
    assert.equal(r.status, 402); ok('POST api-keys while pending → 402');
    r = await api(port, 'POST', '/v1/billing/checkout', { plan: 'business' }, token);
    assert.equal(r.status, 502); ok('POST /v1/billing/checkout (paywall retry) reaches Stripe → 502 with the fake key');
    r = await api(port, 'POST', '/v1/billing/portal', {}, token);
    assert.equal(r.status, 400); assert.equal(r.json.code, 'no_billing_account'); ok('portal without a customer → 400 no_billing_account');
    r = await api(port, 'POST', '/v1/auth/logout-all', {}, token);
    assert.equal(r.status, 200); ok('auth routes stay exempt from the guard while pending');
    const token2 = r.json.data.token;

    // Flip the org through the states directly in the DB (Stripe is unreachable here)
    // Flip a second org to active directly in the DB (Stripe is unreachable here; the
    // first org's "pending" entitlement is cached for 30 s, so use a fresh one).
    const c = await mysql.createConnection(dbUrl('hovod_it_cloud'));
    r = await api(port, 'POST', '/v1/auth/signup', { email: 'active@example.test', password: 'password123', name: 'Active', plan: 'business' });
    assert.equal(r.status, 502);
    const [[o2]] = await c.query("SELECT id FROM organizations WHERE slug LIKE 'active%' LIMIT 1");
    await c.query("UPDATE organizations SET subscription_status = 'active', stripe_customer_id = 'cus_fake', stripe_subscription_id = 'sub_fake' WHERE id = ?", [o2.id]);
    r = await api(port, 'POST', '/v1/auth/login', { email: 'active@example.test', password: 'password123' });
    const tokenA = r.json.data.token;
    r = await api(port, 'GET', '/v1/auth/me', undefined, tokenA);
    assert.equal(r.json.data.org.entitlement, 'active'); assert.equal(r.json.data.limits.apiKeys, 20);
    r = await api(port, 'POST', '/v1/assets', { title: 'ok' }, tokenA);
    assert.equal(r.status, 201); ok('active org: POST /v1/assets → 201');
    r = await api(port, 'POST', '/v1/billing/checkout', { plan: 'pro' }, tokenA);
    assert.equal(r.status, 409); assert.equal(r.json.code, 'already_subscribed'); ok('checkout for an active org → 409 already_subscribed');
    r = await api(port, 'POST', '/v1/billing/portal', {}, tokenA);
    assert.equal(r.status, 502); ok('portal with a customer id reaches Stripe → 502 with the fake key');

    // storage limit: 50 GB of storage_bytes on the business org (250 GB) → fine; bump to 300 GB → 402 storage_limit
    await c.query("UPDATE assets SET storage_bytes = 300000000000 WHERE org_id = ?", [o2.id]);
    r = await api(port, 'POST', '/v1/assets', { title: 'too big' }, tokenA);
    assert.equal(r.status, 402); assert.equal(r.json.code, 'storage_limit'); ok('storage over the plan → 402 { code: storage_limit }');
    await c.query("UPDATE assets SET storage_bytes = 0 WHERE org_id = ?", [o2.id]);
    await c.query("INSERT INTO usage_monthly (org_id, month, encoding_sec) VALUES (?, ?, 2000*60)", [o2.id, new Date().toISOString().slice(0, 7)]);
    r = await api(port, 'POST', '/v1/assets', { title: 'no minutes' }, tokenA);
    assert.equal(r.status, 402); assert.equal(r.json.code, 'encoding_limit'); assert.match(r.json.error, /Monthly encoding quota reached \(2000 min\)\. Resets on \d{4}-\d{2}-01\./);
    ok(`encoding quota reached → 402 { code: encoding_limit } ("${r.json.error}")`);
    await c.query("DELETE FROM usage_monthly WHERE org_id = ?", [o2.id]);

    // members limit (business: 10) — fill with pending invitations
    for (let i = 0; i < 9; i++) {
      r = await api(port, 'POST', `/v1/orgs/${o2.id}/members/invite`, { email: `m${i}@example.test` }, tokenA);
      assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    r = await api(port, 'POST', `/v1/orgs/${o2.id}/members/invite`, { email: 'm9@example.test' }, tokenA);
    assert.equal(r.status, 402); assert.equal(r.json.code, 'members_limit'); ok('11th seat (1 member + 9 invitations + 1) → 402 members_limit');
    r = await api(port, 'GET', `/v1/orgs/${o2.id}/invitations`, undefined, tokenA);
    const inv = r.json.data[0];
    r = await api(port, 'DELETE', `/v1/orgs/${o2.id}/invitations/${inv.id}`, undefined, tokenA);
    assert.equal(r.status, 200); ok('revoke invitation → 200');
    for (let i = 0; i < 20; i++) {
      r = await api(port, 'POST', `/v1/orgs/${o2.id}/api-keys`, { name: `k${i}` }, tokenA);
      assert.equal(r.status, 201, JSON.stringify(r.json));
    }
    r = await api(port, 'POST', `/v1/orgs/${o2.id}/api-keys`, { name: 'k20' }, tokenA);
    assert.equal(r.status, 402); assert.equal(r.json.code, 'api_keys_limit'); ok('21st API key on business → 402 api_keys_limit');
    await c.end();

    // Webhook: signed with the test secret via generateTestHeaderString
    const stripe = new Stripe('sk_test_placeholder');
    const sign = (payload) => stripe.webhooks.generateTestHeaderString({ payload, secret: CLOUD_ENV.STRIPE_WEBHOOK_SECRET });
    const evt = (id, type, object) => JSON.stringify({ id, object: 'event', type, api_version: '2025-01-01', created: Math.floor(Date.now() / 1000), data: { object }, livemode: false, pending_webhooks: 1, request: null });

    r = await api(port, 'POST', '/v1/billing/webhook', evt('evt_1', 'customer.created', { id: 'cus_1' }));
    assert.equal(r.status, 400); ok('webhook without signature → 400');
    const p1 = evt('evt_1', 'customer.created', { id: 'cus_1' });
    r = await api(port, 'POST', '/v1/billing/webhook', p1, undefined, { 'stripe-signature': 't=1,v1=deadbeef' });
    assert.equal(r.status, 400); ok('webhook with a bad signature → 400');
    r = await api(port, 'POST', '/v1/billing/webhook', p1, undefined, { 'stripe-signature': sign(p1) });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { received: true, handled: false }); ok('signed unrelated event → 200 { received, handled:false }');
    r = await api(port, 'POST', '/v1/billing/webhook', p1, undefined, { 'stripe-signature': sign(p1) });
    assert.equal(r.status, 200); assert.deepEqual(r.json, { received: true, duplicate: true }); ok('same event id again → 200 { duplicate:true } (stripe_events dedupe)');

    const p2 = evt('evt_2', 'customer.subscription.updated', { id: 'sub_fake', object: 'subscription', customer: 'cus_fake', status: 'active' });
    r = await api(port, 'POST', '/v1/billing/webhook', p2, undefined, { 'stripe-signature': sign(p2) });
    assert.equal(r.status, 500); ok('subscription event → syncSubscription → Stripe unreachable with fake key → 500 (Stripe retries)');
    r = await api(port, 'POST', '/v1/billing/webhook', p2, undefined, { 'stripe-signature': sign(p2) });
    assert.equal(r.status, 500); assert.notEqual(r.json?.duplicate, true); ok('retry of the failed event is processed again (row released), not treated as duplicate');

    assert.ok(/cloud \(Stripe, plan limits\)/.test(p.log())); ok('banner shows cloud mode');
    assert.ok(/\[reconcile\] scheduled/.test(p.log())); ok('reconcile scheduler started');
  } finally {
    p.child.kill('SIGTERM');
    await p.exited;
  }
}

console.log(`\n${passed} checks passed`);
