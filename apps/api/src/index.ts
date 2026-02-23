import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { TIER_LIMITS, UNLIMITED_TIER_LIMITS, type OrgTier } from '@hovod/db';
import { env, hasStripe } from './env.js';
import { runMigrations, bootstrapDefaultOrg } from './db.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerAuth } from './middleware/auth.js';
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
import { scheduleAnalyticsJobs } from './queue.js';
import { closeMetering } from './services/metering.js';

const app = Fastify({
  logger: true,
  bodyLimit: 1_048_576, // 1 MB max JSON body
});

/* ─── Security Middleware ────────────────────────────────── */

app.register(helmet, {
  contentSecurityPolicy: false, // CSP handled by dashboard
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

app.register(rateLimit, {
  max: hasStripe
    ? (request) => {
        const tier = (request.orgTier as OrgTier) || 'free';
        return TIER_LIMITS[tier]?.rateLimitPerMin ?? 60;
      }
    : UNLIMITED_TIER_LIMITS.rateLimitPerMin,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.orgId || request.ip,
});

app.register(cors, {
  origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
});

registerErrorHandler(app);
registerAuth(app);

/* ─── Routes ─────────────────────────────────────────────── */

app.register(healthRoutes);
app.register(assetRoutes);
app.register(playbackRoutes);
app.register(analyticsRoutes);
app.register(aiRoutes);
app.register(settingsRoutes);
app.register(authRoutes);
app.register(orgRoutes);
app.register(commentRoutes);

/* ─── Billing routes (only when Stripe is configured) ────── */

if (hasStripe) {
  app.log.info('Stripe billing enabled');
  import('./routes/billing.js').then(({ billingRoutes }) => app.register(billingRoutes));
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

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/v1/') || request.url.startsWith('/health/')) {
      reply.code(404);
      return { error: 'Not found' };
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });
}

/* ─── Graceful shutdown ──────────────────────────────────── */

async function shutdown(signal: string) {
  app.log.info(`Received ${signal}, shutting down...`);
  await closeMetering();
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ─── Start ──────────────────────────────────────────────── */

const start = async () => {
  await runMigrations();
  await bootstrapDefaultOrg();
  try {
    await configureBucket();
    app.log.info('S3 bucket CORS and public policy configured');
  } catch (err) {
    app.log.warn('Failed to configure S3 bucket (non-fatal — may need manual setup): ' + (err as Error).message);
  }
  await scheduleAnalyticsJobs();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  const dashboardMode = existsSync(dashboardDir) ? `built-in (:${env.PORT})` : env.DASHBOARD_URL;
  const lines: [string, string][] = [
    ['API',       `http://0.0.0.0:${env.PORT}`],
    ['Dashboard', dashboardMode],
    ['S3',        env.S3_ENDPOINT],
    ['Billing',   hasStripe ? 'Stripe enabled' : 'disabled'],
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
