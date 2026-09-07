import 'dotenv/config';
import { z } from 'zod';

const bool = (defaultValue: 'true' | 'false') =>
  z.string().default(defaultValue).transform((v) => v === 'true' || v === '1');

/** Variables that must all be present when `HOVOD_CLOUD=true`. */
const CLOUD_REQUIRED = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_PRO',
  'STRIPE_PRICE_BUSINESS',
  'RESEND_API_KEY',
  'EMAIL_FROM',
] as const;

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
  /** Public base URL of the dashboard/API (embed links, emails, Stripe return URLs). */
  APP_URL: z.string().url().optional(),
  /** @deprecated alias of APP_URL, honoured when APP_URL is unset. */
  DASHBOARD_URL: z.string().url().optional(),
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

  /* ─── Cloud mode (paid plans, Stripe, entitlements) ───── */
  /** `true` turns on paid-only mode: Checkout at signup, entitlement checks, plan limits. */
  HOVOD_CLOUD: bool('false'),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRICE_PRO: z.string().min(1).optional(),
  STRIPE_PRICE_BUSINESS: z.string().min(1).optional(),
  /**
   * Customer-portal configuration to open (`bpc_…`). Optional: Stripe falls back
   * to the account's default configuration. Set it when the Stripe account is
   * shared with another product, whose default configuration would not list
   * Hovod's prices and would leave customers unable to switch plans.
   */
  STRIPE_PORTAL_CONFIGURATION_ID: z.string().min(1).optional(),

  /* ─── Email (Resend; required in cloud, optional in self-host) */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** Sender, e.g. `Hovod <no-reply@hovod.dev>`. */
  EMAIL_FROM: z.string().min(3).optional(),

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
}).superRefine((values, ctx) => {
  // Cloud mode is all-or-nothing: refuse to boot half-configured rather than
  // discover a missing Stripe price on the first signup.
  if (values.HOVOD_CLOUD) {
    const missing = CLOUD_REQUIRED.filter((key) => !values[key]);
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [missing[0]],
        message: `HOVOD_CLOUD=true requires ${missing.join(', ')} to be set`,
      });
    }
  }
  // Self-host may send email; when it does, a sender address is mandatory.
  if (values.RESEND_API_KEY && !values.EMAIL_FROM) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMAIL_FROM'],
      message: 'EMAIL_FROM is required when RESEND_API_KEY is set',
    });
  }
});

export const env = envSchema.parse(process.env);

/** Paid-only cloud mode (`HOVOD_CLOUD=true`). Self-host is unlimited and never touches Stripe. */
export const isCloud = env.HOVOD_CLOUD;

/**
 * Public base URL of the deployment, without trailing slash.
 * `APP_URL` → legacy `DASHBOARD_URL` → the API's own default port.
 */
export const appUrl = (env.APP_URL ?? env.DASHBOARD_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** Transactional email can be sent (Resend configured). */
export const emailEnabled = !!(env.RESEND_API_KEY && env.EMAIL_FROM);

/** Pepper used to hash API keys — falls back to JWT_SECRET for existing installs. */
export const apiKeySecret = env.API_KEY_SECRET ?? env.JWT_SECRET;

/** CORS_ORIGIN='*' reflects any origin. Convenient when self-hosting, risky in production. */
export const corsReflectsAnyOrigin = env.CORS_ORIGIN.trim() === '*';

/** Parsed allow-list (empty when every origin is reflected). */
export const corsOrigins = corsReflectsAnyOrigin
  ? []
  : env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
