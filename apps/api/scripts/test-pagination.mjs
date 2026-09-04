#!/usr/bin/env node
/**
 * Unit tests for the asset-list cursor + LIKE escaping.
 *
 * Run with: node --test apps/api/scripts/test-pagination.mjs
 * (needs env vars only because services/asset.ts pulls in the Zod-validated env)
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

const { encodeCursor, decodeCursor, escapeLikePattern } = await import('../dist/services/asset.js');

test('a cursor round-trips', () => {
  const cursor = { createdAt: '2026-01-02T03:04:05.000Z', id: 'aBcD1234efGh' };
  const token = encodeCursor(cursor);
  assert.equal(typeof token, 'string');
  // base64url — safe to put in a query string unencoded
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(token), cursor);
});

test('the cursor is opaque but not a security boundary', () => {
  const token = encodeCursor({ createdAt: '2026-01-02T03:04:05.000Z', id: 'x1' });
  assert.ok(!token.includes('2026'));
});

test('malformed cursors decode to null instead of throwing', () => {
  for (const bad of [
    '',
    'not-base64!!',
    Buffer.from('{}').toString('base64url'),
    Buffer.from('[1,2]').toString('base64url'),
    Buffer.from('["2026-01-02T03:04:05.000Z"]').toString('base64url'),
    Buffer.from('["nonsense","id"]').toString('base64url'),
    Buffer.from('["2026-01-02T03:04:05.000Z",""]').toString('base64url'),
    Buffer.from(`["2026-01-02T03:04:05.000Z","${'x'.repeat(40)}"]`).toString('base64url'),
    'a'.repeat(600),
  ]) {
    assert.equal(decodeCursor(bad), null, `expected null for ${JSON.stringify(bad).slice(0, 40)}`);
  }
});

test('cursor ordering matches (created_at DESC, id DESC)', () => {
  // Rows as the query returns them.
  const rows = [
    { createdAt: '2026-01-03T00:00:00.000Z', id: 'ccc' },
    { createdAt: '2026-01-02T00:00:00.000Z', id: 'bbb' },
    { createdAt: '2026-01-02T00:00:00.000Z', id: 'aaa' }, // same timestamp, lower id
    { createdAt: '2026-01-01T00:00:00.000Z', id: 'zzz' },
  ];
  const after = decodeCursor(encodeCursor(rows[1]));
  const remaining = rows.filter((r) => {
    const t = new Date(r.createdAt).getTime();
    const c = new Date(after.createdAt).getTime();
    return t < c || (t === c && r.id < after.id);
  });
  assert.deepEqual(remaining.map((r) => r.id), ['aaa', 'zzz']);
});

test('LIKE wildcards in a search term are escaped', () => {
  assert.equal(escapeLikePattern('100%'), '100\\%');
  assert.equal(escapeLikePattern('a_b'), 'a\\_b');
  assert.equal(escapeLikePattern('back\\slash'), 'back\\\\slash');
  assert.equal(escapeLikePattern('plain title'), 'plain title');
  assert.equal(escapeLikePattern('%_%'), '\\%\\_\\%');
});
