#!/usr/bin/env node
/**
 * Cross-check the documented environment variables against the Zod schemas.
 *
 * Reads the `envSchema = z.object({ … })` keys of apps/api/src/env.ts and
 * apps/worker/src/env.ts, then reports:
 *   - variables defined in code but mentioned in no doc file  (undocumented)
 *   - variables documented but defined in neither schema      (stale / non-env)
 *
 * Docs scanned: README.md, DOCKER.md, .env.example, docs/*.md.
 * Names in the allow-list below are documented on purpose but are not part of
 * an app's Zod schema (image/compose/build-time knobs).
 *
 * Usage: node scripts/check-env-docs.mjs
 * Exit code 1 when an app variable is undocumented.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Variables that legitimately live outside the API/worker Zod schemas. */
const NON_SCHEMA = new Set([
  // container / image
  'HOVOD_ROLE', 'MARIADB_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'REDIS_MAXMEMORY',
  'HOVOD_BACKUP_KEEP', 'S6_CMD_WAIT_FOR_SERVICES_MAXTIME', 'S6_KILL_GRACETIME',
  'S6_VERBOSITY', 'TMPDIR',
  // dashboard build-time (Vite)
  'VITE_API_BASE_URL',
  // docker compose only
  'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD', 'API_PORT', 'MYSQL_PORT', 'REDIS_PORT',
  'MINIO_PORT', 'MINIO_CONSOLE_PORT',
  // test harness
  'HOVOD_TEST_DATABASE_URL', 'HOVOD_TEST_STACK', 'HOVOD_TEST_MYSQL_IMAGE',
]);

function schemaKeys(file) {
  const src = readFileSync(path.join(root, file), 'utf8');
  const start = src.indexOf('z.object({');
  if (start < 0) throw new Error(`no z.object() in ${file}`);
  const body = src.slice(start);
  const keys = new Set();
  for (const m of body.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)) keys.add(m[1]);
  return keys;
}

const api = schemaKeys('apps/api/src/env.ts');
const worker = schemaKeys('apps/worker/src/env.ts');
const defined = new Map();
for (const k of api) defined.set(k, ['api']);
for (const k of worker) defined.set(k, [...(defined.get(k) ?? []), 'worker']);

const docFiles = [
  'README.md', 'DOCKER.md', '.env.example',
  ...readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
];
const docs = new Map(docFiles.map((f) => [f, readFileSync(path.join(root, f), 'utf8')]));

const mentioned = new Map();
for (const [file, text] of docs) {
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
    const name = m[1];
    if (!defined.has(name) && !NON_SCHEMA.has(name)) continue;
    if (!mentioned.has(name)) mentioned.set(name, new Set());
    mentioned.get(name).add(file);
  }
}

const undocumented = [...defined.keys()].filter((k) => !mentioned.has(k)).sort();
const documentedOnly = [...NON_SCHEMA].filter((k) => mentioned.has(k)).sort();

console.log(`Schema variables: ${api.size} (api) + ${worker.size} (worker) = ${defined.size} distinct`);
console.log(`Docs scanned: ${docFiles.join(', ')}\n`);

console.log('Variable                        api  worker  documented in');
console.log('-'.repeat(96));
for (const name of [...defined.keys()].sort()) {
  const where = defined.get(name);
  const files = mentioned.has(name) ? [...mentioned.get(name)].sort().join(', ') : '— MISSING —';
  console.log(
    `${name.padEnd(31)} ${where.includes('api') ? ' x ' : '   '}  ${where.includes('worker') ? '  x   ' : '      '}  ${files}`,
  );
}

console.log(`\nNon-schema variables documented on purpose: ${documentedOnly.join(', ') || 'none'}`);

if (undocumented.length > 0) {
  console.error(`\nFAIL — undocumented: ${undocumented.join(', ')}`);
  process.exit(1);
}
console.log('\nOK — every API/worker environment variable is documented.');
