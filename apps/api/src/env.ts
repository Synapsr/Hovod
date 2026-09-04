import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://redis:6379'),
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.string().default('true').transform((v) => v === 'true'),
  S3_PUBLIC_BASE_URL: z.string().url(),
  DASHBOARD_URL: z.string().url().default('http://localhost:3001'),
  CORS_ORIGIN: z.string().default('*'),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  UPLOAD_DIR: z.string().default('/data/uploads'),

  /* ─── Auth (required) ─────────────────────────────────── */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET is required and must be at least 32 characters'),
  /**
   * Pepper for API-key hashes. Optional: when unset the API falls back to
   * JWT_SECRET so keys issued before this variable existed keep working.
   * Setting it lets JWT_SECRET be rotated without invalidating every API key.
   */
  API_KEY_SECRET: z.string().min(32, 'API_KEY_SECRET must be at least 32 characters').optional(),

  /* ─── Registration (optional — open by default) ──────── */
  REGISTRATION_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  REGISTRATION_ALLOWED_DOMAINS: z.string().optional().transform((v) =>
    v ? v.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean) : undefined
  ),

  /* ─── Billing (optional — omit to disable Stripe) ────── */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRO_PRICE_ID: z.string().optional(),
  STRIPE_BUSINESS_PRICE_ID: z.string().optional(),
  WEBHOOK_URL: z.string().url().optional(),

  /* ─── Database pool (optional — auto-detected from hardware) */
  DB_POOL_SIZE: z.coerce.number().int().min(1).optional(),

  /* ─── Analytics (optional) ───────────────────────────── */
  /** Playback sessions older than this are purged by the daily cleanup job. */
  ANALYTICS_RETENTION_DAYS: z.coerce.number().int().min(1).default(400),

  /* ─── AI Processing (optional — mirrors worker env) ──── */
  AI_ENABLED: z.string().default('false').transform((v) => v === 'true'),
  WHISPER_API_URL: z.string().optional(),
  WHISPER_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);

/** Stripe billing is available when both Stripe keys are set */
export const hasStripe = !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);

/** Pepper used to hash API keys — falls back to JWT_SECRET for existing installs. */
export const apiKeySecret = env.API_KEY_SECRET ?? env.JWT_SECRET;

/** CORS_ORIGIN='*' reflects any origin. Convenient when self-hosting, risky in production. */
export const corsReflectsAnyOrigin = env.CORS_ORIGIN.trim() === '*';

/** Parsed allow-list (empty when every origin is reflected). */
export const corsOrigins = corsReflectsAnyOrigin
  ? []
  : env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
