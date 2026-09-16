#!/usr/bin/env tsx
/**
 * Re-processing an asset inserts a second `ai_jobs` row. Every endpoint that
 * shows AI state must read the newest one — an unordered `LIMIT 1` would keep
 * serving the previous run's failure, and a retry would look like it did
 * nothing at all.
 *
 *   HOVOD_TEST_DATABASE_URL=mysql://root:root@127.0.0.1:33318/hovod \
 *     npx tsx apps/api/scripts/test-ai-job-selection.mts
 *
 * Skips (exit 0) when HOVOD_TEST_DATABASE_URL is unset.
 */
import assert from 'node:assert/strict';
import { desc, eq } from 'drizzle-orm';
import { createDb, aiJobs, assets, organizations, users, AI_JOB_STATUS, AI_STEP_STATUS } from '@hovod/db';

const DB_URL = process.env.HOVOD_TEST_DATABASE_URL;
if (!DB_URL) {
  console.log('HOVOD_TEST_DATABASE_URL not set — skipping AI job selection tests');
  process.exit(0);
}

const { db, pool } = createDb(DB_URL);
let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`  ok   ${label}`); };

const clean = async () => {
  await pool.query('DELETE FROM ai_jobs WHERE id LIKE ?', ['sel_%']);
  await pool.query('DELETE FROM assets WHERE id LIKE ?', ['sel_%']);
  await pool.query('DELETE FROM organizations WHERE id LIKE ?', ['sel_%']);
  await pool.query('DELETE FROM users WHERE id LIKE ?', ['sel_%']);
};
await clean();

await db.insert(users).values({ id: 'sel_u1', email: 'sel@example.test', passwordHash: 'x', name: 'Sel' });
await db.insert(organizations).values({ id: 'sel_o1', name: 'Sel', slug: 'sel-o1', ownerId: 'sel_u1' });
await db.insert(assets).values({ id: 'sel_a1', orgId: 'sel_o1', title: 'Clip', status: 'ready', playbackId: 'sel_p1' });

// The failed first run, then the retry — inserted with explicit timestamps so the
// test does not depend on how fast the two INSERTs land.
await db.insert(aiJobs).values({
  id: 'sel_old', assetId: 'sel_a1', status: AI_JOB_STATUS.FAILED,
  transcriptionStatus: AI_STEP_STATUS.COMPLETED,
  subtitlesStatus: AI_STEP_STATUS.COMPLETED,
  chaptersStatus: AI_STEP_STATUS.FAILED,
  errorMessage: 'LLM API error (404): model_not_found',
  createdAt: new Date('2026-09-16T15:19:50Z'),
});
await db.insert(aiJobs).values({
  id: 'sel_new', assetId: 'sel_a1', status: AI_JOB_STATUS.COMPLETED,
  transcriptionStatus: AI_STEP_STATUS.COMPLETED,
  subtitlesStatus: AI_STEP_STATUS.COMPLETED,
  chaptersStatus: AI_STEP_STATUS.COMPLETED,
  chaptersPath: 'playback/sel_a1/ai/chapters.json',
  createdAt: new Date('2026-09-16T16:40:00Z'),
});

/** The query shape used by routes/assets.ts, routes/ai.ts and routes/playback.ts. */
const newest = async () => {
  const [row] = await db.select().from(aiJobs)
    .where(eq(aiJobs.assetId, 'sel_a1'))
    .orderBy(desc(aiJobs.createdAt))
    .limit(1);
  return row;
};

const row = await newest();
assert.equal(row.id, 'sel_new');
ok('the retry is what the API reads, not the run it replaced');
assert.equal(row.chaptersStatus, AI_STEP_STATUS.COMPLETED);
ok('chapters show as generated once the retry succeeded');
assert.equal(row.errorMessage, null);
ok('the old failure message does not survive the retry');

// The unordered query is genuinely ambiguous — this is what the fix removes.
const [unordered] = await db.select({ id: aiJobs.id }).from(aiJobs)
  .where(eq(aiJobs.assetId, 'sel_a1')).limit(1);
assert.ok(['sel_old', 'sel_new'].includes(unordered.id));
ok('without ORDER BY the row returned is whichever MySQL happens to reach first');

// A single run must still be found.
await pool.query('DELETE FROM ai_jobs WHERE id = ?', ['sel_new']);
assert.equal((await newest()).id, 'sel_old');
ok('an asset processed only once still resolves its single run');

await clean();
await pool.end();
console.log(`\n${passed} checks passed`);
