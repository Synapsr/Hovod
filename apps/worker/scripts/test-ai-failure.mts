#!/usr/bin/env tsx
/**
 * A failed AI run must not leave a step at `processing` — that row is the only
 * thing the dashboard reads, so a stale `processing` shows a spinner turning
 * forever on a run that ended long ago.
 *
 *   HOVOD_TEST_DATABASE_URL=mysql://root:root@127.0.0.1:33318/hovod \
 *     npx tsx apps/worker/scripts/test-ai-failure.mts
 *
 * Skips (exit 0) when HOVOD_TEST_DATABASE_URL is unset. The database must have
 * the migrations applied.
 */
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import { createDb, aiJobs, assets, organizations, users, AI_JOB_STATUS, AI_STEP_STATUS } from '@hovod/db';

const DB_URL = process.env.HOVOD_TEST_DATABASE_URL;
if (!DB_URL) {
  console.log('HOVOD_TEST_DATABASE_URL not set — skipping AI failure tests');
  process.exit(0);
}

const { db, pool } = createDb(DB_URL);
let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`  ok   ${label}`); };

/* ─── Fixture ────────────────────────────────────────────── */

await pool.query('DELETE FROM ai_jobs WHERE id LIKE ?', ['at_%']);
await pool.query('DELETE FROM assets WHERE id LIKE ?', ['at_%']);
await pool.query('DELETE FROM organizations WHERE id LIKE ?', ['at_%']);
await pool.query('DELETE FROM users WHERE id LIKE ?', ['at_%']);

await db.insert(users).values({ id: 'at_u1', email: 'ai@example.test', passwordHash: 'x', name: 'AI' });
await db.insert(organizations).values({ id: 'at_o1', name: 'AI', slug: 'at-ai', ownerId: 'at_u1' });
await db.insert(assets).values({ id: 'at_a1', orgId: 'at_o1', title: 'Clip', status: 'ready', playbackId: 'at_p1' });

/** The exact expression the worker uses; the point of the test is that MySQL accepts it. */
const failIfRunning = (column: AnyMySqlColumn) =>
  sql`CASE WHEN ${column} = ${AI_STEP_STATUS.PROCESSING} THEN ${AI_STEP_STATUS.FAILED} ELSE ${column} END`;

async function failJob(id: string) {
  await db.update(aiJobs).set({
    status: AI_JOB_STATUS.FAILED,
    errorMessage: 'LLM API error (404): model_not_found',
    transcriptionStatus: failIfRunning(aiJobs.transcriptionStatus),
    subtitlesStatus: failIfRunning(aiJobs.subtitlesStatus),
    chaptersStatus: failIfRunning(aiJobs.chaptersStatus),
  }).where(eq(aiJobs.id, id));
  const [row] = await db.select().from(aiJobs).where(eq(aiJobs.id, id));
  return row;
}

/* ─── 1. The production case: chapters died, the rest had finished ─── */

await db.insert(aiJobs).values({
  id: 'at_j1', assetId: 'at_a1', status: AI_JOB_STATUS.PROCESSING,
  transcriptionStatus: AI_STEP_STATUS.COMPLETED,
  subtitlesStatus: AI_STEP_STATUS.COMPLETED,
  chaptersStatus: AI_STEP_STATUS.PROCESSING,
});
const j1 = await failJob('at_j1');
assert.equal(j1.chaptersStatus, AI_STEP_STATUS.FAILED);
ok('the step that was running becomes failed, not a forever spinner');
assert.equal(j1.transcriptionStatus, AI_STEP_STATUS.COMPLETED);
assert.equal(j1.subtitlesStatus, AI_STEP_STATUS.COMPLETED);
ok('steps that already succeeded keep their result');
assert.equal(j1.status, AI_JOB_STATUS.FAILED);
assert.match(j1.errorMessage ?? '', /model_not_found/);
ok('the job carries the failure and its reason');

/* ─── 2. A failure before any step started ─────────────────── */

await db.insert(aiJobs).values({ id: 'at_j2', assetId: 'at_a1', status: AI_JOB_STATUS.PROCESSING });
const j2 = await failJob('at_j2');
assert.equal(j2.transcriptionStatus, AI_STEP_STATUS.PENDING);
assert.equal(j2.subtitlesStatus, AI_STEP_STATUS.PENDING);
assert.equal(j2.chaptersStatus, AI_STEP_STATUS.PENDING);
ok('steps that never started stay pending, they are not invented as failures');

/* ─── 3. A skipped step is not resurrected as a failure ────── */

await db.insert(aiJobs).values({
  id: 'at_j3', assetId: 'at_a1', status: AI_JOB_STATUS.PROCESSING,
  transcriptionStatus: AI_STEP_STATUS.PROCESSING,
  subtitlesStatus: AI_STEP_STATUS.SKIPPED,
});
const j3 = await failJob('at_j3');
assert.equal(j3.transcriptionStatus, AI_STEP_STATUS.FAILED);
assert.equal(j3.subtitlesStatus, AI_STEP_STATUS.SKIPPED);
ok('a skipped step stays skipped');

/* ─── 4. Re-running the update is harmless ─────────────────── */

const j1again = await failJob('at_j1');
assert.equal(j1again.chaptersStatus, AI_STEP_STATUS.FAILED);
assert.equal(j1again.transcriptionStatus, AI_STEP_STATUS.COMPLETED);
ok('applying it twice changes nothing');

await pool.query('DELETE FROM ai_jobs WHERE id LIKE ?', ['at_%']);
await pool.query('DELETE FROM assets WHERE id LIKE ?', ['at_%']);
await pool.query('DELETE FROM organizations WHERE id LIKE ?', ['at_%']);
await pool.query('DELETE FROM users WHERE id LIKE ?', ['at_%']);
await pool.end();
console.log(`\n${passed} checks passed`);
