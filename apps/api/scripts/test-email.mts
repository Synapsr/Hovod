#!/usr/bin/env tsx
/**
 * Email providers — no network beyond 127.0.0.1:
 *
 *   - SMTP delivery through nodemailer against a minimal in-process SMTP server
 *     (AUTH PLAIN/LOGIN, envelope, headers, text + HTML parts);
 *   - failures stay best effort: a rejected recipient, an unreachable server and
 *     SMTP_REQUIRE_TLS against a server without STARTTLS all return
 *     `{ sent: false }` instead of throwing;
 *   - boot-time validation of the EMAIL_PROVIDER / SMTP_* / RESEND_* combinations
 *     (each case in its own process, since env.ts validates on import).
 *
 *   npx tsx apps/api/scripts/test-email.mts
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { devNull } from 'node:os';
import { fileURLToPath } from 'node:url';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`  ok   ${label}`); };

/* ─── Minimal SMTP server ────────────────────────────────── */

interface Received { auth: string | null; from: string; to: string[]; data: string }

function startSmtpServer(opts: { rejectRcpt?: boolean } = {}) {
  const received: Received[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let inData = false;
    let awaitingLogin: 'user' | 'pass' | null = null;
    let loginUser = '';
    let current: Received = { auth: null, from: '', to: [], data: '' };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply('220 test-smtp ready');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(current);
            current = { auth: current.auth, from: '', to: [], data: '' };
            reply('250 2.0.0 queued as TEST123');
          } else {
            current.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          continue;
        }
        if (awaitingLogin === 'user') { loginUser = Buffer.from(line, 'base64').toString(); awaitingLogin = 'pass'; reply('334 UGFzc3dvcmQ6'); continue; }
        if (awaitingLogin === 'pass') { current.auth = `${loginUser}:${Buffer.from(line, 'base64').toString()}`; awaitingLogin = null; reply('235 2.7.0 ok'); continue; }

        const [verb = '', ...rest] = line.split(' ');
        const arg = rest.join(' ');
        switch (verb.toUpperCase()) {
          case 'EHLO': socket.write('250-test-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n'); break;
          case 'HELO': reply('250 test-smtp'); break;
          case 'AUTH': {
            const [mech, initial] = arg.split(' ');
            if (mech === 'PLAIN' && initial) {
              const [, user, pass] = Buffer.from(initial, 'base64').toString().split('\0');
              current.auth = `${user}:${pass}`;
              reply('235 2.7.0 ok');
            } else if (mech === 'LOGIN') { awaitingLogin = 'user'; reply('334 VXNlcm5hbWU6'); } else reply('504 unsupported');
            break;
          }
          case 'MAIL': current.from = arg.replace(/^FROM:\s*/i, '').replace(/[<>]/g, '').split(' ')[0]!; reply('250 ok'); break;
          case 'RCPT':
            if (opts.rejectRcpt) { reply('550 5.1.1 no such user'); break; }
            current.to.push(arg.replace(/^TO:\s*/i, '').replace(/[<>]/g, '')); reply('250 ok'); break;
          case 'DATA': inData = true; reply('354 end with .'); break;
          case 'RSET': current = { auth: current.auth, from: '', to: [], data: '' }; reply('250 ok'); break;
          case 'NOOP': reply('250 ok'); break;
          case 'QUIT': reply('221 bye'); socket.end(); break;
          default: reply('502 not implemented');
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise<{ port: number; received: Received[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ port, received, close: () => new Promise((r) => { server.close(() => r()); }) });
    });
  });
}

/* ─── SMTP delivery ──────────────────────────────────────── */

const good = await startSmtpServer();
const rejecting = await startSmtpServer({ rejectRcpt: true });

// Hermetic: never pick up a developer's .env (dotenv only fills unset variables).
process.env.DOTENV_CONFIG_PATH = devNull;
Object.assign(process.env, {
  DATABASE_URL: 'mysql://user:pass@127.0.0.1:1/never-connected',
  S3_ENDPOINT: 'http://127.0.0.1:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'b',
  S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_PUBLIC_BASE_URL: 'http://cdn.example.test/b',
  JWT_SECRET: 'x'.repeat(48),
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(good.port),
  SMTP_USER: 'mailer@example.test', SMTP_PASSWORD: 's3cret pass',
  EMAIL_FROM: 'Hovod <no-reply@example.test>',
});
const { env, emailProvider, emailEnabled } = await import('../src/env.js');
const email = await import('../src/services/email.js');

assert.equal(emailProvider, 'smtp');
assert.equal(emailEnabled, true);
const opts = email.smtpTransportOptions();
assert.equal(opts.secure, false);
assert.deepEqual(opts.auth, { user: 'mailer@example.test', pass: 's3cret pass' });
ok('SMTP_HOST alone selects the smtp provider (STARTTLS-capable, not implicit TLS on 587-style ports)');

{
  const template = email.passwordResetTemplate({ resetUrl: 'https://app.example.test/reset?t=abc', expiresAt: new Date() });
  const result = await email.sendEmail({ to: 'viewer@example.test', ...template });
  assert.equal(result.sent, true, result.reason);
  assert.ok(result.id && result.id.includes('@'), String(result.id));
  const msg = good.received.at(-1)!;
  assert.equal(msg.auth, 'mailer@example.test:s3cret pass');
  assert.equal(msg.from, 'no-reply@example.test');
  assert.deepEqual(msg.to, ['viewer@example.test']);
  assert.match(msg.data, /^From: Hovod <no-reply@example\.test>$/m);
  assert.match(msg.data, /^To: viewer@example\.test$/m);
  assert.match(msg.data, /^Subject: Reset your Hovod password$/m);
  assert.match(msg.data, /Content-Type: multipart\/alternative/);
  assert.match(msg.data, /Content-Type: text\/plain/);
  assert.match(msg.data, /Content-Type: text\/html/);
  ok('a templated email is delivered with auth, envelope, headers and text + HTML parts');
}

{
  const results = await Promise.all(['a', 'b', 'c'].map((n) =>
    email.sendEmail({ to: `${n}@example.test`, subject: `Hello ${n}`, text: 't', html: '<p>h</p>' })));
  assert.ok(results.every((r) => r.sent));
  assert.deepEqual(good.received.slice(-3).map((m) => m.to[0]).sort(), ['a@example.test', 'b@example.test', 'c@example.test']);
  ok('concurrent sends go through the connection pool');
}

{
  await email.closeEmail();
  env.SMTP_PORT = rejecting.port;
  const result = await email.sendEmail({ to: 'nobody@example.test', subject: 's', text: 't', html: 'h' });
  assert.equal(result.sent, false);
  ok(`a rejected recipient returns sent:false without throwing (${result.reason})`);
}

{
  await email.closeEmail();
  env.SMTP_PORT = good.port;
  env.SMTP_REQUIRE_TLS = true;
  const result = await email.sendEmail({ to: 'viewer@example.test', subject: 's', text: 't', html: 'h' });
  assert.equal(result.sent, false);
  env.SMTP_REQUIRE_TLS = false;
  ok('SMTP_REQUIRE_TLS aborts against a server that offers no STARTTLS');
}

{
  await email.closeEmail();
  const closed = await startSmtpServer();
  await closed.close();
  env.SMTP_PORT = closed.port;
  const started = Date.now();
  const result = await email.sendEmail({ to: 'viewer@example.test', subject: 's', text: 't', html: 'h' });
  assert.equal(result.sent, false);
  assert.ok(Date.now() - started < 15_000);
  ok('an unreachable server returns sent:false quickly');
}

await email.closeEmail();
await good.close();
await rejecting.close();

/* ─── Boot-time validation ───────────────────────────────── */

const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  DOTENV_CONFIG_PATH: devNull,
  DATABASE_URL: 'mysql://u:p@127.0.0.1:1/x', S3_ENDPOINT: 'http://127.0.0.1:9000', S3_REGION: 'us-east-1',
  S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', S3_PUBLIC_BASE_URL: 'http://cdn.example.test/b',
  JWT_SECRET: 'x'.repeat(48),
};

/** Import env.ts in a fresh process; returns the resolved provider or the validation error. */
function boot(extra: Record<string, string>): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e',
    "const m = await import('./src/env.ts'); console.log('PROVIDER=' + m.emailProvider + ' SECURE=' + (m.env.SMTP_SECURE ?? m.env.SMTP_PORT === 465));"], {
    cwd: API_DIR, env: { ...BASE_ENV, ...extra }, encoding: 'utf8',
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

const cases: Array<[string, Record<string, string>, RegExp, boolean]> = [
  ['no provider → email disabled', {}, /PROVIDER=null/, true],
  ['Resend only (unchanged behaviour)', { RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.test' }, /PROVIDER=resend/, true],
  ['port 465 → implicit TLS by default', { SMTP_HOST: 'mail.test', SMTP_PORT: '465', EMAIL_FROM: 'a@b.test' }, /PROVIDER=smtp SECURE=true/, true],
  ['SMTP_SECURE overrides the port default', { SMTP_HOST: 'mail.test', SMTP_PORT: '2465', SMTP_SECURE: 'true', EMAIL_FROM: 'a@b.test' }, /SECURE=true/, true],
  ['both providers need EMAIL_PROVIDER', { SMTP_HOST: 'mail.test', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.test' }, /choose one with EMAIL_PROVIDER/, false],
  ['EMAIL_PROVIDER picks between both', { SMTP_HOST: 'mail.test', RESEND_API_KEY: 're_x', EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'a@b.test' }, /PROVIDER=resend/, true],
  ['EMAIL_PROVIDER=smtp without SMTP_HOST', { EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'a@b.test' }, /EMAIL_PROVIDER=smtp requires SMTP_HOST/, false],
  ['SMTP without EMAIL_FROM', { SMTP_HOST: 'mail.test' }, /EMAIL_FROM is required when SMTP_HOST is set/, false],
  ['SMTP_USER without SMTP_PASSWORD', { SMTP_HOST: 'mail.test', SMTP_USER: 'u', EMAIL_FROM: 'a@b.test' }, /SMTP_USER and SMTP_PASSWORD must be set together/, false],
  ['cloud accepts SMTP instead of Resend', {
    HOVOD_CLOUD: 'true', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh', STRIPE_PRICE_PRO: 'p', STRIPE_PRICE_BUSINESS: 'b',
    SMTP_HOST: 'mail.test', EMAIL_FROM: 'a@b.test',
  }, /PROVIDER=smtp/, true],
  ['cloud without any provider refuses to boot', {
    HOVOD_CLOUD: 'true', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh', STRIPE_PRICE_PRO: 'p', STRIPE_PRICE_BUSINESS: 'b',
    EMAIL_FROM: 'a@b.test',
  }, /HOVOD_CLOUD=true requires an email provider/, false],
];
for (const [label, extra, expected, shouldBoot] of cases) {
  const r = boot(extra);
  assert.equal(r.ok, shouldBoot, `${label}\n${r.out}`);
  assert.match(r.out, expected, label);
  ok(`env: ${label}`);
}

console.log(`\n${passed} email checks passed`);
process.exit(0);
