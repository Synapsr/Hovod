#!/usr/bin/env node
/**
 * Entitlement state machine (pure `computeEntitlement`) + route exemptions.
 *
 * Run with: node --test apps/api/scripts/test-entitlements.mjs   (after `npm run build -w @hovod/api`)
 * Env vars are only needed because the module graph pulls in the Zod-validated env.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ??= 'mysql://u:p@127.0.0.1:3306/db';
process.env.S3_ENDPOINT ??= 'http://127.0.0.1:9000';
process.env.S3_REGION ??= 'us-east-1';
process.env.S3_BUCKET ??= 'hovod-vod';
process.env.S3_ACCESS_KEY_ID ??= 'x';
process.env.S3_SECRET_ACCESS_KEY ??= 'y';
process.env.S3_PUBLIC_BASE_URL ??= 'http://127.0.0.1:9000/hovod-vod';
process.env.JWT_SECRET ??= 'x'.repeat(40);

const {
  computeEntitlement, canMutate, rateLimitFor, isEntitlementExempt, SELFHOST_RATE_LIMIT_PER_MIN,
} = await import('../dist/services/entitlements.js');

const NOW = new Date('2026-09-04T12:00:00Z');
const day = (n) => new Date(NOW.getTime() + n * 86_400_000);
const org = (over = {}) => ({ plan: 'pro', subscriptionStatus: null, graceUntil: null, currentPeriodEnd: null, cancelAtPeriodEnd: 0, ...over });

test('self-host is always selfhost, unlimited, 600 req/min', () => {
  const e = computeEntitlement(org({ subscriptionStatus: 'canceled' }), NOW, false);
  assert.equal(e.mode, 'selfhost');
  assert.equal(e.limits, null);
  assert.equal(canMutate(e), true);
  assert.equal(rateLimitFor(e), SELFHOST_RATE_LIMIT_PER_MIN);
  assert.equal(rateLimitFor(e), 600);
});

test('cloud: active / trialing → active', () => {
  for (const status of ['active', 'trialing']) {
    const e = computeEntitlement(org({ subscriptionStatus: status }), NOW, true);
    assert.equal(e.mode, 'active', status);
    assert.equal(canMutate(e), true);
    assert.equal(e.limits.encodingMinutes, 500);
    assert.equal(rateLimitFor(e), 300);
  }
  assert.equal(rateLimitFor(computeEntitlement(org({ plan: 'business', subscriptionStatus: 'active' }), NOW, true)), 600);
});

test('cloud: past_due inside grace → grace (still mutating), after → readonly', () => {
  const inGrace = computeEntitlement(org({ subscriptionStatus: 'past_due', graceUntil: day(3) }), NOW, true);
  assert.equal(inGrace.mode, 'grace');
  assert.equal(canMutate(inGrace), true);
  assert.equal(inGrace.graceUntil.toISOString(), day(3).toISOString());

  const expired = computeEntitlement(org({ subscriptionStatus: 'past_due', graceUntil: day(-1) }), NOW, true);
  assert.equal(expired.mode, 'readonly');
  assert.equal(canMutate(expired), false);

  const noGrace = computeEntitlement(org({ subscriptionStatus: 'past_due', graceUntil: null }), NOW, true);
  assert.equal(noGrace.mode, 'readonly', 'past_due without a grace deadline is read-only');
});

test('cloud: lapsed statuses → readonly', () => {
  for (const status of ['unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused', 'something_new']) {
    const e = computeEntitlement(org({ subscriptionStatus: status }), NOW, true);
    assert.equal(e.mode, 'readonly', status);
    assert.equal(canMutate(e), false, status);
  }
});

test('cloud: no subscription → pending (limits of the chosen plan still exposed)', () => {
  const e = computeEntitlement(org({ subscriptionStatus: null }), NOW, true);
  assert.equal(e.mode, 'pending');
  assert.equal(canMutate(e), false);
  assert.equal(e.limits.storageGb, 50);
  const noPlan = computeEntitlement(org({ plan: null }), NOW, true);
  assert.equal(noPlan.mode, 'pending');
  assert.equal(noPlan.limits, null);
  assert.equal(rateLimitFor(noPlan), 600, 'pending orgs fall back to the default budget');
});

test('cloud: unknown plan string never grants limits', () => {
  const e = computeEntitlement(org({ plan: 'enterprise', subscriptionStatus: 'active' }), NOW, true);
  assert.equal(e.mode, 'active');
  assert.equal(e.plan, null);
  assert.equal(e.limits, null);
});

test('guard exemptions', () => {
  assert.equal(isEntitlementExempt('POST', '/v1/auth/login'), true);
  assert.equal(isEntitlementExempt('POST', '/v1/auth/logout-all'), true);
  assert.equal(isEntitlementExempt('POST', '/v1/billing/checkout'), true);
  assert.equal(isEntitlementExempt('POST', '/v1/billing/webhook'), true);
  assert.equal(isEntitlementExempt('POST', '/v1/invitations/abc/accept'), true);
  assert.equal(isEntitlementExempt('GET', '/v1/orgs'), true);
  assert.equal(isEntitlementExempt('POST', '/v1/orgs?x=1'), true);
  assert.equal(isEntitlementExempt('PATCH', '/v1/orgs/abc'), false);
  assert.equal(isEntitlementExempt('POST', '/v1/orgs/abc/api-keys'), false);
  assert.equal(isEntitlementExempt('POST', '/v1/assets'), false);
  assert.equal(isEntitlementExempt('POST', '/v1/playback/x/view'), true, 'public routes are exempt');
  assert.equal(isEntitlementExempt('GET', '/assets/index-abc.js'), true, 'dashboard static files are exempt');
  assert.equal(isEntitlementExempt('POST', '/v1/analytics/events'), true);
});
