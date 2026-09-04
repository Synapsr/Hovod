#!/usr/bin/env node
/**
 * Quota arithmetic + month rollover (pure helpers from src/usage.ts).
 *
 * Run with: node --test packages/db/scripts/test-usage.mjs   (after `npm run build`)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  usageMonthKey, usageResetDate, storageLimitBytes, quotaReached, quotaWouldExceed, quotaMessage, PLAN_LIMITS, GRACE_DAYS,
} = await import(path.join(PKG_ROOT, 'dist', 'index.js'));

test('month key is UTC YYYY-MM', () => {
  assert.equal(usageMonthKey(new Date('2026-09-04T12:00:00Z')), '2026-09');
  // 23:30 in UTC-2 is already the next day/month in local time; the key must stay UTC.
  assert.equal(usageMonthKey(new Date('2026-09-30T23:59:59Z')), '2026-09');
  assert.equal(usageMonthKey(new Date('2026-10-01T00:00:00Z')), '2026-10');
});

test('reset date rolls over at month and year boundaries', () => {
  assert.equal(usageResetDate(new Date('2026-09-04T00:00:00Z')), '2026-10-01');
  assert.equal(usageResetDate(new Date('2026-12-31T23:59:59Z')), '2027-01-01');
  assert.equal(usageResetDate(new Date('2028-02-29T10:00:00Z')), '2028-03-01');
});

test('counters live in seconds, limits in minutes', () => {
  assert.equal(quotaReached(500 * 60 - 1, 500), false);
  assert.equal(quotaReached(500 * 60, 500), true);
  assert.equal(quotaWouldExceed(0, 500 * 60, 500), false, 'exactly the limit still fits');
  assert.equal(quotaWouldExceed(1, 500 * 60, 500), true);
  assert.equal(quotaWouldExceed(29_000, 1_000, 500), false);
  assert.equal(quotaWouldExceed(29_500, 1_000, 500), true);
  assert.equal(quotaWouldExceed(10, -5, 500), false, 'negative durations never count');
});

test('storage limits are decimal gigabytes', () => {
  assert.equal(storageLimitBytes(50), 50_000_000_000);
  assert.equal(storageLimitBytes(PLAN_LIMITS.business.storageGb), 250_000_000_000);
});

test('quota message names the reset day', () => {
  assert.equal(
    quotaMessage('encoding', 500, new Date('2026-09-04T00:00:00Z')),
    'Monthly encoding quota reached (500 min). Resets on 2026-10-01.',
  );
  assert.match(quotaMessage('AI', PLAN_LIMITS.pro.aiMinutes), /Monthly AI quota reached \(50 min\)/);
});

test('plan table + grace constant match the design', () => {
  assert.deepEqual(Object.keys(PLAN_LIMITS), ['pro', 'business']);
  assert.equal(PLAN_LIMITS.pro.encodingMinutes, 500);
  assert.equal(PLAN_LIMITS.business.rateLimitPerMin, 600);
  assert.equal(GRACE_DAYS, 7);
});
