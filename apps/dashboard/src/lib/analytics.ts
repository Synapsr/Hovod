/**
 * Player analytics client.
 *
 * One `sessionId` per (browser tab, playbackId) — persisted in sessionStorage so a
 * reload or a player remount keeps folding into the same server-side session (a new
 * id is issued after 30 minutes of inactivity). One `viewerId` per browser
 * (localStorage) so distinct viewers can be counted.
 *
 * Wire contract (docs/api-reference.md → Analytics):
 *  - `view_start` is sent immediately, on the first `timeupdate` past 1 s.
 *  - `heartbeat` every 10 s while playing, carrying `watchedMs` measured with
 *    wall-clock deltas while the video is actually playing (paused / hidden time
 *    excluded) and the current position.
 *  - Everything else is batched and flushed every 15 s, on `visibilitychange`
 *    → hidden and on `pagehide` via `sendBeacon` (`beforeunload` as a desktop fallback).
 *  - Events carry `owner: true` when the viewer can edit the asset; the server drops them.
 */

const API = (import.meta.env.VITE_API_BASE_URL as string) || '';
const HEARTBEAT_INTERVAL = 10_000;
const BATCH_FLUSH_INTERVAL = 15_000;
const BATCH_MAX_SIZE = 20;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_KEY_PREFIX = 'hovod-session:';
const VIEWER_KEY = 'hovod-viewer';
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export type PlayerType = 'embed' | 'dashboard' | 'watch';

export interface AnalyticsConfig {
  playbackId: string;
  playerType: PlayerType;
  /** The viewer can edit this asset (owner preview) — events are flagged and never counted. */
  owner?: boolean;
}

export type AnalyticsEventType =
  | 'view_start'
  | 'heartbeat'
  | 'pause'
  | 'seek'
  | 'quality_change'
  | 'buffer_start'
  | 'buffer_end'
  | 'error'
  | 'view_end';

export interface AnalyticsEventPayload {
  sessionId: string;
  playbackId: string;
  viewerId?: string;
  type: AnalyticsEventType;
  timestamp: number;
  currentTime?: number;
  duration?: number;
  watchedMs?: number;
  qualityHeight?: number;
  bufferMs?: number;
  errorMessage?: string;
  referrer?: string;
  playerType?: PlayerType;
  owner?: boolean;
}

/* ─── Ids ──────────────────────────────────────────────────── */

function randomId(length = 20): string {
  const arr = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < length; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}

function readStorage(storage: 'sessionStorage' | 'localStorage', key: string): string | null {
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: 'sessionStorage' | 'localStorage', key: string, value: string): void {
  try {
    window[storage].setItem(key, value);
  } catch {
    /* private mode / quota — ids simply live in memory */
  }
}

/** Per-browser id (localStorage). */
export function getViewerId(): string {
  const existing = readStorage('localStorage', VIEWER_KEY);
  if (existing && /^[A-Za-z0-9_-]{8,40}$/.test(existing)) return existing;
  const id = randomId();
  writeStorage('localStorage', VIEWER_KEY, id);
  return id;
}

/**
 * Per-tab session id for a playback (sessionStorage). Reused while the
 * previous activity is less than {@link SESSION_IDLE_MS} old.
 */
export function getSessionId(playbackId: string, now = Date.now()): string {
  const key = `${SESSION_KEY_PREFIX}${playbackId}`;
  const raw = readStorage('sessionStorage', key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { id?: unknown; at?: unknown };
      if (
        typeof parsed.id === 'string' &&
        /^[A-Za-z0-9_-]{8,40}$/.test(parsed.id) &&
        typeof parsed.at === 'number' &&
        now - parsed.at < SESSION_IDLE_MS
      ) {
        writeStorage('sessionStorage', key, JSON.stringify({ id: parsed.id, at: now }));
        return parsed.id;
      }
    } catch {
      /* corrupt entry — start over */
    }
  }
  const id = randomId();
  writeStorage('sessionStorage', key, JSON.stringify({ id, at: now }));
  return id;
}

function touchSession(playbackId: string, sessionId: string): void {
  writeStorage('sessionStorage', `${SESSION_KEY_PREFIX}${playbackId}`, JSON.stringify({ id: sessionId, at: Date.now() }));
}

/* ─── Client ──────────────────────────────────────────────── */

export class PlayerAnalytics {
  private readonly sessionId: string;
  private readonly viewerId: string;
  private readonly config: AnalyticsConfig;
  private queue: AnalyticsEventPayload[] = [];
  private heartbeatTimer: number | null = null;
  private flushTimer: number | null = null;
  private destroyed = false;

  /** Wall-clock instant playback last (re)started, or null while not playing. */
  private playingSince: number | null = null;
  /** Milliseconds played since the last heartbeat / flush. */
  private pendingWatchedMs = 0;
  private started = false;
  private bufferStartedAt: number | null = null;

  constructor(config: AnalyticsConfig) {
    this.config = config;
    this.sessionId = getSessionId(config.playbackId);
    this.viewerId = getViewerId();
    this.flushTimer = window.setInterval(() => this.flush(), BATCH_FLUSH_INTERVAL);
  }

  /**
   * Wire the video element. Returns the cleanup function (removes every listener
   * and flushes what is left).
   */
  attachToVideo(videoEl: HTMLVideoElement, getQualityHeight: () => number | undefined): () => void {
    const snapshot = () => ({
      currentTime: Math.floor(videoEl.currentTime || 0),
      duration: Number.isFinite(videoEl.duration) ? Math.floor(videoEl.duration) : undefined,
    });

    const onTimeUpdate = () => {
      if (this.started || videoEl.currentTime <= 1) return;
      this.started = true;
      this.send('view_start', { ...snapshot(), qualityHeight: getQualityHeight() });
    };

    const onPlaying = () => {
      if (this.bufferStartedAt !== null) {
        const ms = Date.now() - this.bufferStartedAt;
        this.bufferStartedAt = null;
        this.enqueue('buffer_end', { ...snapshot(), bufferMs: ms });
      }
      this.resumeClock();
      this.startHeartbeat(videoEl, getQualityHeight);
    };

    const onPause = () => {
      this.pauseClock();
      this.stopHeartbeat();
      if (!videoEl.ended) this.enqueue('pause', snapshot());
    };

    const onWaiting = () => {
      // Rebuffering: the clock stops until `playing` fires again.
      this.pauseClock();
      if (this.bufferStartedAt === null && this.started) {
        this.bufferStartedAt = Date.now();
        this.enqueue('buffer_start', snapshot());
      }
    };

    const onSeeked = () => {
      this.enqueue('seek', snapshot());
    };

    const onEnded = () => {
      this.pauseClock();
      this.stopHeartbeat();
      const s = snapshot();
      this.enqueue('view_end', { ...s, currentTime: s.duration ?? s.currentTime, watchedMs: this.takeWatched() });
      this.flush();
    };

    const onError = () => {
      const err = videoEl.error;
      if (err) this.trackError(`MEDIA_ERR_${err.code}${err.message ? `: ${err.message}` : ''}`, videoEl);
    };

    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('playing', onPlaying);
    videoEl.addEventListener('pause', onPause);
    videoEl.addEventListener('waiting', onWaiting);
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.addEventListener('ended', onEnded);
    videoEl.addEventListener('error', onError);

    // Tab hidden: stop the clock and flush with sendBeacon (the only reliable path on mobile).
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this.pauseClock();
        this.stopHeartbeat();
        this.flushBeacon(snapshot());
      } else if (!videoEl.paused && !videoEl.ended) {
        this.resumeClock();
        this.startHeartbeat(videoEl, getQualityHeight);
      }
    };
    const onPageHide = () => {
      this.pauseClock();
      this.flushBeacon(snapshot());
    };
    const onBeforeUnload = () => {
      // Desktop fallback: pagehide fires on every modern browser, beforeunload on the rest.
      this.pauseClock();
      this.flushBeacon(snapshot());
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);

    // A player mounted on an already-playing element (retry / remount) must start its clock.
    if (!videoEl.paused && !videoEl.ended) onPlaying();

    return () => {
      videoEl.removeEventListener('timeupdate', onTimeUpdate);
      videoEl.removeEventListener('playing', onPlaying);
      videoEl.removeEventListener('pause', onPause);
      videoEl.removeEventListener('waiting', onWaiting);
      videoEl.removeEventListener('seeked', onSeeked);
      videoEl.removeEventListener('ended', onEnded);
      videoEl.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      this.destroy(snapshot());
    };
  }

  trackQualityChange(qualityHeight: number, videoEl: HTMLVideoElement): void {
    this.enqueue('quality_change', {
      qualityHeight,
      currentTime: Math.floor(videoEl.currentTime || 0),
      duration: Number.isFinite(videoEl.duration) ? Math.floor(videoEl.duration) : undefined,
    });
  }

  trackError(errorMessage: string, videoEl?: HTMLVideoElement): void {
    this.enqueue('error', {
      errorMessage: errorMessage.slice(0, 255),
      currentTime: videoEl ? Math.floor(videoEl.currentTime || 0) : undefined,
      duration: videoEl && Number.isFinite(videoEl.duration) ? Math.floor(videoEl.duration) : undefined,
    });
  }

  /* ─── Watch clock ──────────────────────────────────────── */

  private resumeClock(): void {
    if (this.playingSince === null) this.playingSince = Date.now();
  }

  private pauseClock(): void {
    if (this.playingSince !== null) {
      this.pendingWatchedMs += Math.max(0, Date.now() - this.playingSince);
      this.playingSince = null;
    }
  }

  /** Milliseconds played since the previous call (moves the clock forward). */
  private takeWatched(): number {
    if (this.playingSince !== null) {
      const now = Date.now();
      this.pendingWatchedMs += Math.max(0, now - this.playingSince);
      this.playingSince = now;
    }
    const ms = Math.round(this.pendingWatchedMs);
    this.pendingWatchedMs = 0;
    return ms;
  }

  /* ─── Heartbeat ────────────────────────────────────────── */

  private startHeartbeat(videoEl: HTMLVideoElement, getQualityHeight: () => number | undefined): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (videoEl.paused || videoEl.ended || document.visibilityState === 'hidden') return;
      if (!this.started) return;
      this.enqueue('heartbeat', {
        currentTime: Math.floor(videoEl.currentTime || 0),
        duration: Number.isFinite(videoEl.duration) ? Math.floor(videoEl.duration) : undefined,
        qualityHeight: getQualityHeight(),
        watchedMs: this.takeWatched(),
      });
      touchSession(this.config.playbackId, this.sessionId);
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /* ─── Transport ────────────────────────────────────────── */

  private build(type: AnalyticsEventType, data: Partial<AnalyticsEventPayload>): AnalyticsEventPayload {
    return {
      sessionId: this.sessionId,
      viewerId: this.viewerId,
      playbackId: this.config.playbackId,
      type,
      playerType: this.config.playerType,
      referrer: document.referrer || undefined,
      owner: this.config.owner ? true : undefined,
      timestamp: Date.now(),
      ...data,
    };
  }

  private enqueue(type: AnalyticsEventType, data: Partial<AnalyticsEventPayload>): void {
    if (this.destroyed) return;
    this.queue.push(this.build(type, data));
    if (this.queue.length >= BATCH_MAX_SIZE) this.flush();
  }

  /** Send one event right away (used for `view_start`). */
  private send(type: AnalyticsEventType, data: Partial<AnalyticsEventPayload>): void {
    if (this.destroyed) return;
    this.post([this.build(type, data)]);
  }

  private post(events: AnalyticsEventPayload[]): void {
    if (events.length === 0) return;
    try {
      fetch(`${API}/v1/analytics/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Analytics must never break playback
    }
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    this.post(batch);
  }

  /**
   * Flush through `navigator.sendBeacon` — survives page teardown where fetch
   * does not. Attaches the outstanding watch time so the session tail is never lost.
   */
  private flushBeacon(position: { currentTime: number; duration?: number }): void {
    if (this.destroyed) return;
    const watchedMs = this.takeWatched();
    if (this.started && (watchedMs > 0 || this.queue.length > 0)) {
      this.queue.push(this.build('heartbeat', { ...position, watchedMs }));
    }
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    const body = JSON.stringify({ events: batch });
    let sent = false;
    try {
      if (typeof navigator.sendBeacon === 'function') {
        sent = navigator.sendBeacon(`${API}/v1/analytics/events`, new Blob([body], { type: 'application/json' }));
      }
    } catch {
      sent = false;
    }
    if (!sent) this.post(batch);
  }

  private destroy(position: { currentTime: number; duration?: number }): void {
    if (this.destroyed) return;
    this.stopHeartbeat();
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.pauseClock();
    this.flushBeacon(position);
    this.destroyed = true;
  }
}
