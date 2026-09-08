import type { FastifyInstance } from 'fastify';
import { PLAN, PLAN_LIMITS } from '@hovod/db';
import { pool } from '../db.js';
import { env, isCloud, emailEnabled } from '../env.js';
import { planPricing } from '../services/billing.js';

/** Plans advertised to the signup page (cloud only). */
const PLANS = [
  { id: PLAN.PRO, name: 'Pro', limits: PLAN_LIMITS[PLAN.PRO] },
  { id: PLAN.BUSINESS, name: 'Business', limits: PLAN_LIMITS[PLAN.BUSINESS] },
] as const;

/** The advertised plans, priced from Stripe when it answers. */
async function advertisedPlans() {
  if (!isCloud) return [];
  const pricing = await planPricing();
  return PLANS.map((plan) => ({ ...plan, ...(pricing[plan.id] ?? {}) }));
}

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health/live', async () => ({ ok: true }));

  app.get('/health/ready', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch {
      // 503 so Docker HEALTHCHECK / load balancers actually take the instance out of rotation
      reply.code(503);
      return { ok: false, error: 'Database connection failed' };
    }
  });

  /* Server capabilities (AI availability, cloud mode, plans, email) */
  app.get('/v1/config', async () => ({
    data: {
      aiAvailable: env.AI_ENABLED && !!env.WHISPER_API_URL && !!env.WHISPER_API_KEY,
      chaptersAvailable: !!env.LLM_PROVIDER && !!env.LLM_API_KEY,
      cloud: isCloud,
      plans: await advertisedPlans(),
      emailEnabled,
      registrationEnabled: env.REGISTRATION_ENABLED,
    },
  }));
}
