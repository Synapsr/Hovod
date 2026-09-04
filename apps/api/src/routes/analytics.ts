import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ANALYTICS, ANALYTICS_EVENT, ANALYTICS_PERIODS } from '@hovod/db';
import { findAssetOrFail } from '../services/asset.js';
import {
  ingestEvents,
  getAssetAnalytics,
  getOverviewAnalytics,
  type IngestEvent,
} from '../services/analytics.js';

/* ─── Wire schema ────────────────────────────────────────── */

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

/** Numbers coming from the player: anything non-finite becomes `undefined` (never a batch failure). */
const finiteNumber = z.preprocess(
  (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined),
  z.number().nonnegative().optional(),
);

/** Strings are clipped, not rejected — a long referrer must not drop the heartbeat it travels with. */
const clipped = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? v.slice(0, max) : undefined), z.string().optional());

/**
 * One player event. Unknown keys are stripped, so a legacy client still sending
 * `assetId` is accepted — the asset is always resolved server-side from `playbackId`.
 */
const eventSchema = z.object({
  sessionId: z.string().regex(ID_RE),
  playbackId: z.string().min(1).max(64),
  viewerId: z.string().regex(ID_RE).optional(),
  type: z.enum([
    ANALYTICS_EVENT.VIEW_START,
    ANALYTICS_EVENT.HEARTBEAT,
    ANALYTICS_EVENT.PAUSE,
    ANALYTICS_EVENT.SEEK,
    ANALYTICS_EVENT.QUALITY_CHANGE,
    ANALYTICS_EVENT.BUFFER_START,
    ANALYTICS_EVENT.BUFFER_END,
    ANALYTICS_EVENT.ERROR,
    ANALYTICS_EVENT.VIEW_END,
  ]),
  timestamp: finiteNumber,
  currentTime: finiteNumber,
  duration: finiteNumber,
  watchedMs: finiteNumber,
  qualityHeight: finiteNumber,
  bufferMs: finiteNumber,
  errorMessage: clipped(255),
  referrer: clipped(512),
  playerType: z.enum(['embed', 'dashboard', 'watch']).optional(),
  owner: z.boolean().optional(),
});

const batchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(ANALYTICS.MAX_BATCH_SIZE),
});

const periodSchema = z.enum(ANALYTICS_PERIODS).default('30d');

/* ─── Routes ─────────────────────────────────────────────── */

export async function analyticsRoutes(app: FastifyInstance) {
  /**
   * Ingest player events (public, batched). Each event is validated on its own:
   * malformed ones are counted in `rejected` and never fail the batch.
   */
  app.post(
    '/v1/analytics/events',
    {
      config: {
        // Own bucket, per IP: a busy embed must not eat the org's API quota (and vice-versa).
        rateLimit: { max: 300, timeWindow: '1 minute', keyGenerator: (request) => request.ip },
      },
    },
    async (request, reply) => {
      const { events } = batchSchema.parse(request.body);

      const valid: IngestEvent[] = [];
      let malformed = 0;
      for (const raw of events) {
        const parsed = eventSchema.safeParse(raw);
        if (parsed.success) valid.push(parsed.data as IngestEvent);
        else malformed++;
      }

      const result = valid.length > 0
        ? await ingestEvents(valid, {
            userAgent: (request.headers['user-agent'] as string) || '',
            acceptLanguage: (request.headers['accept-language'] as string) || '',
          })
        : { accepted: 0, rejected: 0 };

      reply.code(202);
      return { data: { accepted: result.accepted, rejected: result.rejected + malformed } };
    },
  );

  /* Per-asset analytics */
  app.get<{ Params: { id: string }; Querystring: { period?: string } }>(
    '/v1/assets/:id/analytics',
    async (request) => {
      await findAssetOrFail(request.params.id, request.orgId);
      const period = periodSchema.parse(request.query.period);
      const data = await getAssetAnalytics(request.params.id, period);
      return { data };
    },
  );

  /* Organization overview */
  app.get<{ Querystring: { period?: string } }>(
    '/v1/analytics/overview',
    async (request) => {
      const period = periodSchema.parse(request.query.period);
      const data = await getOverviewAnalytics(request.orgId!, period);
      return { data };
    },
  );
}
