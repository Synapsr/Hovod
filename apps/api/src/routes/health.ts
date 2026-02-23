import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { env } from '../env.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health/live', async () => ({ ok: true }));

  app.get('/health/ready', async () => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch {
      return { ok: false, error: 'Database connection failed' };
    }
  });

  /* Server capabilities (AI availability, etc.) */
  app.get('/v1/config', async () => ({
    data: {
      aiAvailable: env.AI_ENABLED && !!env.WHISPER_API_URL && !!env.WHISPER_API_KEY,
      chaptersAvailable: !!env.LLM_PROVIDER && !!env.LLM_API_KEY,
    },
  }));
}
