#!/usr/bin/env node
/**
 * Worker end-to-end in cloud mode: boots the built API + worker (dist builds)
 * against a real stack, transcodes a generated 6-second clip and checks the
 * `usage_monthly` write, `assets.storage_bytes` and the worker-side quota refusal.
 *
 * Needs ffmpeg/ffprobe on PATH, `npm run build` (api + worker) and the same
 * HOVOD_TEST_* variables as test-cloud-integration.mjs (HOVOD_TEST_STACK=1 to enable;
 * HOVOD_TEST_PORT + 2 is used). Stripe is never reached successfully (fake key).
 */
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';

if (!process.env.HOVOD_TEST_STACK) {
  console.log('HOVOD_TEST_STACK not set — skipping cloud worker tests');
  process.exit(0);
}
if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  console.log('ffmpeg not found — skipping cloud worker tests');
  process.exit(0);
}

const WT = process.cwd();
const ROOT = process.env.HOVOD_TEST_MYSQL_ROOT_URL ?? 'mysql://root:root@127.0.0.1:33307/mysql';
const DB = ROOT.replace(/\/[^/?]*(\?.*)?$/, '/hovod_it_worker$1');
const S3_ENDPOINT = process.env.HOVOD_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const S3_BUCKET = process.env.HOVOD_TEST_S3_BUCKET ?? 'hovod-vod';
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'hovod-worker-e2e-'));
mkdirSync(`${SCRATCH}/uploads`, { recursive: true });
mkdirSync(`${SCRATCH}/work`, { recursive: true });
{
  const admin = await mysql.createConnection(ROOT);
  await admin.query('DROP DATABASE IF EXISTS `hovod_it_worker`');
  await admin.query('CREATE DATABASE `hovod_it_worker`');
  await admin.end();
}
const ENV = {
  PATH: process.env.PATH,
  DATABASE_URL: DB, REDIS_URL: process.env.HOVOD_TEST_REDIS_URL ?? 'redis://127.0.0.1:63790',
  S3_ENDPOINT, S3_REGION: 'us-east-1', S3_BUCKET,
  S3_ACCESS_KEY_ID: process.env.HOVOD_TEST_S3_KEY ?? 'minioadmin', S3_SECRET_ACCESS_KEY: process.env.HOVOD_TEST_S3_SECRET ?? 'minioadmin',
  S3_PUBLIC_BASE_URL: `${S3_ENDPOINT}/${S3_BUCKET}`,
  JWT_SECRET: 'integration-secret-'.repeat(3), NODE_ENV: 'test',
  UPLOAD_DIR: `${SCRATCH}/uploads`, WORK_DIR: `${SCRATCH}/work`,
  HOVOD_CLOUD: 'true', APP_URL: 'https://app.example.test',
  STRIPE_SECRET_KEY: 'sk_test_placeholder', STRIPE_WEBHOOK_SECRET: 'whsec_x',
  STRIPE_PRICE_PRO: 'price_pro_placeholder', STRIPE_PRICE_BUSINESS: 'price_biz_placeholder',
  RESEND_API_KEY: 're_placeholder', EMAIL_FROM: 'Hovod <no-reply@example.test>',
  WORKER_CONCURRENCY: '1', AI_ENABLED: 'false',
};

const ff = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', `${SCRATCH}/test.mp4`]);
assert.equal(ff.status, 0, ff.stderr.toString().slice(-500));
const video = readFileSync(`${SCRATCH}/test.mp4`);
console.log(`test video: ${video.length} bytes`);

function run(name, args, port) {
  const child = spawn('node', args, { cwd: WT, env: { ...ENV, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { name, child, log: () => out, exited: new Promise((r) => child.on('exit', r)) };
}

const PORT = Number(process.env.HOVOD_TEST_PORT ?? 3456) + 2;
const apiProc = run('api', ['apps/api/dist/index.js'], PORT);
const workerProc = run('worker', ['apps/worker/dist/index.js'], 0);

async function api(method, path, body, token, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : (body instanceof Uint8Array ? body : JSON.stringify(body)),
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

let passed = 0;
const ok = (l) => { passed += 1; console.log(`  ok   ${l}`); };

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health/ready`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  for (let i = 0; i < 60 && !/Worker ready/.test(workerProc.log()); i++) await new Promise((r) => setTimeout(r, 500));
  assert.match(workerProc.log(), /Mode:\s+cloud \(plan quotas enforced\)/); ok('worker booted in cloud mode');

  const c = await mysql.createConnection(DB);
  // Signup reaches Stripe with the fake key (502) but leaves the account + pending org behind;
  // activate the org directly in the DB since Stripe is not reachable.
  let r = await api('POST', '/v1/auth/signup', { email: 'active@example.test', password: 'password123', name: 'Active', plan: 'business' });
  assert.equal(r.status, 502, JSON.stringify(r.json));
  const [[org]] = await c.query("SELECT o.id FROM organizations o JOIN users u ON u.id = o.owner_id WHERE u.email = 'active@example.test'");
  await c.query("UPDATE organizations SET subscription_status = 'active', activated_at = NOW() WHERE id = ?", [org.id]);
  r = await api('POST', '/v1/auth/login', { email: 'active@example.test', password: 'password123' });
  const token = r.json.data.token;

  async function processOne(title) {
    let r = await api('POST', '/v1/assets', { title }, token);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.data.id;
    r = await api('PUT', `/v1/assets/${id}/upload`, video, token, { 'content-type': 'video/mp4' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await api('POST', `/v1/assets/${id}/process`, {}, token);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    for (let i = 0; i < 240; i++) {
      r = await api('GET', `/v1/assets/${id}`, undefined, token);
      if (r.json.data.status === 'ready' || r.json.data.status === 'error') return r.json.data;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error('timeout waiting for the job');
  }

  const a1 = await processOne('e2e-ok');
  assert.equal(a1.status, 'ready', a1.errorMessage); ok(`asset transcoded (${a1.durationSec}s, ${a1.renditions.length} rendition)`);
  assert.equal(a1.durationSec, 6);
  const [[row]] = await c.query('SELECT storage_bytes FROM assets WHERE id = ?', [a1.id]);
  assert.ok(Number(row.storage_bytes) > video.length, `storage_bytes ${row.storage_bytes} > source ${video.length}`);
  ok(`assets.storage_bytes = ${row.storage_bytes} (source ${video.length} + renditions/thumbnails)`);
  const [[u]] = await c.query('SELECT encoding_sec, ai_sec FROM usage_monthly WHERE org_id = ? AND month = ?', [org.id, new Date().toISOString().slice(0, 7)]);
  assert.equal(Number(u.encoding_sec), 6); assert.equal(Number(u.ai_sec), 0);
  ok(`usage_monthly: encoding_sec=${u.encoding_sec}, ai_sec=${u.ai_sec}`);
  r = await api('GET', '/v1/auth/me', undefined, token);
  assert.equal(r.json.data.usage.encodingMinutes, 0.1); assert.equal(r.json.data.usage.storageBytes, Number(row.storage_bytes));
  ok(`/v1/auth/me usage → encodingMinutes=${r.json.data.usage.encodingMinutes}, storageBytes=${r.json.data.usage.storageBytes}`);

  const a2 = await processOne('e2e-accumulate');
  assert.equal(a2.status, 'ready');
  const [[u2]] = await c.query('SELECT encoding_sec FROM usage_monthly WHERE org_id = ?', [org.id]);
  assert.equal(Number(u2.encoding_sec), 12); ok('second transcode accumulates (12 s) via ON DUPLICATE KEY UPDATE');

  // Below the API pre-check (>= limit) but the 6 s job would cross it → the worker must refuse.
  await c.query('UPDATE usage_monthly SET encoding_sec = ? WHERE org_id = ?', [2000 * 60 - 3, org.id]);
  const a3 = await processOne('e2e-quota');
  assert.equal(a3.status, 'error');
  assert.match(a3.errorMessage, /^Monthly encoding quota reached \(2000 min\)\. Resets on \d{4}-\d{2}-01\.$/);
  ok(`worker refuses when duration would exceed the plan: "${a3.errorMessage}"`);
  const [[u3]] = await c.query('SELECT encoding_sec FROM usage_monthly WHERE org_id = ?', [org.id]);
  assert.equal(Number(u3.encoding_sec), 2000 * 60 - 3); ok('refused job does not consume usage');
  const [[j]] = await c.query('SELECT status, error_message FROM jobs WHERE asset_id = ?', [a3.id]);
  assert.equal(j.status, 'failed'); ok('job row failed with the quota message');

  await c.end();
} finally {
  apiProc.child.kill('SIGTERM'); workerProc.child.kill('SIGTERM');
  await Promise.all([apiProc.exited, workerProc.exited]);
  rmSync(SCRATCH, { recursive: true, force: true });
}
console.log(`\n${passed} checks passed`);
