import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ANALYTICS_EVENT } from '@hovod/db';
import { findAssetOrFail } from '../services/asset.js';
import {
  insertAnalyticsEvents,
  getAssetAnalytics,
  getOverviewAnalytics,
} from '../services/analytics.js';

const eventSchema = z.object({
  sessionId: z.string().min(1).max(36),
  assetId: z.string().min(1).max(36),
  playbackId: z.string().min(1).max(64),
  eventType: z.enum([
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
  currentTime: z.number().int().nonnegative().optional(),
  duration: z.number().int().nonnegative().optional(),
  qualityHeight: z.number().int().positive().optional(),
  bufferDurationMs: z.number().int().nonnegative().optional(),
  errorMessage: z.string().max(512).optional(),
  playerType: z.enum(['embed', 'dashboard', 'server']).optional(),
  referrer: z.string().max(2048).optional(),
  timestamp: z.number().optional(),
});

const batchSchema = z.object({
  events: z.array(eventSchema).min(1).max(50),
});

const periodSchema = z.enum(['7d', '30d', '90d', 'all']).default('30d');

export async function analyticsRoutes(app: FastifyInstance) {
  /* Ingest player events (batch) */
  app.post('/v1/analytics/events', async (request, reply) => {
    const { events } = batchSchema.parse(request.body);
    const ua = (request.headers['user-agent'] as string) || '';
    const lang = (request.headers['accept-language'] as string) || '';

    const accepted = await insertAnalyticsEvents(events, ua, lang);
    reply.code(202);
    return { data: { accepted } };
  });

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
      const data = await getOverviewAnalytics(period, request.orgId!);
      return { data };
    },
  );
}
