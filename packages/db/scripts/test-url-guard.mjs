#!/usr/bin/env node
/**
 * Unit tests for the SSRF guard (packages/db/src/url-guard.ts).
 *
 * Run with: node packages/db/scripts/test-url-guard.mjs  (after `npm run build -w @hovod/db`)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicHttpUrl, isPrivateAddress, BlockedUrlError, ALLOWED_URL_PORTS, MAX_IMPORT_REDIRECTS } from '../dist/url-guard.js';

/** DNS stub: every hostname resolves to the addresses given. */
const resolveTo = (...addresses) => async () => addresses;

async function expectBlocked(url, options = {}) {
  await assert.rejects(
    () => assertPublicHttpUrl(url, options),
    (err) => err instanceof BlockedUrlError,
    `expected ${url} to be blocked`,
  );
}

test('IPv4 private / reserved ranges are refused', () => {
  for (const ip of [
    '0.0.0.0', '10.0.0.1', '10.255.255.255', '100.64.0.1', '127.0.0.1', '127.1.2.3',
    '169.254.169.254', '172.16.0.1', '172.31.255.254', '192.0.0.1', '192.0.2.5',
    '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('IPv4 public addresses are allowed', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test('IPv6 loopback / ULA / link-local / multicast and v4-mapped are refused', () => {
  for (const ip of [
    '::', '::1', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
    '64:ff9b::127.0.0.1', '2001:db8::1', '100::1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('IPv6 public addresses are allowed', () => {
  for (const ip of ['2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test('garbage is never treated as public', () => {
  for (const value of ['', 'not-an-ip', '999.1.1.1', '1.2.3', 'fe80::zz']) {
    assert.equal(isPrivateAddress(value), true);
  }
});

test('non-http schemes are refused', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://example.com/', 'ftp://example.com/x.mp4']) {
    await expectBlocked(url);
  }
});

test('userinfo is refused', async () => {
  await expectBlocked('http://user:pass@example.com/video.mp4', { resolve: resolveTo('93.184.216.34') });
  await expectBlocked('http://user@example.com/video.mp4', { resolve: resolveTo('93.184.216.34') });
});

test('only 80/443/8080/8443 are allowed', async () => {
  assert.deepEqual([...ALLOWED_URL_PORTS].sort((a, b) => a - b), [80, 443, 8080, 8443]);
  for (const port of [22, 25, 3306, 6379, 9000, 11211]) {
    await expectBlocked(`http://example.com:${port}/v.mp4`, { resolve: resolveTo('93.184.216.34') });
  }
  for (const port of [80, 443, 8080, 8443]) {
    const { url } = await assertPublicHttpUrl(`https://example.com:${port}/v.mp4`, { resolve: resolveTo('93.184.216.34') });
    assert.equal(url.hostname, 'example.com');
  }
});

test('a hostname resolving to a private address is refused', async () => {
  await expectBlocked('https://internal.example.com/v.mp4', { resolve: resolveTo('10.1.2.3') });
  // Mixed answers: one private address is enough to refuse.
  await expectBlocked('https://mixed.example.com/v.mp4', { resolve: resolveTo('93.184.216.34', '127.0.0.1') });
});

test('IP literals are checked without DNS', async () => {
  await expectBlocked('http://127.0.0.1/v.mp4');
  await expectBlocked('http://[::1]/v.mp4');
  await expectBlocked('http://169.254.169.254/latest/meta-data/');
  const { addresses } = await assertPublicHttpUrl('https://1.1.1.1/v.mp4');
  assert.deepEqual(addresses, ['1.1.1.1']);
});

test('unresolvable hosts are refused', async () => {
  await expectBlocked('https://nope.example/v.mp4', { resolve: async () => [] });
  await expectBlocked('https://nope.example/v.mp4', { resolve: async () => { throw new Error('ENOTFOUND'); } });
});

test('requireHttps rejects plain http', async () => {
  await expectBlocked('http://example.com/hook', { requireHttps: true, resolve: resolveTo('93.184.216.34') });
  const { url } = await assertPublicHttpUrl('https://example.com/hook', { requireHttps: true, resolve: resolveTo('93.184.216.34') });
  assert.equal(url.protocol, 'https:');
});

/* ─── Redirect handling (mirrors fetchPublicUrl in the worker) ─── */

test('every redirect hop is re-checked and the chain is bounded', async () => {
  const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
  const checked = [];

  /** Minimal stand-in for the worker's fetchPublicUrl. */
  async function follow(startUrl, chain) {
    let target = startUrl;
    for (let hop = 0; hop <= MAX_IMPORT_REDIRECTS; hop++) {
      const { url } = await assertPublicHttpUrl(target, { resolve: resolveTo('93.184.216.34') });
      checked.push(url.toString());
      const response = chain[url.toString()] ?? { status: 200 };
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      target = new URL(response.location, url).toString();
    }
    throw new Error('too many redirects');
  }

  // A public host bouncing to the metadata service must be caught on hop 2.
  await assert.rejects(
    () => follow('https://public.example.com/a', {
      'https://public.example.com/a': { status: 302, location: 'http://169.254.169.254/latest/' },
    }),
    (err) => err instanceof BlockedUrlError,
  );
  assert.deepEqual(checked, ['https://public.example.com/a']);

  // Relative Location headers are resolved against the current hop.
  const ok = await follow('https://public.example.com/b', {
    'https://public.example.com/b': { status: 301, location: '/final.mp4' },
  });
  assert.equal(ok.status, 200);

  // More than MAX_IMPORT_REDIRECTS hops aborts instead of looping forever.
  await assert.rejects(
    () => follow('https://loop.example.com/', {
      'https://loop.example.com/': { status: 302, location: 'https://loop.example.com/' },
    }),
    /too many redirects/,
  );
});
