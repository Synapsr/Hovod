#!/usr/bin/env node
/**
 * Run after the db/API builds: node --test apps/api/scripts/test-asset-filters.mjs
 * Set HOVOD_TEST_DATABASE_URL for the optional MySQL/MariaDB integration check.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import { assets, ASSET_STATUS, METADATA_LIMITS, createDb } from '@hovod/db';
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  parseAssetListQuery,
  metadataFilterConditions,
  hasAssetListFilters,
} from '../dist/services/asset-list.js';

test('single statuses stay compatible and CSV statuses are validated and deduplicated', () => {
  for (const status of Object.values(ASSET_STATUS).filter((value) => value !== ASSET_STATUS.DELETED)) {
    assert.deepEqual(parseAssetListQuery({ status }).status, [status]);
  }
  assert.deepEqual(parseAssetListQuery({ status: 'ready, error,ready, ,processing' }).status,
    ['ready', 'error', 'processing']);
  for (const status of ['', ' , ', 'ready,unknown', ASSET_STATUS.DELETED, 'READY', 'x'.repeat(1025), ['ready', 'error']]) {
    assert.throws(() => parseAssetListQuery({ status }), { name: 'ZodError' });
  }
});

test('metadata values and literal keys survive parsing without trimming or coercion', () => {
  const query = parseAssetListQuery({
    'metadata.genre': 'Documentary',
    'metadata.customer.id': ' 42 ',
    'metadata.empty': '',
    unrelated: 'ignored',
  });
  assert.deepEqual(query.metadataFilters, [
    ['genre', 'Documentary'], ['customer.id', ' 42 '], ['empty', ''],
  ]);
  assert.deepEqual(parseAssetListQuery({}).metadataFilters, []);
  const prototypeKeys = parseAssetListQuery({
    'metadata.__proto__': 'one', 'metadata.constructor': 'two', 'metadata.toString': 'three',
  });
  assert.deepEqual(prototypeKeys.metadataFilters,
    [['__proto__', 'one'], ['constructor', 'two'], ['toString', 'three']]);
  assert.equal(hasAssetListFilters(prototypeKeys), true);
});

test('metadata filters enforce the same key/value/count limits as writes', () => {
  const maxKey = 'k'.repeat(METADATA_LIMITS.MAX_KEY_LENGTH);
  const maxValue = 'v'.repeat(METADATA_LIMITS.MAX_VALUE_LENGTH);
  assert.deepEqual(parseAssetListQuery({ [`metadata.${maxKey}`]: maxValue }).metadataFilters,
    [[maxKey, maxValue]]);
  const ten = Object.fromEntries(Array.from({ length: METADATA_LIMITS.MAX_KEYS }, (_, i) =>
    [`metadata.key${i}`, 'value']));
  assert.equal(parseAssetListQuery(ten).metadataFilters.length, METADATA_LIMITS.MAX_KEYS);
  for (const input of [
    { 'metadata.': 'value' },
    { [`metadata.${maxKey}k`]: 'value' },
    { 'metadata.key': `${maxValue}v` },
    { ...ten, 'metadata.extra': 'value' },
    { 'metadata.key': ['a', 'b'] },
    { 'metadata.key': 42 },
    { 'metadata.key': null },
  ]) {
    assert.throws(() => parseAssetListQuery(input), { name: 'ZodError' });
  }
});

test('metadata predicates bind literal JSON keys and values and combine with the org scope', () => {
  const key = `customer."id' OR 1=1 --`;
  const value = `value' OR 1=1 --\\%_`;
  const query = parseAssetListQuery({ [`metadata.${key}`]: value, 'metadata.genre': 'Documentary' });
  const compiled = new MySqlDialect().sqlToQuery(and(
    eq(assets.orgId, 'org-a'),
    ...metadataFilterConditions(query.metadataFilters),
  ));
  assert.deepEqual(compiled.params, ['org-a', key, value, 'genre', 'Documentary']);
  assert.equal((compiled.sql.match(/JSON_CONTAINS/g) ?? []).length, 2);
  assert.match(compiled.sql, /`assets`\.`org_id` = \?/);
  assert.match(compiled.sql, /JSON_CONTAINS\(`assets`\.`custom_metadata`, JSON_OBJECT\(\?, \?\)\)/);
  assert.ok(compiled.sql.includes(' and '));
  assert.ok(!compiled.sql.includes(key));
  assert.ok(!compiled.sql.includes(value));
});

test('every filter including metadata-only queries suppresses the total count', () => {
  for (const input of [
    { q: 'launch' }, { status: 'ready' }, { status: 'ready,error' },
    { sourceType: 'url' }, { 'metadata.genre': 'documentary' }, { 'metadata.empty': '' },
  ]) {
    assert.equal(hasAssetListFilters(parseAssetListQuery(input)), true);
  }
  for (const input of [{}, { q: '   ' }, { limit: '20', cursor: 'opaque', fields: 'full' }]) {
    assert.equal(hasAssetListFilters(parseAssetListQuery(input)), false);
  }
});

test('pagination limits, title search and fields retain the existing query contract', () => {
  assert.equal(LIST_DEFAULT_LIMIT, 50);
  assert.equal(LIST_MAX_LIMIT, 200);
  const query = parseAssetListQuery({
    q: '  100% launch_  ', limit: '200', cursor: 'opaque', fields: 'full', sourceType: 'upload',
  });
  assert.equal(query.q, '100% launch_');
  assert.equal(query.limit, 200);
  assert.equal(query.cursor, 'opaque');
  assert.equal(query.fields, 'full');
  assert.equal(query.sourceType, 'upload');
  assert.equal(parseAssetListQuery({}).limit, undefined);
  for (const input of [
    { limit: '0' }, { limit: '201' }, { limit: '1.5' }, { limit: 'nope' },
    { q: 'q'.repeat(256) }, { cursor: 'c'.repeat(513) }, { fields: 'everything' },
    { sourceType: 'unknown' },
  ]) {
    assert.throws(() => parseAssetListQuery(input), { name: 'ZodError' });
  }
});

test('SQL metadata filters compose with org isolation, status CSV and keyset pagination', {
  skip: !process.env.HOVOD_TEST_DATABASE_URL,
}, async () => {
  // A connection-local temporary table shadows any real assets table. A single
  // pooled connection keeps these fixtures isolated from other integration tests.
  const { db, pool } = createDb(process.env.HOVOD_TEST_DATABASE_URL, { connectionLimit: 1 });
  try {
    await pool.query(`CREATE TEMPORARY TABLE assets (
      id VARCHAR(36) PRIMARY KEY, org_id VARCHAR(36) NOT NULL,
      status VARCHAR(32) NOT NULL, custom_metadata JSON, created_at TIMESTAMP NOT NULL
    )`);
    const unusualKey = `customer."id'`;
    const specialValue = `value'\\%_`;
    const common = JSON.stringify(Object.fromEntries([
      ['genre', 'Documentary'], [unusualKey, specialValue], ['empty', ''], ['__proto__', 'literal'],
    ]));
    for (const [id, orgId, status, metadata] of [
      ['c', 'org-a', 'ready', common], ['b', 'org-a', 'error', common],
      ['a', 'org-a', 'ready', common], ['other-org', 'org-b', 'ready', common],
      ['other-status', 'org-a', 'processing', common],
      ['other-case', 'org-a', 'ready', JSON.stringify({ genre: 'documentary' })],
      ['null', 'org-a', 'ready', null],
    ]) {
      await pool.query('INSERT INTO assets VALUES (?, ?, ?, ?, ?)',
        [id, orgId, status, metadata, '2026-01-02 00:00:00']);
    }
    const query = parseAssetListQuery({
      status: 'ready,error', 'metadata.genre': 'Documentary',
      [`metadata.${unusualKey}`]: specialValue, 'metadata.empty': '', 'metadata.__proto__': 'literal',
    });
    const conditions = [eq(assets.orgId, 'org-a'), inArray(assets.status, query.status),
      ...metadataFilterConditions(query.metadataFilters)];
    const select = (extra = []) => db.select({ id: assets.id, createdAt: assets.createdAt })
      .from(assets).where(and(...conditions, ...extra))
      .orderBy(desc(assets.createdAt), desc(assets.id)).limit(2);
    const first = await select();
    assert.deepEqual(first.map((row) => row.id), ['c', 'b']);
    await pool.query('INSERT INTO assets VALUES (?, ?, ?, ?, ?)',
      ['newest', 'org-a', 'ready', common, '2026-01-03 00:00:00']);
    const last = first.at(-1);
    const next = await select([or(
      lt(assets.createdAt, last.createdAt),
      and(eq(assets.createdAt, last.createdAt), lt(assets.id, last.id)),
    )]);
    assert.deepEqual(next.map((row) => row.id), ['a']);
    const lowerCase = parseAssetListQuery({ 'metadata.genre': 'documentary' });
    const matches = await db.select({ id: assets.id }).from(assets)
      .where(and(eq(assets.orgId, 'org-a'), ...metadataFilterConditions(lowerCase.metadataFilters)));
    assert.deepEqual(matches.map((row) => row.id), ['other-case']);
  } finally {
    await pool.end();
  }
});
