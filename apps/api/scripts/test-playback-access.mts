#!/usr/bin/env tsx
/**
 * Private playback building blocks — no database, no S3 traffic:
 *
 *   - playback tokens: bound to one playback id, expiring, tamper-proof, and
 *     never interchangeable with a session JWT;
 *   - playlist rewriting: variant URIs keep the token, segments and sprites
 *     become presigned URLs on the private prefix, foreign URIs are dropped;
 *   - presigned URLs are stable inside a signing window (cacheable);
 *   - the storage prefix helper and the read-only-operation allow-list.
 *
 *   npx tsx apps/api/scripts/test-playback-access.mts
 */
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: 'mysql://user:pass@127.0.0.1:1/never-connected',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'hovod-vod',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  S3_PUBLIC_BASE_URL: 'http://cdn.example.test/hovod-vod',
  JWT_SECRET: 'x'.repeat(48),
  APP_URL: 'https://video.example.test',
});

const access = await import('../src/services/playback-access.js');
const { signJwt, verifyJwt } = await import('../src/services/cloud.js');
const { isReadOnlyOperation } = await import('../src/middleware/auth.js');
const { playbackStoragePrefix, PLAYBACK_POLICY } = await import('@hovod/db');
const { env } = await import('../src/env.js');

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`  ok   ${label}`); };

/* ─── Tokens ─────────────────────────────────────────────── */

{
  const { token, expiresAt } = access.signPlaybackToken('pb_one', 600);
  assert.equal(access.verifyPlaybackToken(token, 'pb_one'), true);
  assert.ok(Math.abs(expiresAt.getTime() - (Date.now() + 600_000)) < 5_000);
  ok('a fresh token verifies for its playback id');

  assert.equal(access.verifyPlaybackToken(token, 'pb_two'), false);
  ok('a token never unlocks another playback id');

  const [h, b, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ typ: 'playback', sub: 'pb_one', iat: 0, exp: 9_999_999_999 })).toString('base64url');
  assert.equal(access.verifyPlaybackToken(`${h}.${forged}.${sig}`, 'pb_one'), false);
  assert.equal(access.verifyPlaybackToken(`${h}.${b}.${sig!.slice(0, -2)}xx`, 'pb_one'), false);
  assert.equal(access.verifyPlaybackToken('', 'pb_one'), false);
  assert.equal(access.verifyPlaybackToken('a.b', 'pb_one'), false);
  assert.equal(access.verifyPlaybackToken('x'.repeat(5000), 'pb_one'), false);
  ok('tampered, truncated, oversized and malformed tokens are rejected');

  // Clamped to the minimum TTL, so craft an already-expired one with the real key.
  const realNow = Date.now;
  Date.now = () => realNow() - 3_600_000;
  const old = access.signPlaybackToken('pb_one', 60).token;
  Date.now = realNow;
  assert.equal(access.verifyPlaybackToken(old, 'pb_one'), false);
  ok('an expired token is rejected');

  const session = signJwt({ sub: 'user', org: 'org', tv: 0 }, env.JWT_SECRET);
  assert.equal(access.verifyPlaybackToken(session, 'user'), false);
  assert.throws(() => verifyJwt(token, env.JWT_SECRET));
  ok('session JWTs and playback tokens are not interchangeable');
}

/* ─── Playlists ──────────────────────────────────────────── */

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=1100000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
  '360p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=3300000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  '720p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x1',
  'https://evil.example.test/steal.m3u8',
  '',
].join('\n');

{
  const out = await access.rewriteMasterPlaylist(MASTER, 'tok.en.sig');
  assert.match(out, /^360p\/index\.m3u8\?token=tok\.en\.sig$/m);
  assert.match(out, /^720p\/index\.m3u8\?token=tok\.en\.sig$/m);
  assert.doesNotMatch(out, /evil\.example/);
  assert.match(out, /CODECS="avc1\.4d401e,mp4a\.40\.2"/);
  ok('master: variant URIs carry the token, foreign URIs are dropped, tags untouched');

  const anonymous = await access.rewriteMasterPlaylist(MASTER, null);
  assert.match(anonymous, /^360p\/index\.m3u8$/m);
  ok('master without a token keeps plain relative variant URIs');
}

const MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:6.000000,',
  'segment_000.ts',
  '#EXTINF:4.200000,',
  'segment_001.ts',
  '#EXTINF:1.0,',
  '../../playback/other/segment_000.ts',
  '#EXT-X-ENDLIST',
].join('\n');

{
  const windowStart = 1_700_000_100;
  const out = await access.rewriteMediaPlaylist(MEDIA, 'private/asset1/720p', windowStart);
  const lines = out.split('\n');
  const seg0 = lines.find((l) => l.includes('segment_000.ts'))!;
  assert.ok(seg0.startsWith('http://127.0.0.1:9000/hovod-vod/private/asset1/720p/segment_000.ts?'), seg0);
  assert.match(seg0, /X-Amz-Signature=/);
  assert.match(seg0, /X-Amz-Expires=\d+/);
  assert.match(out, /#EXT-X-MAP:URI="http:\/\/127\.0\.0\.1:9000\/hovod-vod\/private\/asset1\/720p\/init\.mp4\?[^"]+"/);
  assert.doesNotMatch(out, /\.\.\//);
  assert.ok(out.includes('#EXT-X-ENDLIST'));
  assert.equal(lines.filter((l) => l.includes('segment_')).length, 2);
  ok('media: segments and init section presigned on the private prefix, traversal dropped');

  const again = await access.rewriteMediaPlaylist(MEDIA, 'private/asset1/720p', windowStart);
  assert.equal(again, out);
  ok('presigned URLs are identical inside one signing window (cacheable)');

  const expires = Number(/X-Amz-Expires=(\d+)/.exec(seg0)![1]);
  assert.ok(expires >= env.PLAYBACK_URL_TTL_SEC && expires <= 604_800, String(expires));
  ok('presigned URLs outlive PLAYBACK_URL_TTL_SEC and respect the SigV4 7-day cap');
}

{
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nsprite.jpg#xywh=0,0,160,90\n\n00:00:05.000 --> 00:00:10.000\nsprite.jpg#xywh=160,0,160,90\n';
  const out = await access.rewriteThumbnailVtt(vtt, 'private/asset1/thumbnails', 1_700_000_100);
  const refs = out.split('\n').filter((l) => l.includes('#xywh='));
  assert.equal(refs.length, 2);
  for (const ref of refs) {
    assert.ok(ref.startsWith('http://127.0.0.1:9000/hovod-vod/private/asset1/thumbnails/sprite.jpg?'), ref);
  }
  assert.ok(refs[0]!.endsWith('#xywh=0,0,160,90'));
  assert.ok(out.includes('00:00:05.000 --> 00:00:10.000'));
  ok('thumbnail VTT: sprite references presigned, fragments and cue timings kept');
}

/* ─── URLs, prefixes, ACLs ───────────────────────────────── */

{
  assert.equal(playbackStoragePrefix('a1', PLAYBACK_POLICY.PUBLIC), 'playback/a1');
  assert.equal(playbackStoragePrefix('a1', PLAYBACK_POLICY.SIGNED), 'private/a1');
  assert.equal(playbackStoragePrefix('a1', null), 'playback/a1');
  ok('storage prefix follows the policy (unknown → public prefix)');

  const pub = access.playbackUrls({ id: 'a1', playbackId: 'pb1', playbackPolicy: 'public' }, null);
  assert.equal(pub.manifestUrl, 'http://cdn.example.test/hovod-vod/playback/a1/master.m3u8');
  assert.equal(pub.playbackToken, null);
  const signed = access.playbackUrls({ id: 'a1', playbackId: 'pb1', playbackPolicy: 'signed' }, 'tok.en.sig');
  assert.equal(signed.manifestUrl, 'https://video.example.test/v1/playback/pb1/master.m3u8?token=tok.en.sig');
  assert.equal(signed.thumbnailVttUrl, 'https://video.example.test/v1/playback/pb1/thumbnails.vtt?token=tok.en.sig');
  assert.equal(signed.playerUrl, 'https://video.example.test/embed/pb1?token=tok.en.sig');
  assert.doesNotMatch(JSON.stringify(signed), /cdn\.example\.test|private\/a1/);
  ok('public assets keep CDN URLs; signed assets route through the API with the token');

  const thumb = await access.thumbnailUrlFor({ id: 'a1', status: 'ready', customThumbnailKey: null, playbackPolicy: 'signed' });
  assert.ok(thumb!.includes('/private/a1/thumbnail.jpg?') && thumb!.includes('X-Amz-Signature='));
  assert.equal(await access.thumbnailUrlFor({ id: 'a1', status: 'processing', customThumbnailKey: null, playbackPolicy: 'signed' }), null);
  ok('signed thumbnails are presigned, and absent until ready');

  assert.deepEqual(access.objectAclFor({ playbackPolicy: 'signed' }), {});
  assert.deepEqual(access.objectAclFor({ playbackPolicy: 'public' }), { ACL: 'public-read' });
  ok('API-written objects of signed assets never get public-read');
}

{
  assert.equal(isReadOnlyOperation('POST', '/v1/assets/abc/playback-tokens'), true);
  assert.equal(isReadOnlyOperation('POST', '/v1/assets/abc/playback-tokens?x=1'), true);
  assert.equal(isReadOnlyOperation('POST', '/v1/assets/abc/process'), false);
  assert.equal(isReadOnlyOperation('PATCH', '/v1/assets/abc/playback-tokens'), false);
  assert.equal(isReadOnlyOperation('POST', '/v1/assets/abc/playback-tokens/../process'), false);
  assert.equal(isReadOnlyOperation('GET', '/v1/assets'), true);
  ok('only token minting is treated as a read among POSTs');
}

console.log(`\n${passed} playback-access checks passed`);
process.exit(0);
