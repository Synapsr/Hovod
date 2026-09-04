#!/usr/bin/env node
/**
 * Cross-check the documented API endpoints against the Fastify routes.
 *
 * Extracts every `app.<method>('<path>')` from apps/api/src/routes/*.ts and
 * reports:
 *   - routes that appear in no documentation file  (undocumented)
 *   - paths documented that no route serves        (stale)
 *
 * Docs scanned: docs/api-reference.md, README.md.
 *
 * Usage: node scripts/check-endpoint-docs.mjs
 * Exit code 1 when a route is undocumented or a documented path does not exist.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routesDir = path.join(root, 'apps/api/src/routes');

const ROUTE_RE = /\.(get|post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*['"`]([^'"`]+)['"`]/g;

/** method+path pairs served by the API. */
const routes = new Map(); // path -> Set(methods)
for (const file of readdirSync(routesDir).filter((f) => f.endsWith('.ts')).sort()) {
  const src = readFileSync(path.join(routesDir, file), 'utf8');
  for (const m of src.matchAll(ROUTE_RE)) {
    const [, method, route] = m;
    if (!route.startsWith('/')) continue;
    if (!routes.has(route)) routes.set(route, new Set());
    routes.get(route).add(method.toUpperCase());
  }
}

const docFiles = ['docs/api-reference.md', 'README.md'];
const docs = docFiles.map((f) => readFileSync(path.join(root, f), 'utf8'));

/**
 * A route is documented when its path appears literally, or when a curly-brace
 * expansion in the docs covers it, e.g.
 * `/v1/assets/:id/multipart/{create,part-url,complete,abort}`.
 */
function documented(route) {
  for (const text of docs) {
    if (text.includes(route)) return true;
    const m = route.match(/^(.*)\/([^/]+)$/);
    if (m) {
      const [, prefix, last] = m;
      const re = new RegExp(
        `${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\{[^}]*\\b${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^}]*\\}`,
      );
      if (re.test(text)) return true;
      const braced = new RegExp(
        `${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{[^}]*\\b${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^}]*\\}`,
      );
      if (braced.test(text)) return true;
    }
  }
  return false;
}

/**
 * Paths mentioned in the docs that look like API routes. The lookbehind skips
 * paths that are part of a full URL (a Whisper endpoint, an S3 object URL…) —
 * those are not this API's routes.
 */
const mentioned = new Set();
for (const text of docs) {
  for (const m of text.matchAll(/(?<![A-Za-z0-9._/-])(\/(?:v1|health)\/[A-Za-z0-9:_\-/]*)/g)) {
    mentioned.add(m[1].replace(/[.,)]+$/, ''));
  }
}

const undocumented = [];
console.log(`Routes found: ${routes.size} paths in apps/api/src/routes\n`);
console.log('Method(s)                Path');
console.log('-'.repeat(80));
for (const route of [...routes.keys()].sort()) {
  const methods = [...routes.get(route)].sort().join(',');
  const ok = documented(route);
  if (!ok) undocumented.push(route);
  console.log(`${methods.padEnd(24)} ${route}${ok ? '' : '   ← UNDOCUMENTED'}`);
}

/** Documented paths that match no route (allowing :params and prefixes). */
const known = [...routes.keys()];
const stale = [...mentioned].filter((p) => {
  if (known.includes(p)) return false;
  // tolerate prefixes and trailing partial paths used in prose
  return !known.some((r) => r.startsWith(p) || p.startsWith(r));
}).sort();

if (stale.length > 0) {
  console.log(`\nDocumented paths matching no route:\n  ${stale.join('\n  ')}`);
}

if (undocumented.length > 0) {
  console.error(`\nFAIL — undocumented routes: ${undocumented.join(', ')}`);
  process.exit(1);
}
if (stale.length > 0) {
  console.error('\nFAIL — the paths above are documented but not served.');
  process.exit(1);
}
console.log('\nOK — every route is documented and every documented path exists.');
