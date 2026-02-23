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

/** ID lengths for nanoid generation */
export const ID_LENGTH = {
  ASSET: 12,
  PLAYBACK: 16,
  JOB: 12,
  AI_JOB: 12,
  ANALYTICS_SESSION: 20,
  ANALYTICS_EVENT: 16,
  USER: 12,
  ORG: 12,
  API_KEY: 32,
  MEMBER: 12,
  SETTINGS: 12,
  COMMENT: 16,
  REACTION: 12,
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

/** Organization tiers */
export const ORG_TIER = {
  FREE: 'free',
  PRO: 'pro',
  BUSINESS: 'business',
} as const;

export type OrgTier = (typeof ORG_TIER)[keyof typeof ORG_TIER];

/** Organization member roles */
export const ORG_ROLE = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
} as const;

export type OrgRole = (typeof ORG_ROLE)[keyof typeof ORG_ROLE];

/** Default limits when Stripe is disabled (unlimited everything) */
export const UNLIMITED_TIER_LIMITS = {
  encodingMinutes: -1,
  storageGb: -1,
  deliveryMinutes: -1,
  maxAssets: -1,
  apiKeys: 100,
  rateLimitPerMin: 600,
} as const;

/** Per-tier resource limits (-1 = unlimited) */
export const TIER_LIMITS = {
  [ORG_TIER.FREE]: {
    encodingMinutes: 100,
    storageGb: 5,
    deliveryMinutes: 1_000,
    maxAssets: 10,
    apiKeys: 1,
    rateLimitPerMin: 60,
  },
  [ORG_TIER.PRO]: {
    encodingMinutes: 500,
    storageGb: 50,
    deliveryMinutes: 10_000,
    maxAssets: -1,
    apiKeys: 5,
    rateLimitPerMin: 300,
  },
  [ORG_TIER.BUSINESS]: {
    encodingMinutes: 2_000,
    storageGb: 250,
    deliveryMinutes: 50_000,
    maxAssets: -1,
    apiKeys: 20,
    rateLimitPerMin: 1_000,
  },
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
