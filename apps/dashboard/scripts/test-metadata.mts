#!/usr/bin/env tsx
/** Run with: npx tsx apps/dashboard/scripts/test-metadata.mts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCustomMetadata } from '../src/lib/metadata.js';

const metadata = { genre: 'documentary', title: 'Café "été"', path: 'a\\b' };

test('keeps a healthy MySQL metadata object and its string values', () => {
  assert.equal(normalizeCustomMetadata(metadata), metadata);
  assert.deepEqual(normalizeCustomMetadata({}), {});
});

test('parses healthy MariaDB text and legacy MySQL/MariaDB string scalars', () => {
  const json = JSON.stringify(metadata);
  assert.deepEqual(normalizeCustomMetadata(json), metadata);
  assert.deepEqual(normalizeCustomMetadata(JSON.stringify(json)), metadata);
});

test('rejects malformed documents and non-record JSON values without throwing', () => {
  for (const value of [
    undefined, null, '', 'invalid', '{', 1, true, [], ['a'],
    'null', 'true', '1', '[]', '["a"]', '"plain string"',
    JSON.stringify('invalid'), JSON.stringify(JSON.stringify(JSON.stringify(metadata))),
  ]) {
    assert.equal(normalizeCustomMetadata(value), null, JSON.stringify(value));
  }
});

test('rejects non-string values that could crash React or corrupt metadata edits', () => {
  for (const value of [{ nested: {} }, { list: [] }, { n: 1 }, { b: false }, { n: null }]) {
    assert.equal(normalizeCustomMetadata(value), null);
    assert.equal(normalizeCustomMetadata(JSON.stringify(value)), null);
  }
});

test('edits normalized metadata keys rather than string character indexes', () => {
  const normalized = normalizeCustomMetadata(JSON.stringify(JSON.stringify(metadata)));
  assert.deepEqual(Object.keys(normalized ?? {}), ['genre', 'title', 'path']);
  const added: Record<string, string> = { ...normalized, course: '42' };
  delete added.genre;
  assert.deepEqual(added, { title: metadata.title, path: metadata.path, course: '42' });
  assert.deepEqual(metadata, { genre: 'documentary', title: 'Café "été"', path: 'a\\b' });
});
