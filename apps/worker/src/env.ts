import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  REDIS_URL: z.string().default('redis://redis:6379'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  S3_ENDPOINT: z.string().min(1, 'S3_ENDPOINT is required'),
  S3_REGION: z.string().min(1, 'S3_REGION is required'),
  S3_BUCKET: z.string().min(1, 'S3_BUCKET is required'),
  S3_ACCESS_KEY_ID: z.string().min(1, 'S3_ACCESS_KEY_ID is required'),
  S3_SECRET_ACCESS_KEY: z.string().min(1, 'S3_SECRET_ACCESS_KEY is required'),
  S3_FORCE_PATH_STYLE: z.string().default('true').transform((v) => v === 'true'),
  UPLOAD_DIR: z.string().default('/data/uploads'),
  WEBHOOK_URL: z.string().url().optional(),

  /* ─── Scaling (optional — auto-detected from hardware) ── */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).optional(),
  FFMPEG_THREADS: z.coerce.number().int().min(0).optional(),
  DB_POOL_SIZE: z.coerce.number().int().min(1).optional(),

  /* ─── AI Processing (all optional) ─────────────────────── */
  WHISPER_API_URL: z.string().url().optional(),
  WHISPER_API_KEY: z.string().optional(),
  WHISPER_MODEL: z.string().default('whisper-1'),
  LLM_PROVIDER: z.enum(['openai', 'anthropic', 'groq', 'custom']).optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_API_URL: z.string().url().optional(),
  AI_ENABLED: z.string().default('true').transform((v) => v === 'true'),
});

export const env = envSchema.parse(process.env);
