#!/usr/bin/env node
/**
 * Throwaway stand-in for the Hovod API, used to click through the cloud pages in
 * a browser while the real endpoints are being written in another work package.
 *
 * Not shipped: it lives outside `src/`, is never imported by the app, and only
 * implements the handful of routes the cloud dashboard talks to.
 *
 *   node apps/dashboard/scripts/mock-cloud-api.mjs --port 4599 --scenario pending
 *
 * Scenarios: cloud (active) | pending | grace | readonly | selfhost | activate
 *   - `activate` starts pending and flips to active after two `/v1/auth/me` polls,
 *     which is what `/billing/success` waits for.
 */
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(argOf('port', '4599'));
let scenario = argOf('scenario', 'cloud');

const PLAN_LIMITS = {
  pro: { encodingMinutes: 500, aiMinutes: 50, storageGb: 50, apiKeys: 5, members: 3, rateLimitPerMin: 300 },
  business: { encodingMinutes: 2000, aiMinutes: 500, storageGb: 250, apiKeys: 20, members: 10, rateLimitPerMin: 600 },
};

const day = (n) => new Date(Date.now() + n * 864e5).toISOString();

const seedInvitations = () => [
  { id: 'inv_1', email: 'sam@example.com', role: 'member', expiresAt: day(6), createdAt: day(-1) },
];

const state = { plan: 'business', polls: 0, invitations: seedInvitations() };

function entitlementFor() {
  if (scenario === 'selfhost') return 'selfhost';
  if (scenario === 'grace') return 'grace';
  if (scenario === 'readonly') return 'readonly';
  if (scenario === 'pending') return 'pending';
  if (scenario === 'activate') return state.polls++ >= 2 ? 'active' : 'pending';
  return 'active';
}

function meBody() {
  const entitlement = entitlementFor();
  const cloud = scenario !== 'selfhost';
  return {
    user: { id: 'u_1', email: 'ada@example.com', name: 'Ada Lovelace' },
    org: {
      id: 'org_1',
      name: 'Acme Studios',
      slug: 'acme-studios',
      role: 'owner',
      plan: cloud && entitlement !== 'pending' ? state.plan : null,
      subscriptionStatus: !cloud ? null
        : entitlement === 'active' ? 'active'
        : entitlement === 'grace' ? 'past_due'
        : entitlement === 'readonly' ? 'canceled'
        : null,
      currentPeriodEnd: cloud && entitlement !== 'pending' ? day(21) : null,
      cancelAtPeriodEnd: false,
      graceUntil: entitlement === 'grace' ? day(5) : null,
      entitlement,
    },
    cloud,
    limits: cloud && entitlement !== 'pending' ? PLAN_LIMITS[state.plan] : cloud ? PLAN_LIMITS.pro : null,
    usage: { encodingMinutes: 412, aiMinutes: 23, storageBytes: 31_500_000_000 },
  };
}

const routes = [
  ['GET', /^\/v1\/config$/, () => ({
    aiAvailable: true,
    chaptersAvailable: true,
    cloud: scenario !== 'selfhost',
    emailEnabled: scenario !== 'selfhost',
    plans: [
      { id: 'pro', name: 'Pro', priceEur: 29, limits: PLAN_LIMITS.pro },
      { id: 'business', name: 'Business', priceEur: 99, limits: PLAN_LIMITS.business },
    ],
  })],
  ['GET', /^\/v1\/auth\/me$/, meBody],
  ['POST', /^\/v1\/auth\/signup$/, (body) => {
    if (body.plan) state.plan = body.plan;
    return {
      token: fakeJwt(),
      ...(scenario === 'selfhost' ? {} : { checkoutUrl: `http://localhost:${PORT}/__stripe-checkout?plan=${body.plan}` }),
    };
  }],
  ['POST', /^\/v1\/auth\/login$/, () => ({ token: fakeJwt() })],
  ['POST', /^\/v1\/auth\/forgot-password$/, () => ({ ok: true })],
  ['POST', /^\/v1\/auth\/reset-password$/, () => ({ ok: true })],
  ['POST', /^\/v1\/billing\/sync$/, () => ({ ok: true })],
  ['POST', /^\/v1\/billing\/checkout$/, (body) => {
    state.plan = body.plan ?? state.plan;
    return { checkoutUrl: `http://localhost:${PORT}/__stripe-checkout?plan=${state.plan}` };
  }],
  ['POST', /^\/v1\/billing\/portal$/, () => ({ url: `http://localhost:${PORT}/__stripe-portal` })],
  ['GET', /^\/v1\/orgs$/, () => [{ id: 'org_1', name: 'Acme Studios', slug: 'acme-studios', role: 'owner', plan: state.plan }]],
  ['GET', /^\/v1\/orgs\/[^/]+\/members$/, () => [
    { id: 'm_1', userId: 'u_1', email: 'ada@example.com', name: 'Ada Lovelace', role: 'owner', joinedAt: day(-90) },
  ]],
  ['GET', /^\/v1\/orgs\/[^/]+\/invitations$/, () => state.invitations],
  ['POST', /^\/v1\/orgs\/[^/]+\/members\/invite$/, (body) => {
    if (state.invitations.length >= 2) {
      return { __status: 402, error: 'Member limit reached', code: 'members_limit', status: 'active' };
    }
    const invitation = { id: `inv_${state.invitations.length + 1}`, email: body.email, role: body.role, expiresAt: day(7), createdAt: new Date().toISOString() };
    state.invitations.push(invitation);
    return { inviteUrl: `http://localhost:5173/invite/tok_${invitation.id}`, emailSent: true, invitation };
  }],
  ['DELETE', /^\/v1\/orgs\/[^/]+\/invitations\/[^/]+$/, (_b, url) => {
    const id = url.pathname.split('/').pop();
    state.invitations = state.invitations.filter((i) => i.id !== id);
    return { ok: true };
  }],
  ['GET', /^\/v1\/orgs\/[^/]+\/api-keys$/, () => []],
  ['GET', /^\/v1\/orgs\/[^/]+$/, () => ({ id: 'org_1', name: 'Acme Studios', slug: 'acme-studios' })],
  ['GET', /^\/v1\/invitations\/[^/]+$/, () => ({ orgName: 'Acme Studios', email: 'newbie@example.com', requiresSignup: true })],
  ['POST', /^\/v1\/invitations\/[^/]+\/accept$/, () => ({ token: fakeJwt() })],
  ['GET', /^\/v1\/settings$/, () => ({ primaryColor: '#4f46e5', theme: 'dark', logoUrl: null, aiAutoTranscribe: true, aiAutoChapter: true })],
  ['GET', /^\/v1\/assets$/, () => []],
];

function fakeJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub: 'u_1', org: 'org_1', tv: 0, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 })}.sig`;
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  // Stand-ins for the pages Stripe would serve.
  if (url.pathname.startsWith('/__stripe')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h1 data-testid="stripe-stub">${url.pathname}${url.search}</h1>`);
    return;
  }
  // Flip the scenario at runtime: /__scenario?name=grace
  if (url.pathname === '/__scenario') {
    scenario = url.searchParams.get('name') ?? scenario;
    state.polls = 0;
    state.plan = url.searchParams.get('plan') ?? 'business';
    state.invitations = seedInvitations();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scenario }));
    return;
  }

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No mock for ${req.method} ${url.pathname}` }));
      return;
    }
    const data = route[2](body, url);
    if (data && data.__status) {
      const { __status, ...rest } = data;
      res.writeHead(__status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rest));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });
}).listen(PORT, () => {
  console.log(`mock cloud API on http://localhost:${PORT} (scenario: ${scenario})`);
});
