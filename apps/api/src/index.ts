import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { env, isCloud, appUrl, emailEnabled, corsReflectsAnyOrigin, corsOrigins } from './env.js';
import { runMigrations, bootstrapDefaultOrg } from './db.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerAuth, extractCredential, type RateLimitCheck } from './middleware/auth.js';
import { configureBucket } from './s3.js';
import { healthRoutes } from './routes/health.js';
import { assetRoutes } from './routes/assets.js';
import { playbackRoutes } from './routes/playback.js';
import { analyticsRoutes } from './routes/analytics.js';
import { aiRoutes } from './routes/ai.js';
import { settingsRoutes } from './routes/settings.js';
import { authRoutes } from './routes/auth.js';
import { orgRoutes } from './routes/orgs.js';
import { commentRoutes } from './routes/comments.js';
import { invitationRoutes } from './routes/invitations.js';
import { billingRoutes } from './routes/billing.js';
import { scheduleAnalyticsJobs } from './queue.js';
import { registerEntitlementGuard, getOrgEntitlement, rateLimitFor, SELFHOST_RATE_LIMIT_PER_MIN } from './services/entitlements.js';
import { startReconcileScheduler, type ReconcileScheduler } from './services/billing-reconcile.js';

const app = Fastify({
  logger: true,
  bodyLimit: 1_048_576, // 1 MB max JSON body
});

/* ─── Security Middleware ────────────────────────────────── */

const EMBEDDABLE_PREFIXES = ['/embed/', '/watch/'];

/**
 * Base Content-Security-Policy for every response.
 *
 * `blob:` in `worker-src`/`img-src`/`media-src` keeps hls.js (which spawns a
 * blob worker and feeds the video element blob URLs) working, and `https:` in
 * `img-src`/`media-src`/`connect-src` allow http: too: a self-hosted MinIO or an
 * internal S3 endpoint is routinely served over plain HTTP, and blocking it made
 * every thumbnail and poster disappear from the dashboard.
 * They cover the S3/CDN origin the manifests,
 * segments and thumbnails are served from — which is configurable, so it cannot
 * be enumerated here.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob: https: http:",
  "connect-src 'self' https: http: ws: wss:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
];

const CSP_SAME_ORIGIN = [...CSP_DIRECTIVES, "frame-ancestors 'self'"].join('; ');
const CSP_EMBEDDABLE = [...CSP_DIRECTIVES, 'frame-ancestors *'].join('; ');

app.register(helmet, {
  contentSecurityPolicy: false, // set below so /embed and /watch can stay framable
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  frameguard: false, // managed per-route below
});

app.addHook('onSend', async (request, reply) => {
  const embeddable = EMBEDDABLE_PREFIXES.some((p) => request.url.startsWith(p));
  if (embeddable) {
    reply.removeHeader('X-Frame-Options');
    reply.header('Content-Security-Policy', CSP_EMBEDDABLE);
  } else {
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Content-Security-Policy', CSP_SAME_ORIGIN);
  }
});

/* ─── Rate limiting ──────────────────────────────────────── */

/** Per-IP ceiling for requests that carry no credentials at all. */
const ANON_IP_LIMIT = 300;
/** Per-IP ceiling for requests that do carry credentials (valid or not). */
const CREDENTIALED_IP_LIMIT = 1_200;
/** Rejected credentials per IP per minute before the API answers 429 instead of 401. */
const AUTH_FAILURE_LIMIT = 10;
/** Requests per organization per minute, counted after authentication succeeds (self-host; cloud reads the plan). */
const PER_ORG_LIMIT = SELFHOST_RATE_LIMIT_PER_MIN;

app.register(rateLimit, {
  // Applied by hand below so that it runs BEFORE the auth hook: the plugin's
  // own global mode installs a per-route hook, which Fastify runs after every
  // instance-level onRequest hook — failed authentication was never throttled.
  global: false,
  max: CREDENTIALED_IP_LIMIT,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.ip,
});

app.register(cors, {
  origin: corsReflectsAnyOrigin ? true : corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
});

registerErrorHandler(app);

// Runs once helmet/rate-limit/cors are loaded and before the route plugins are,
// so the hooks below are instance-level and execute in this exact order:
//   1. per-IP limiter   2. authentication   3. per-org limiter
app.after(() => {
  /**
   * `createRateLimit()` counts the request and reports the bucket state; its
   * `isAllowed` flag only means "allow-listed", so the decision is `isExceeded`
   * (same logic the plugin's own route hook applies).
   */
  const limiter = (options: Parameters<typeof app.createRateLimit>[0]): RateLimitCheck => {
    const check = app.createRateLimit(options);
    return async (request) => {
      const result = await check(request);
      if (result.isAllowed || !result.isExceeded) return { isAllowed: true };
      return { isAllowed: false, ttl: result.ttl };
    };
  };

  const ipLimiter = limiter({
    max: (request) => (extractCredential(request) ? CREDENTIALED_IP_LIMIT : ANON_IP_LIMIT),
    timeWindow: '1 minute',
    keyGenerator: (request) => `ip:${request.ip}`,
  });
  const authFailureLimiter = limiter({
    max: AUTH_FAILURE_LIMIT,
    timeWindow: '1 minute',
    keyGenerator: (request) => `authfail:${request.ip}`,
  });
  const orgLimiter = limiter({
    // Per-plan budget in cloud mode (entitlement is cached 30 s); fixed in self-host.
    max: async (request) => (request.orgId ? rateLimitFor(await getOrgEntitlement(request.orgId)) : PER_ORG_LIMIT),
    timeWindow: '1 minute',
    keyGenerator: (request) => `org:${request.orgId ?? request.ip}`,
  });

  app.addHook('onRequest', async (request, reply) => {
    // Static dashboard assets are not part of the API budget.
    if (!request.url.startsWith('/v1/')) return;
    const result = await ipLimiter(request).catch((): { isAllowed: boolean; ttl?: number } => ({ isAllowed: true }));
    if (result.isAllowed) return;
    reply.header('retry-after', String(Math.max(1, Math.ceil((result.ttl ?? 60_000) / 1000))));
    return reply.code(429).send({ error: 'Too many requests — slow down and try again shortly' });
  });

  registerAuth(app, { authFailure: authFailureLimiter, perOrg: orgLimiter });

  // 4. entitlement guard (cloud): read-only / pending orgs may only GET.
  registerEntitlementGuard(app);
});

/* ─── Routes ─────────────────────────────────────────────── */

app.register(healthRoutes);
app.register(assetRoutes);
app.register(playbackRoutes);
app.register(analyticsRoutes);
app.register(aiRoutes);
app.register(settingsRoutes);
app.register(authRoutes);
app.register(orgRoutes);
app.register(invitationRoutes);
app.register(commentRoutes);

/* ─── Billing routes (cloud mode only — no Stripe client is ever created otherwise) ── */

if (isCloud) {
  app.register(billingRoutes);
}

/* ─── Serve dashboard (standalone mode) ──────────────────── */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(__dirname, '../../dashboard/dist');

if (existsSync(dashboardDir)) {
  app.register(fastifyStatic, {
    root: dashboardDir,
    wildcard: false,
    // Hashed assets (js/css) are immutable — cache forever
    // index.html must always be revalidated to pick up new deploys
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  // The embed player ships as its own lightweight entry (embed.html) so third-party pages
  // do not download the dashboard bundle. Fall back to the SPA when it is missing.
  const hasEmbedEntry = existsSync(path.join(dashboardDir, 'embed.html'));

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/v1/') || request.url.startsWith('/health/')) {
      reply.code(404);
      return { error: 'Not found' };
    }
    reply.header('Cache-Control', 'no-cache');
    if (hasEmbedEntry && request.url.startsWith('/embed/')) {
      return reply.sendFile('embed.html');
    }
    return reply.sendFile('index.html');
  });
}

/* ─── Graceful shutdown ──────────────────────────────────── */

let reconcile: ReconcileScheduler | null = null;

async function shutdown(signal: string) {
  app.log.info(`Received ${signal}, shutting down...`);
  await reconcile?.stop();
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ─── Start ──────────────────────────────────────────────── */

const start = async () => {
  if (corsReflectsAnyOrigin && env.NODE_ENV === 'production') {
    app.log.warn(
      'CORS_ORIGIN is "*" — every origin is reflected with credentials allowed. ' +
      'Set CORS_ORIGIN to the dashboard origin(s) for a production deployment.',
    );
  }
  await runMigrations(app.log);
  await bootstrapDefaultOrg();
  try {
    await configureBucket();
    app.log.info('S3 bucket CORS and public policy configured');
  } catch (err) {
    app.log.warn('Failed to configure S3 bucket (non-fatal — may need manual setup): ' + (err as Error).message);
  }
  await scheduleAnalyticsJobs();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  reconcile = startReconcileScheduler(app.log);

  const dashboardMode = existsSync(dashboardDir) ? `built-in (:${env.PORT})` : appUrl;
  const lines: [string, string][] = [
    ['API',       `http://0.0.0.0:${env.PORT}`],
    ['Dashboard', dashboardMode],
    ['App URL',   appUrl],
    ['S3',        env.S3_ENDPOINT],
    ['Mode',      isCloud ? 'cloud (Stripe, plan limits)' : 'self-host (unlimited)'],
    ['Email',     emailEnabled ? 'Resend' : 'disabled'],
  ];
  const maxVal = Math.max(...lines.map(([, v]) => v.length));
  const w = maxVal + 14; // label(10) + padding
  const bar = '═'.repeat(w);
  const pad = (s: string) => s.padEnd(w - 2);
  console.log('');
  console.log(`  ╔${bar}╗`);
  console.log(`  ║${' '.repeat(Math.floor((w - 14) / 2))}Hovod is ready${' '.repeat(Math.ceil((w - 14) / 2))}║`);
  console.log(`  ╠${bar}╣`);
  for (const [label, value] of lines) {
    console.log(`  ║  ${pad(`${label.padEnd(10)} ${value}`)}║`);
  }
  console.log(`  ╚${bar}╝`);
  console.log('');
};

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
