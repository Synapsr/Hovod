import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { z } from 'zod';

const bool = (defaultValue: 'true' | 'false') =>
  z.string().default(defaultValue).transform((v) => v === 'true' || v === '1');

/** Variables that must all be present when `HOVOD_CLOUD=true`. */
const CLOUD_REQUIRED = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_PRO',
  'STRIPE_PRICE_BUSINESS',
  'EMAIL_FROM',
] as const;

/** Transactional email backends. `smtp` works with any mail server; `resend` is the Resend REST API. */
export const EMAIL_PROVIDERS = ['smtp', 'resend'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

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
  /** Mirror of the worker's switch: `false` for R2 / ACL-less buckets (public read granted at bucket level). */
  S3_PUBLIC_ACL: bool('true'),
  /** Public base URL of the dashboard/API (embed links, emails, Stripe return URLs). */
  APP_URL: z.string().url().optional(),
  /** @deprecated alias of APP_URL, honoured when APP_URL is unset. */
  DASHBOARD_URL: z.string().url().optional(),
  CORS_ORIGIN: z.string().default('*'),
  /** CSP `frame-ancestors` for the embeddable pages (`/embed`, `/watch`). */
  EMBED_FRAME_ANCESTORS: z.string().default('*'),
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

  /* ─── Private playback (signed policy) ─────────────────── */
  /**
   * HMAC key for playback tokens. Optional: when unset it is derived from
   * JWT_SECRET (a distinct key, so a playback token can never pass as a session).
   * Setting it lets JWT_SECRET rotate without breaking issued playback tokens.
   */
  PLAYBACK_TOKEN_SECRET: z.string().min(32, 'PLAYBACK_TOKEN_SECRET must be at least 32 characters').optional(),
  /**
   * Lifetime of the presigned S3 URLs (segments, thumbnails, text tracks) handed
   * to a viewer of a signed asset. It bounds how long a loaded player keeps
   * working after its token expired, so keep it near your longest video.
   */
  PLAYBACK_URL_TTL_SEC: z.coerce.number().int().min(300).max(7 * 24 * 3600 - 3600).default(6 * 3600),

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

  /* ─── Email (SMTP or Resend; required in cloud, optional in self-host) */
  /**
   * Which backend sends email. Optional: inferred from whichever of SMTP_HOST /
   * RESEND_API_KEY is set; required only when both are.
   */
  EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).optional(),
  /** Sender, e.g. `Hovod <no-reply@hovod.dev>`. */
  EMAIL_FROM: z.string().min(3).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  SMTP_HOST: z.string().min(1).optional(),
  /** 587 (STARTTLS) by default; 465 for implicit TLS; 25 / 1025 for a local relay or catcher. */
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /**
   * Implicit TLS from the first byte. Defaults to `true` on port 465 and `false`
   * otherwise, where STARTTLS is still used whenever the server offers it.
   */
  SMTP_SECURE: z.enum(['true', 'false', '1', '0']).optional().transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
  /** Refuse to send unless the connection is encrypted (STARTTLS or implicit TLS). */
  SMTP_REQUIRE_TLS: bool('false'),
  /** Leave both unset for an unauthenticated relay. */
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),

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
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

  // Email backend: explicit EMAIL_PROVIDER, else whichever one is configured.
  const configured = [values.SMTP_HOST && 'smtp', values.RESEND_API_KEY && 'resend'].filter(Boolean) as EmailProvider[];
  if (values.EMAIL_PROVIDER === 'smtp' && !values.SMTP_HOST) issue('SMTP_HOST', 'EMAIL_PROVIDER=smtp requires SMTP_HOST');
  if (values.EMAIL_PROVIDER === 'resend' && !values.RESEND_API_KEY) issue('RESEND_API_KEY', 'EMAIL_PROVIDER=resend requires RESEND_API_KEY');
  if (!values.EMAIL_PROVIDER && configured.length > 1) {
    issue('EMAIL_PROVIDER', 'Both SMTP_HOST and RESEND_API_KEY are set — choose one with EMAIL_PROVIDER=smtp|resend');
  }
  if (!!values.SMTP_USER !== !!values.SMTP_PASSWORD) {
    issue(values.SMTP_USER ? 'SMTP_PASSWORD' : 'SMTP_USER', 'SMTP_USER and SMTP_PASSWORD must be set together');
  }
  // Self-host may send email; when it does, a sender address is mandatory.
  if (configured.length > 0 && !values.EMAIL_FROM) {
    issue('EMAIL_FROM', `EMAIL_FROM is required when ${values.SMTP_HOST ? 'SMTP_HOST' : 'RESEND_API_KEY'} is set`);
  }
  // Cloud sends invitations, resets and billing notices: a provider is mandatory.
  if (values.HOVOD_CLOUD && configured.length === 0) {
    issue('SMTP_HOST', 'HOVOD_CLOUD=true requires an email provider — set SMTP_HOST or RESEND_API_KEY');
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

/** Active email backend, or null when email is not configured. */
export const emailProvider: EmailProvider | null = !env.EMAIL_FROM
  ? null
  : env.EMAIL_PROVIDER ?? (env.SMTP_HOST ? 'smtp' : env.RESEND_API_KEY ? 'resend' : null);

/** Transactional email can be sent (SMTP or Resend configured, with a sender). */
export const emailEnabled = emailProvider !== null;

/** Pepper used to hash API keys — falls back to JWT_SECRET for existing installs. */
export const apiKeySecret = env.API_KEY_SECRET ?? env.JWT_SECRET;

/** HMAC key for playback tokens — explicit secret, or a key derived from JWT_SECRET. */
export const playbackTokenSecret: string = env.PLAYBACK_TOKEN_SECRET
  ?? createHmac('sha256', env.JWT_SECRET).update('hovod/playback-token/v1').digest('base64url');

/** CORS_ORIGIN='*' reflects any origin. Convenient when self-hosting, risky in production. */
export const corsReflectsAnyOrigin = env.CORS_ORIGIN.trim() === '*';

/**
 * CSP `frame-ancestors` for `/embed` and `/watch`. `*` lets any site iframe the
 * player; set it to your own origins to keep the player on your pages.
 */
export const embedFrameAncestors = env.EMBED_FRAME_ANCESTORS.trim() || '*';

/** Parsed allow-list (empty when every origin is reflected). */
export const corsOrigins = corsReflectsAnyOrigin
  ? []
  : env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
