/** Asset lifecycle statuses */
export const ASSET_STATUS = {
  CREATED: 'created',
  UPLOADED: 'uploaded',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  READY: 'ready',
  ERROR: 'error',
  DELETED: 'deleted',
} as const;

export type AssetStatus = (typeof ASSET_STATUS)[keyof typeof ASSET_STATUS];

/** Source type for assets */
export const SOURCE_TYPE = {
  UPLOAD: 'upload',
  URL: 'url',
} as const;

export type SourceType = (typeof SOURCE_TYPE)[keyof typeof SOURCE_TYPE];

/** Job statuses */
export const JOB_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

/** Processing steps for progress tracking */
export const PROCESSING_STEP = {
  DOWNLOADING: 'downloading',
  PROBING: 'probing',
  TRANSCODING_360P: 'transcoding_360p',
  TRANSCODING_480P: 'transcoding_480p',
  TRANSCODING_720P: 'transcoding_720p',
  TRANSCODING_1080P: 'transcoding_1080p',
  TRANSCODING_1440P: 'transcoding_1440p',
  TRANSCODING_2160P: 'transcoding_2160p',
  TRANSCODING_4320P: 'transcoding_4320p',
  THUMBNAILS: 'thumbnails',
  UPLOADING: 'uploading',
  AI_PROCESSING: 'ai_processing',
  FINALIZING: 'finalizing',
} as const;

export type ProcessingStep = (typeof PROCESSING_STEP)[keyof typeof PROCESSING_STEP];

/** Job types */
export const JOB_TYPE = {
  TRANSCODE: 'transcode',
  AI_PROCESS: 'ai_process',
} as const;

export type JobType = (typeof JOB_TYPE)[keyof typeof JOB_TYPE];

/** S3 path conventions */
export const S3_PATHS = {
  SOURCES_PREFIX: 'sources',
  PLAYBACK_PREFIX: 'playback',
  MASTER_PLAYLIST: 'master.m3u8',
  THUMBNAIL: 'thumbnail.jpg',
  THUMBNAILS_DIR: 'thumbnails',
  THUMBNAILS_VTT: 'thumbnails/thumbnails.vtt',
  AI_DIR: 'ai',
  AI_TRANSCRIPT: 'ai/transcript.json',
  AI_SUBTITLES: 'ai/subtitles.vtt',
  AI_CHAPTERS: 'ai/chapters.json',
  SETTINGS_PREFIX: 'settings',
} as const;

/** Analytics event types sent from the player */
export const ANALYTICS_EVENT = {
  VIEW_START: 'view_start',
  HEARTBEAT: 'heartbeat',
  PAUSE: 'pause',
  SEEK: 'seek',
  QUALITY_CHANGE: 'quality_change',
  BUFFER_START: 'buffer_start',
  BUFFER_END: 'buffer_end',
  ERROR: 'error',
  VIEW_END: 'view_end',
} as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENT)[keyof typeof ANALYTICS_EVENT];

/**
 * Analytics tunables shared by the API and the worker. The player-side timings
 * (10 s heartbeat, 15 s batch flush, 30 min session idle) live in
 * apps/dashboard/src/lib/analytics.ts — the browser bundle does not import this package.
 */
export const ANALYTICS = {
  /** BullMQ queue carrying the analytics maintenance jobs (session cleanup). */
  QUEUE_NAME: 'analytics',
  /** Legacy queue (v0.x hourly/daily aggregation) whose schedulers are removed at boot. */
  LEGACY_QUEUE_NAME: 'analytics-aggregation',
  /** Sessions older than this are deleted by the daily cleanup job (env ANALYTICS_RETENTION_DAYS). */
  RETENTION_DAYS_DEFAULT: 400,
  /** Rows deleted per DELETE statement by the cleanup job. */
  CLEANUP_BATCH_SIZE: 10_000,
  /** Max events accepted per ingestion request. */
  MAX_BATCH_SIZE: 50,
  /** A session is "completed" once max_position_sec >= this share of duration_sec. */
  COMPLETION_THRESHOLD: 0.9,
  /** Ingestion: watchedMs carried by a single heartbeat is clamped to this (bogus clients). */
  MAX_WATCHED_MS_PER_EVENT: 60_000,
  /** Ingestion: playbackId → asset/org resolution cache TTL. */
  PLAYBACK_CACHE_TTL_MS: 60_000,
} as const;

/** Analytics reporting periods accepted by the read endpoints. */
export const ANALYTICS_PERIODS = ['7d', '30d', '90d', 'all'] as const;

export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

/** ID lengths for nanoid generation */
export const ID_LENGTH = {
  ASSET: 12,
  PLAYBACK: 16,
  JOB: 12,
  AI_JOB: 12,
  ANALYTICS_SESSION: 20,
  ANALYTICS_VIEWER: 20,
  USER: 12,
  ORG: 12,
  API_KEY: 32,
  MEMBER: 12,
  SETTINGS: 12,
  COMMENT: 16,
  REACTION: 12,
  INVITATION: 12,
  PASSWORD_RESET: 12,
} as const;

/** Custom metadata limits */
export const METADATA_LIMITS = {
  MAX_KEYS: 10,
  MAX_KEY_LENGTH: 255,
  MAX_VALUE_LENGTH: 255,
} as const;

/** Available reaction emojis */
export const REACTION_EMOJIS = ['fire', 'heart', 'laugh', 'clap', 'mindblown', 'sad'] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

/* ─── Cloud Mode constants ─────────────────────────────── */

/** Paid plans (cloud mode only — self-host has no plan and no limits). */
export const PLAN = {
  PRO: 'pro',
  BUSINESS: 'business',
} as const;

export type Plan = (typeof PLAN)[keyof typeof PLAN];

/** Organization member roles */
export const ORG_ROLE = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
} as const;

export type OrgRole = (typeof ORG_ROLE)[keyof typeof ORG_ROLE];

/** Per-plan limits (cloud mode). Self-host is unlimited and never consults this table. */
export const PLAN_LIMITS = {
  [PLAN.PRO]: {
    encodingMinutes: 500,
    aiMinutes: 50,
    storageGb: 50,
    apiKeys: 5,
    members: 3,
    rateLimitPerMin: 300,
  },
  [PLAN.BUSINESS]: {
    encodingMinutes: 2_000,
    aiMinutes: 500,
    storageGb: 250,
    apiKeys: 20,
    members: 10,
    rateLimitPerMin: 600,
  },
} as const;

export type PlanLimits = (typeof PLAN_LIMITS)[Plan];

/** Days an org keeps full access after its first `past_due` before becoming read-only. */
export const GRACE_DAYS = 7;

/** Stripe subscription statuses, stored verbatim in `organizations.subscription_status`. */
export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  TRIALING: 'trialing',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  UNPAID: 'unpaid',
  INCOMPLETE: 'incomplete',
  INCOMPLETE_EXPIRED: 'incomplete_expired',
  PAUSED: 'paused',
} as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS];

/** What an organization is currently allowed to do (see apps/api/src/services/entitlements.ts). */
export const ENTITLEMENT_MODE = {
  /** No cloud mode: unlimited, never blocks. */
  SELFHOST: 'selfhost',
  /** Subscription active or trialing. */
  ACTIVE: 'active',
  /** Payment failed, still inside the grace window. */
  GRACE: 'grace',
  /** Subscription lapsed: GET only. */
  READONLY: 'readonly',
  /** No subscription yet (checkout not completed): GET only. */
  PENDING: 'pending',
} as const;

export type EntitlementMode = (typeof ENTITLEMENT_MODE)[keyof typeof ENTITLEMENT_MODE];

/** Invitation / password-reset token lifetimes. */
export const TOKEN_TTL = {
  INVITATION_DAYS: 7,
  PASSWORD_RESET_HOURS: 1,
} as const;

/** Webhook event types */
export const WEBHOOK_EVENT = {
  ASSET_READY: 'asset.ready',
  ASSET_ERROR: 'asset.error',
  ASSET_DELETED: 'asset.deleted',
  AI_COMPLETED: 'ai.completed',
  AI_FAILED: 'ai.failed',
} as const;

export type WebhookEvent = (typeof WEBHOOK_EVENT)[keyof typeof WEBHOOK_EVENT];

/* ─── AI Processing constants ─────────────────────────── */

/** AI job statuses */
export const AI_JOB_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const;

export type AiJobStatus = (typeof AI_JOB_STATUS)[keyof typeof AI_JOB_STATUS];

/** AI sub-step statuses */
export const AI_STEP_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const;

export type AiStepStatus = (typeof AI_STEP_STATUS)[keyof typeof AI_STEP_STATUS];

/* ─── Platform Settings defaults ─────────────────────── */

export const DEFAULT_SETTINGS = {
  PRIMARY_COLOR: '#4f46e5',
  THEME: 'dark',
  AI_AUTO_TRANSCRIBE: true,
  AI_AUTO_CHAPTER: true,
} as const;
