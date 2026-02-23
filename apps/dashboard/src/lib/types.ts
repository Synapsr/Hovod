export interface Asset {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  playbackId: string;
  sourceType: string;
  createdAt: string;
  durationSec: number | null;
  errorMessage: string | null;
  thumbnailUrl: string | null;
  customMetadata?: Record<string, string> | null;
}

export interface Rendition {
  id: string;
  quality: string;
  width: number;
  height: number;
  bitrateKbps: number;
  fileSizeBytes: number | null;
  codec: string;
}

export interface AiJobInfo {
  status: string;
  transcriptionStatus: string;
  subtitlesStatus: string;
  chaptersStatus: string;
  language: string | null;
}

export interface AssetPublicSettings {
  allowDownload: boolean;
  showTranscript: boolean;
  showChapters: boolean;
  showComments: boolean;
}

export interface AssetDetail extends Asset {
  renditions: Rendition[];
  currentStep?: string | null;
  aiJob?: AiJobInfo | null;
  publicSettings?: AssetPublicSettings | null;
}

export interface ThumbnailCue {
  start: number;
  end: number;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type UploadPhase = 'idle' | 'creating' | 'uploading' | 'processing' | 'done' | 'error';

/* ─── AI / Public Watch Page ─────────────────────────────── */

export interface AiData {
  status: string;
  language: string | null;
  subtitlesUrl: string | null;
  transcriptUrl: string | null;
  chaptersUrl: string | null;
}

export interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: Array<{ word: string; start: number; end: number }>;
}

export interface Transcript {
  language: string;
  duration: number;
  text: string;
  segments: TranscriptSegment[];
}

export interface Chapter {
  title: string;
  startTime: number;
  endTime: number;
}

export interface PlaybackSettings {
  primaryColor: string;
  theme: 'light' | 'dark';
  logoUrl: string | null;
}

export interface PlaybackData {
  assetId: string;
  playbackId: string;
  manifestUrl: string;
  thumbnailVttUrl: string;
  thumbnailUrl: string | null;
  playerUrl: string;
  title?: string;
  description?: string | null;
  durationSec?: number;
  canEdit?: boolean;
  publicSettings?: AssetPublicSettings;
  settings?: PlaybackSettings | null;
  ai?: AiData | null;
}

/* ─── Server Config / AI Options ───────────────────────── */

export interface ServerConfig {
  aiAvailable: boolean;
  chaptersAvailable: boolean;
}

export interface AiOptions {
  transcription: boolean;
  subtitles: boolean;
  chapters: boolean;
}

/* ─── Platform Settings ─────────────────────────────────── */

export interface PlatformSettings {
  primaryColor: string;
  theme: 'light' | 'dark';
  logoUrl: string | null;
  aiAutoTranscribe: boolean;
  aiAutoChapter: boolean;
}

/* ─── Organization ───────────────────────────────────────── */

export interface Organization {
  id: string;
  name: string;
  slug: string;
  tier: string;
  role: string;
}

/* ─── Members ───────────────────────────────────────────── */

export interface OrgMember {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: string;
}

/* ─── Comments ──────────────────────────────────────────── */

export interface Comment {
  id: string;
  authorName: string;
  emailHash: string;
  body: string;
  timestampSec: number | null;
  createdAt: string;
}

export interface CommentsResponse {
  comments: Comment[];
  total: number;
}

/* ─── Reactions ─────────────────────────────────────────── */

export interface ReactionsData {
  counts: Record<string, number>;
  userReactions: string[];
}

/* ─── Analytics ──────────────────────────────────────────── */

export interface AnalyticsTimeSeries {
  date: string;
  views: number;
  watchTimeSec: number;
  uniqueSessions: number;
}

export interface AnalyticsHourly {
  hour: number;
  views: number;
}

export interface AssetAnalytics {
  lifetime: {
    totalViews: number;
    totalUniqueSessions: number;
    totalWatchTimeSec: number;
    avgWatchPercent: number;
    engagementScore: number;
    peakHour: number | null;
    qualityDistribution: Record<string, number>;
    retentionCurve: number[];
  };
  timeSeries: AnalyticsTimeSeries[];
  hourlyBreakdown: AnalyticsHourly[];
}

export interface OverviewAnalytics {
  summary: {
    totalViews: number;
    totalWatchTimeSec: number;
    totalAssets: number;
    avgEngagementScore: number;
  };
  timeSeries: AnalyticsTimeSeries[];
  topAssets: Array<{
    assetId: string;
    title: string;
    views: number;
    engagementScore: number;
  }>;
  peakHours: AnalyticsHourly[];
}
