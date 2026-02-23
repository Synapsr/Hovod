const API = (import.meta.env.VITE_API_BASE_URL as string) || '';
const HEARTBEAT_INTERVAL = 10_000;
const BATCH_FLUSH_INTERVAL = 30_000;
const BATCH_MAX_SIZE = 20;

interface AnalyticsConfig {
  assetId: string;
  playbackId: string;
  playerType: 'embed' | 'dashboard';
}

interface EventPayload {
  sessionId: string;
  assetId: string;
  playbackId: string;
  eventType: string;
  currentTime?: number;
  duration?: number;
  qualityHeight?: number;
  bufferDurationMs?: number;
  errorMessage?: string;
  playerType?: string;
  referrer?: string;
  timestamp?: number;
}

function generateSessionId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(arr, (b) => chars[b % chars.length]).join('');
}

export class PlayerAnalytics {
  private sessionId: string;
  private config: AnalyticsConfig;
  private eventQueue: EventPayload[] = [];
  private heartbeatTimer: number | null = null;
  private flushTimer: number | null = null;

  constructor(config: AnalyticsConfig) {
    this.sessionId = generateSessionId();
    this.config = config;
    this.flushTimer = window.setInterval(() => this.flush(), BATCH_FLUSH_INTERVAL);
  }

  attachToVideo(
    videoEl: HTMLVideoElement,
    getQualityHeight: () => number | undefined,
  ): () => void {
    let hasStarted = false;

    const onPlay = () => {
      if (!hasStarted) {
        hasStarted = true;
        this.enqueue('view_start', {
          currentTime: Math.floor(videoEl.currentTime),
          duration: Math.floor(videoEl.duration || 0),
          qualityHeight: getQualityHeight(),
        });
      }
      this.startHeartbeat(videoEl, getQualityHeight);
    };

    const onPause = () => {
      this.stopHeartbeat();
      this.enqueue('pause', {
        currentTime: Math.floor(videoEl.currentTime),
        duration: Math.floor(videoEl.duration || 0),
      });
    };

    const onSeeked = () => {
      this.enqueue('seek', {
        currentTime: Math.floor(videoEl.currentTime),
        duration: Math.floor(videoEl.duration || 0),
      });
    };

    const onEnded = () => {
      this.stopHeartbeat();
      this.enqueue('view_end', {
        currentTime: Math.floor(videoEl.duration || 0),
        duration: Math.floor(videoEl.duration || 0),
      });
    };

    videoEl.addEventListener('play', onPlay);
    videoEl.addEventListener('pause', onPause);
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.addEventListener('ended', onEnded);

    const onVisibility = () => {
      if (document.hidden) {
        this.stopHeartbeat();
      } else if (!videoEl.paused) {
        this.startHeartbeat(videoEl, getQualityHeight);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    const onBeforeUnload = () => {
      this.enqueue('view_end', {
        currentTime: Math.floor(videoEl.currentTime),
        duration: Math.floor(videoEl.duration || 0),
      });
      this.flushSync();
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      videoEl.removeEventListener('play', onPlay);
      videoEl.removeEventListener('pause', onPause);
      videoEl.removeEventListener('seeked', onSeeked);
      videoEl.removeEventListener('ended', onEnded);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onBeforeUnload);
      this.destroy();
    };
  }

  trackQualityChange(qualityHeight: number, currentTime: number, duration: number) {
    this.enqueue('quality_change', { qualityHeight, currentTime, duration });
  }

  trackBufferStart(currentTime: number, duration: number) {
    this.enqueue('buffer_start', { currentTime, duration });
  }

  trackBufferEnd(bufferDurationMs: number, currentTime: number, duration: number) {
    this.enqueue('buffer_end', { bufferDurationMs, currentTime, duration });
  }

  trackError(errorMessage: string, currentTime?: number, duration?: number) {
    this.enqueue('error', { errorMessage, currentTime, duration });
  }

  /* ─── Internal ─────────────────────────────────────────── */

  private enqueue(eventType: string, data: Partial<EventPayload>) {
    this.eventQueue.push({
      sessionId: this.sessionId,
      assetId: this.config.assetId,
      playbackId: this.config.playbackId,
      eventType,
      playerType: this.config.playerType,
      referrer: document.referrer || undefined,
      timestamp: Date.now(),
      ...data,
    });

    if (this.eventQueue.length >= BATCH_MAX_SIZE) {
      this.flush();
    }
  }

  private startHeartbeat(
    videoEl: HTMLVideoElement,
    getQualityHeight: () => number | undefined,
  ) {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!videoEl.paused && !videoEl.ended) {
        this.enqueue('heartbeat', {
          currentTime: Math.floor(videoEl.currentTime),
          duration: Math.floor(videoEl.duration || 0),
          qualityHeight: getQualityHeight(),
        });
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async flush() {
    if (this.eventQueue.length === 0) return;
    const batch = this.eventQueue.splice(0);
    try {
      await fetch(`${API}/v1/analytics/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch }),
        keepalive: true,
      });
    } catch {
      // Silent — analytics must never break playback
    }
  }

  private flushSync() {
    if (this.eventQueue.length === 0) return;
    const batch = this.eventQueue.splice(0);
    const blob = new Blob([JSON.stringify({ events: batch })], {
      type: 'application/json',
    });
    navigator.sendBeacon(`${API}/v1/analytics/events`, blob);
  }

  private destroy() {
    this.stopHeartbeat();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
