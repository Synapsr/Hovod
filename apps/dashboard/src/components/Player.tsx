import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import type { ThumbnailCue } from '../lib/types.js';
import { formatTime, parseThumbnailVtt } from '../lib/helpers.js';
import { PlayerAnalytics } from '../lib/analytics.js';
import { useT } from '../lib/i18n/index.js';

export interface CommentMarker {
  timestampSec: number;
  authorName: string;
  body: string;
}

interface PlayerProps {
  url: string;
  thumbnailVttUrl?: string;
  poster?: string;
  accentColor?: string;
  title?: string;
  assetId?: string;
  playbackId?: string;
  playerType?: 'embed' | 'dashboard';
  subtitlesUrl?: string;
  externalVideoRef?: React.RefObject<HTMLVideoElement | null>;
  commentMarkers?: CommentMarker[];
  logoUrl?: string;
  /** Aspect ratio hint (width / height) used before the media metadata is known. Defaults to 16/9. */
  aspectRatio?: number;
  /** Fill the parent box (100% x 100%) instead of sizing from the aspect ratio. Used by the embed. */
  fill?: boolean;
  /** Letterbox / background color of the player box. Defaults to black. */
  backgroundColor?: string;
  /** Cap the height of the aspect-ratio box (e.g. `80vh` so vertical videos do not fill the page). */
  maxHeight?: string;
  /** Attempt to start playback immediately (falls back to muted autoplay when blocked). */
  autoplay?: boolean;
  /** Start muted. */
  muted?: boolean;
  /** Loop playback. */
  loop?: boolean;
  /** Start position in seconds. */
  startTime?: number;
  /** Captions state before any user preference is applied. Defaults to on when subtitles exist. */
  defaultCaptions?: boolean;
  /** Force captions on at start (e.g. `?cc=1`), overriding a remembered preference. */
  forceCaptions?: boolean;
}

const CAPTIONS_PREF_KEY = 'hovod-captions';
const DEFAULT_RATIO = 16 / 9;
const NETWORK_RETRY_MAX = 3;
const MEDIA_RETRY_MAX = 2;

const HLS_CONFIG = {
  enableWorker: true,
  lowLatencyMode: false,
  backBufferLength: 60,
  maxBufferLength: 30,
  maxMaxBufferLength: 120,
  fragLoadingMaxRetry: 6,
  manifestLoadingMaxRetry: 4,
  levelLoadingMaxRetry: 4,
};

function readCaptionsPref(): boolean | null {
  try {
    const v = sessionStorage.getItem(CAPTIONS_PREF_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

function writeCaptionsPref(on: boolean) {
  try {
    sessionStorage.setItem(CAPTIONS_PREF_KEY, on ? '1' : '0');
  } catch {
    // Storage unavailable (private mode, opaque origin) — preference is session-only
  }
}

/** Plain-text lines of the currently active cues (VTT markup stripped, no HTML injection). */
function readActiveCues(track: TextTrack): string[] {
  const out: string[] = [];
  const cues = track.activeCues;
  if (!cues) return out;
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i] as VTTCue;
    const text = (cue.text || '').replace(/<[^>]*>/g, '').trim();
    if (text) out.push(text);
  }
  return out;
}

function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type IOSVideoElement = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
};

function fullscreenElement(): Element | null {
  const d = document as FullscreenDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

export function Player({
  url, thumbnailVttUrl, poster, accentColor, title, assetId, playbackId, playerType, subtitlesUrl,
  externalVideoRef, commentMarkers, logoUrl, aspectRatio, fill, backgroundColor, maxHeight, autoplay, muted: mutedProp,
  loop, startTime, defaultCaptions, forceCaptions,
}: PlayerProps) {
  const { t } = useT();
  const accent = accentColor || '#6366f1';
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const qualityMenuRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  // Sync external ref with internal ref
  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    if (externalVideoRef) {
      (externalVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    }
  }, [externalVideoRef]);
  const hideTimerRef = useRef<number>(0);
  const suppressClickRef = useRef(false);
  const lastPointerTypeRef = useRef<string>('mouse');

  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [ready, setReady] = useState(false);
  const [captionsOn, setCaptionsOn] = useState<boolean>(() => {
    if (forceCaptions) return true;
    const pref = readCaptionsPref();
    if (pref !== null) return pref;
    return defaultCaptions ?? true;
  });
  const [activeCues, setActiveCues] = useState<string[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(!!mutedProp);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [levels, setLevels] = useState<{ height: number; bitrate: number; index: number }[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [pendingLevel, setPendingLevel] = useState<number | null>(null);
  const [autoLevelHeight, setAutoLevelHeight] = useState(0);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [thumbnails, setThumbnails] = useState<ThumbnailCue[]>([]);
  const [hoverProgress, setHoverProgress] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [mediaRatio, setMediaRatio] = useState<number | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);

  // Reset playback UI state when the source changes (SPA navigation between videos
  // reuses this Player instance, so the poster/end-screen must reset for the new video)
  useEffect(() => {
    setStarted(false);
    setEnded(false);
    setPlaying(false);
    setReady(false);
    setError(null);
    setRecovering(false);
    setLevels([]);
    setCurrentLevel(-1);
    setPendingLevel(null);
    setMediaRatio(null);
    setCurrentTime(0);
    setBuffered(0);
  }, [url]);

  // Apply initial muted state through the DOM (React does not reliably reflect the `muted` prop as an attribute)
  useEffect(() => {
    const el = videoRef.current;
    if (el && mutedProp) el.muted = true;
  }, [mutedProp]);

  // Initialize HLS (re-runs when the url changes or the user hits Retry)
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !url) return;

    let retryTimer = 0;
    let cancelled = false;

    const attemptAutoplay = () => {
      if (!autoplay || cancelled) return;
      const p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          if (cancelled) return;
          // Autoplay with sound was blocked — retry muted
          el.muted = true;
          setMuted(true);
          el.play().catch(() => {});
        });
      }
    };

    // Prefer hls.js wherever MSE is available (quality menu, error recovery, consistent UX);
    // fall back to native HLS only where it is not (iPhone Safari). Recent Chrome versions answer
    // "maybe" to canPlayType(vnd.apple.mpegurl), so native support must not be checked first.
    if (!Hls.isSupported()) {
      if (!el.canPlayType('application/vnd.apple.mpegurl')) {
        setError(t.player.cannotLoad);
        return;
      }
      const onLoadedMetadata = () => {
        setReady(true);
        if (startTime && startTime > 0 && startTime < el.duration) el.currentTime = startTime;
        attemptAutoplay();
      };
      const onError = () => setError(t.player.cannotLoad);
      el.addEventListener('loadedmetadata', onLoadedMetadata);
      el.addEventListener('error', onError);
      el.src = url;
      return () => {
        cancelled = true;
        el.removeEventListener('loadedmetadata', onLoadedMetadata);
        el.removeEventListener('error', onError);
        el.removeAttribute('src');
        el.load();
      };
    }

    const hls = new Hls({
      ...HLS_CONFIG,
      ...(startTime && startTime > 0 ? { startPosition: startTime } : {}),
    });
    hlsRef.current = hls;
    let networkRetries = 0;
    let mediaRetries = 0;

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const lvls = hls.levels.map((l, i) => ({ height: l.height, bitrate: l.bitrate, index: i }));
      setLevels(lvls);
      setCurrentLevel(-1);
      setReady(true);
      attemptAutoplay();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      if (hls.autoLevelEnabled) {
        setAutoLevelHeight(hls.levels[data.level]?.height ?? 0);
        setCurrentLevel(-1);
      } else {
        setCurrentLevel(data.level);
      }
      setPendingLevel(null);
    });

    // A successfully loaded fragment means we are past any transient network trouble
    hls.on(Hls.Events.FRAG_LOADED, () => {
      networkRetries = 0;
      setRecovering(false);
      setError(null);
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < NETWORK_RETRY_MAX) {
        const delay = 1000 * 2 ** networkRetries;
        networkRetries++;
        setRecovering(true);
        clearTimeout(retryTimer);
        // startLoad() resumes level/fragment loading; a manifest that never loaded must be re-requested
        const manifestFailed =
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
          data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
        retryTimer = window.setTimeout(() => {
          if (cancelled) return;
          if (manifestFailed) hls.loadSource(url);
          else hls.startLoad();
        }, delay);
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < MEDIA_RETRY_MAX) {
        mediaRetries++;
        setRecovering(true);
        if (mediaRetries === MEDIA_RETRY_MAX) hls.swapAudioCodec();
        hls.recoverMediaError();
        return;
      }

      // Unrecoverable: tear down and let the user retry
      hls.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
      setRecovering(false);
      setError(t.player.cannotLoad);
    });

    hls.loadSource(url);
    hls.attachMedia(el);

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      hls.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, retryKey]);

  // Load thumbnails VTT
  useEffect(() => {
    if (!thumbnailVttUrl) return;
    fetch(thumbnailVttUrl)
      .then(r => { if (r.ok) return r.text(); throw new Error('not found'); })
      .then(text => setThumbnails(parseThumbnailVtt(text, thumbnailVttUrl)))
      .catch(() => {});
  }, [thumbnailVttUrl]);

  // Video event listeners
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const onTimeUpdate = () => {
      setCurrentTime(el.currentTime);
      if (el.buffered.length > 0) {
        setBuffered(el.buffered.end(el.buffered.length - 1));
      }
    };
    const onDurationChange = () => setDuration(el.duration);
    const onLoadedMetadata = () => {
      if (el.videoWidth > 0 && el.videoHeight > 0) setMediaRatio(el.videoWidth / el.videoHeight);
    };
    const onPlay = () => { setPlaying(true); setStarted(true); setEnded(false); };
    const onPause = () => setPlaying(false);
    const onEnded = () => setEnded(true);
    // Clear the end state when the user scrubs back into the video
    const onSeeking = () => { if (el.currentTime < el.duration - 0.2) setEnded(false); };
    const onVolumeChange = () => setMuted(el.muted);

    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('durationchange', onDurationChange);
    el.addEventListener('loadedmetadata', onLoadedMetadata);
    el.addEventListener('resize', onLoadedMetadata);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    el.addEventListener('seeking', onSeeking);
    el.addEventListener('volumechange', onVolumeChange);

    return () => {
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('durationchange', onDurationChange);
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
      el.removeEventListener('resize', onLoadedMetadata);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('seeking', onSeeking);
      el.removeEventListener('volumechange', onVolumeChange);
    };
  }, []);

  // Auto-hide controls
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setShowControls(false), 3000);
  }, []);

  useEffect(() => {
    if (!playing) {
      setShowControls(true);
      clearTimeout(hideTimerRef.current);
    } else {
      resetHideTimer();
    }
    return () => clearTimeout(hideTimerRef.current);
  }, [playing, resetHideTimer]);

  // Fullscreen events (standard + WebKit prefixed + iOS native video fullscreen)
  useEffect(() => {
    const el = videoRef.current;
    const onChange = () => setIsFullscreen(!!fullscreenElement());
    const onIosBegin = () => {
      setIsFullscreen(true);
      // The native iOS player renders its own captions — hand the track over while it is up
      const track = el?.textTracks[0];
      if (track) track.mode = captionsOn ? 'showing' : 'hidden';
    };
    const onIosEnd = () => {
      setIsFullscreen(false);
      const track = el?.textTracks[0];
      if (track) track.mode = 'hidden';
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    el?.addEventListener('webkitbeginfullscreen', onIosBegin);
    el?.addEventListener('webkitendfullscreen', onIosEnd);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
      el?.removeEventListener('webkitbeginfullscreen', onIosBegin);
      el?.removeEventListener('webkitendfullscreen', onIosEnd);
    };
  }, [captionsOn]);

  // Subtitles: keep the <track> hidden (no native rendering) and mirror its active cues into our overlay
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !subtitlesUrl) {
      setActiveCues([]);
      return;
    }
    const list = el.textTracks;
    const cleanups: Array<() => void> = [];

    const attach = (track: TextTrack) => {
      track.mode = 'hidden';
      const onCueChange = () => setActiveCues(readActiveCues(track));
      track.addEventListener('cuechange', onCueChange);
      cleanups.push(() => track.removeEventListener('cuechange', onCueChange));
      onCueChange();
    };

    for (let i = 0; i < list.length; i++) attach(list[i]);
    const onAddTrack = (e: TrackEvent) => { if (e.track) attach(e.track); };
    list.addEventListener('addtrack', onAddTrack);

    return () => {
      list.removeEventListener('addtrack', onAddTrack);
      for (const c of cleanups) c();
      setActiveCues([]);
    };
  }, [subtitlesUrl]);

  // Quality menu: close on outside click / Escape
  useEffect(() => {
    if (!showQualityMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!qualityMenuRef.current?.contains(e.target as Node)) setShowQualityMenu(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setShowQualityMenu(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [showQualityMenu]);

  // Analytics tracking
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !assetId || !playbackId) return;

    const analytics = new PlayerAnalytics({
      assetId,
      playbackId,
      playerType: playerType || 'dashboard',
    });

    const getQualityHeight = () => {
      const hls = hlsRef.current;
      if (!hls) return undefined;
      const level = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
      return level >= 0 ? hls.levels[level]?.height : undefined;
    };

    const cleanup = analytics.attachToVideo(el, getQualityHeight);

    const hls = hlsRef.current;
    if (hls) {
      const onLevelSwitched = (_: string, data: { level: number }) => {
        const height = hls.levels[data.level]?.height;
        if (height) {
          analytics.trackQualityChange(height, Math.floor(el.currentTime), Math.floor(el.duration));
        }
      };

      const bufferStart = { current: 0 };
      const onBufferStall = () => {
        bufferStart.current = Date.now();
        analytics.trackBufferStart(Math.floor(el.currentTime), Math.floor(el.duration));
      };
      const onBufferAppended = () => {
        if (bufferStart.current > 0) {
          const ms = Date.now() - bufferStart.current;
          analytics.trackBufferEnd(ms, Math.floor(el.currentTime), Math.floor(el.duration));
          bufferStart.current = 0;
        }
      };

      const onHlsError = (_: string, data: { fatal: boolean; details: string }) => {
        if (data.fatal) {
          analytics.trackError(data.details, Math.floor(el.currentTime), Math.floor(el.duration));
        }
      };

      hls.on(Hls.Events.LEVEL_SWITCHED, onLevelSwitched);
      hls.on(Hls.Events.ERROR, onHlsError);

      // Buffer stall is not always available, use a fallback
      try {
        hls.on('hlsBufferStalled' as any, onBufferStall);
        hls.on('hlsBufferAppended' as any, onBufferAppended);
      } catch {
        // Some hls.js versions may not support these events
      }
    }

    return cleanup;
  }, [assetId, playbackId, playerType]);

  /* ─── Actions ─────────────────────────────────────────── */

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, []);

  const replay = () => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = 0;
    setEnded(false);
    void el.play();
  };

  const seek = useCallback((fraction: number) => {
    const el = videoRef.current;
    if (!el || !duration) return;
    el.currentTime = Math.max(0, Math.min(duration, fraction * duration));
  }, [duration]);

  const seekBy = useCallback((delta: number) => {
    const el = videoRef.current;
    if (!el || !isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + delta));
  }, []);

  const changeVolume = useCallback((delta: number) => {
    const el = videoRef.current;
    if (!el) return;
    const next = Math.max(0, Math.min(1, el.volume + delta));
    el.volume = next;
    if (delta > 0 && el.muted) el.muted = false;
    if (next === 0) el.muted = true;
  }, []);

  const switchQuality = (level: number) => {
    const hls = hlsRef.current;
    if (hls) {
      setPendingLevel(level);
      hls.currentLevel = level;
      if (level === -1) setCurrentLevel(-1);
    }
    setShowQualityMenu(false);
  };

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current as FullscreenElement | null;
    const video = videoRef.current as IOSVideoElement | null;
    if (!container) return;

    if (fullscreenElement()) {
      const d = document as FullscreenDocument;
      if (d.exitFullscreen) void d.exitFullscreen().catch(() => {});
      else d.webkitExitFullscreen?.();
      return;
    }

    const enterNative = () => {
      // iPhone Safari: elements cannot go fullscreen, only the <video> itself can
      if (video?.webkitEnterFullscreen) {
        try { video.webkitEnterFullscreen(); } catch { /* not allowed */ }
      }
    };

    if (container.requestFullscreen) {
      container.requestFullscreen().catch(enterNative);
    } else if (container.webkitRequestFullscreen) {
      try { container.webkitRequestFullscreen(); } catch { enterNative(); }
    } else {
      enterNative();
    }
  }, []);

  const toggleMute = useCallback(() => {
    const el = videoRef.current;
    if (el) el.muted = !el.muted;
  }, []);

  const toggleCaptions = useCallback(() => {
    setCaptionsOn((on) => {
      const next = !on;
      writeCaptionsPref(next);
      return next;
    });
  }, []);

  const retry = () => {
    setError(null);
    setRecovering(false);
    setRetryKey((k) => k + 1);
  };

  /* ─── Touch: first tap reveals the controls, second tap toggles play ── */

  const onSurfaceTouchStart = () => {
    // A new tap starts clean — a previous suppressed tap that never produced a click must not leak
    suppressClickRef.current = false;
  };

  const onSurfaceTouchEnd = () => {
    if (!isTouchDevice()) return;
    const controlsHidden = playing && !showControls;
    if (controlsHidden) {
      // Reveal the controls only; the synthesized click that follows this tap is swallowed
      suppressClickRef.current = true;
    }
    resetHideTimer();
  };

  const onSurfaceClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    togglePlay();
  };

  const onSurfaceDoubleClick = () => {
    // Double-tap on touch is already "reveal + toggle"; only a mouse double-click goes fullscreen
    if (lastPointerTypeRef.current === 'touch') return;
    toggleFullscreen();
  };

  /* ─── Keyboard shortcuts on the focused player ─────────── */

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    // Let native buttons/inputs handle activation keys; the seek slider has its own handler
    if ((tag === 'BUTTON' || tag === 'INPUT') && (e.key === ' ' || e.key === 'Enter')) return;
    if (target.getAttribute('role') === 'slider') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    let handled = true;
    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        togglePlay();
        break;
      case 'ArrowLeft':
        seekBy(-5);
        break;
      case 'ArrowRight':
        seekBy(5);
        break;
      case 'j':
      case 'J':
        seekBy(-10);
        break;
      case 'l':
      case 'L':
        seekBy(10);
        break;
      case 'ArrowUp':
        changeVolume(0.1);
        break;
      case 'ArrowDown':
        changeVolume(-0.1);
        break;
      case 'm':
      case 'M':
        toggleMute();
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'c':
      case 'C':
        if (subtitlesUrl) toggleCaptions();
        break;
      default:
        if (e.key >= '0' && e.key <= '9') {
          seek(Number(e.key) / 10);
        } else {
          handled = false;
        }
    }
    if (handled) {
      e.preventDefault();
      resetHideTimer();
    }
  };

  const onSliderKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        seekBy(-5);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        seekBy(5);
        break;
      case 'PageDown':
        seekBy(-30);
        break;
      case 'PageUp':
        seekBy(30);
        break;
      case 'Home':
        seek(0);
        break;
      case 'End':
        seek(1);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      resetHideTimer();
    }
  };

  /* ─── Progress bar pointer scrubbing (mouse + touch) ───── */

  const fractionFromPointer = (clientX: number) => {
    const rect = progressRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const onProgressPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrubbing(true);
    const fraction = fractionFromPointer(e.clientX);
    seek(fraction);
    setHoverProgress(fraction * 100);
    setHoverTime(fraction * duration);
  };

  const onProgressPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const fraction = fractionFromPointer(e.clientX);
    setHoverProgress(fraction * 100);
    setHoverTime(fraction * duration);
    if (scrubbing) seek(fraction);
  };

  const onProgressPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubbing) {
      setScrubbing(false);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    }
    if (e.pointerType !== 'mouse') setHoverProgress(null);
  };

  /* ─── Derived state ────────────────────────────────────── */

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;
  const controlsVisible = showControls || !playing;
  const ratio = mediaRatio ?? aspectRatio ?? DEFAULT_RATIO;
  const bg = backgroundColor || '#000';

  const hoverThumbnail = hoverProgress !== null
    ? thumbnails.find(t => hoverTime >= t.start && hoverTime < t.end)
    : null;

  const sortedLevels = useMemo(
    () => [...levels].sort((a, b) => b.height - a.height),
    [levels],
  );

  const levelHeight = (index: number) => levels.find(l => l.index === index)?.height ?? '?';
  const qualityLabel = pendingLevel !== null
    ? (pendingLevel === -1 ? t.player.auto : `${levelHeight(pendingLevel)}p`)
    : currentLevel === -1
      ? `${t.player.auto}${autoLevelHeight ? ` (${autoLevelHeight}p)` : ''}`
      : `${levelHeight(currentLevel)}p`;
  const selectedLevel = pendingLevel !== null ? pendingLevel : currentLevel;

  const showCaptions = captionsOn && activeCues.length > 0 && !error;

  return (
    <div
      ref={containerRef}
      className={`hovod-player relative select-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${fill ? 'w-full h-full' : 'w-full'}`}
      style={{ backgroundColor: bg, ...(fill ? {} : { aspectRatio: String(ratio), maxHeight }) }}
      role="region"
      aria-label={t.player.videoPlayer}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseMove={resetHideTimer}
    >
      <video
        ref={setVideoRef}
        className="absolute inset-0 w-full h-full object-contain"
        playsInline
        preload="metadata"
        crossOrigin="anonymous"
        poster={poster}
        loop={loop}
        onPointerDown={(e) => { lastPointerTypeRef.current = e.pointerType; }}
        onClick={onSurfaceClick}
        onTouchStart={onSurfaceTouchStart}
        onTouchEnd={onSurfaceTouchEnd}
        onDoubleClick={onSurfaceDoubleClick}
      >
        {subtitlesUrl && (
          <track kind="subtitles" src={subtitlesUrl} label={t.player.subtitles} />
        )}
      </video>

      {/* Poster overlay — fades out (~1s) when playback starts, fades back in when the video ends.
          object-cover fills the player frame at any embed size/aspect (scaling by the constraining
          edge and cropping the overflow), so a thumbnail whose aspect differs from the frame shows
          no black bars. */}
      {poster && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundColor: bg,
            opacity: !started || ended ? 1 : 0,
            transition: `opacity ${ended ? 600 : 1000}ms ease-in-out`,
          }}
          aria-hidden="true"
        >
          <img src={poster} alt="" className="w-full h-full object-cover" />
        </div>
      )}

      {/* End screen — return to the poster with a replay button */}
      {ended && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <button
            onClick={replay}
            className="pointer-events-auto w-16 h-16 rounded-full bg-black/55 backdrop-blur-sm flex items-center justify-center text-white hover:bg-black/75 hover:scale-105 transition-all"
            aria-label={t.player.replay}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
        </div>
      )}

      {/* Title overlay */}
      {title && (
        <div
          className={`absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent px-4 py-3 transition-opacity duration-300 pointer-events-none ${controlsVisible ? 'opacity-100' : 'opacity-0'}`}
        >
          <span className="text-sm font-medium text-white/90 drop-shadow-sm">{title}</span>
        </div>
      )}

      {/* Big play button when paused (not at the end — the replay button takes over there).
          Shown as soon as the manifest is parsed so the poster + play affordance appear immediately. */}
      {!playing && !ended && !error && (ready || duration > 0) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
      )}

      {/* Logo watermark — visible when paused, fades out on play */}
      {logoUrl && (
        <div
          className={`absolute top-4 right-4 transition-all duration-500 ease-out pointer-events-none ${
            !playing ? 'opacity-80 scale-100 translate-y-0' : 'opacity-0 scale-90 -translate-y-2'
          }`}
        >
          <img src={logoUrl} alt="" className="h-7 max-w-[120px] object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]" />
        </div>
      )}

      {/* Subtitle overlay — custom rendering sized with container queries (see player.css) */}
      {subtitlesUrl && (
        <div
          className="hovod-subtitles absolute left-0 right-0 flex justify-center pointer-events-none z-[3]"
          style={{ bottom: controlsVisible ? 'calc(4rem + 1cqh)' : '5cqh' }}
          aria-live="polite"
        >
          {showCaptions && (
            <div className="hovod-subtitles-box">
              {activeCues.map((line, i) => (
                <span key={i} className="block">{line}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reconnecting indicator (non-blocking) */}
      {recovering && !error && (
        <div className="absolute top-3 left-3 z-[4] flex items-center gap-2 rounded-full bg-black/60 backdrop-blur-sm px-3 py-1 text-[11px] text-zinc-200 pointer-events-none">
          <span className="w-3 h-3 rounded-full border-2 border-zinc-500 border-t-white animate-spin" />
          {t.player.reconnecting}
        </div>
      )}

      {/* Error overlay with retry */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
          <div className="text-center px-4">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-500 mx-auto mb-3">
              <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" />
            </svg>
            <p className="text-sm text-zinc-300">{error}</p>
            <button
              onClick={retry}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white/10 hover:bg-white/20 px-4 py-2 text-sm font-medium text-white transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              {t.player.retry}
            </button>
          </div>
        </div>
      )}

      {/* Comment markers — always visible at bottom of player, like YouTube chapter markers */}
      {commentMarkers && duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-[3px] pointer-events-none z-[2]">
          <div className="relative w-full h-full">
            {commentMarkers.map((marker, i) => {
              const position = (marker.timestampSec / duration) * 100;
              return (
                <div
                  key={i}
                  className="absolute top-0 -translate-x-1/2 w-[6px] h-full rounded-full"
                  style={{ left: `${position}%`, backgroundColor: accent }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Controls overlay */}
      <div
        className={`hovod-controls absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent pt-12 transition-opacity duration-300 z-[5] ${controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={(e) => e.stopPropagation()}
        onTouchEnd={(e) => { e.stopPropagation(); resetHideTimer(); }}
      >
        {/* Progress bar — a real focusable slider */}
        <div
          ref={progressRef}
          className="hovod-seek group/progress relative h-6 flex items-end px-3 cursor-pointer outline-none touch-none"
          role="slider"
          tabIndex={0}
          aria-label={t.player.seek}
          aria-valuemin={0}
          aria-valuemax={Math.floor(duration) || 0}
          aria-valuenow={Math.floor(currentTime)}
          aria-valuetext={`${formatTime(currentTime)} / ${formatTime(duration)}`}
          aria-orientation="horizontal"
          onKeyDown={onSliderKeyDown}
          onPointerDown={onProgressPointerDown}
          onPointerMove={onProgressPointerMove}
          onPointerUp={onProgressPointerUp}
          onPointerCancel={onProgressPointerUp}
          onPointerLeave={(e) => { if (!scrubbing && e.pointerType === 'mouse') setHoverProgress(null); }}
        >
          {/* Thumbnail preview */}
          {hoverThumbnail && hoverProgress !== null && (
            <div
              className="absolute bottom-7 -translate-x-1/2 pointer-events-none z-10"
              style={{ left: `clamp(${hoverThumbnail.w / 2}px, ${hoverProgress}%, calc(100% - ${hoverThumbnail.w / 2}px))` }}
            >
              <div
                className="border border-zinc-600 rounded overflow-hidden shadow-2xl"
                style={{
                  width: hoverThumbnail.w,
                  height: hoverThumbnail.h,
                  backgroundImage: `url(${hoverThumbnail.url})`,
                  backgroundPosition: `-${hoverThumbnail.x}px -${hoverThumbnail.y}px`,
                  backgroundSize: 'auto',
                }}
              />
              <div className="text-[10px] text-center text-white bg-black/80 py-0.5 rounded-b">
                {formatTime(hoverTime)}
              </div>
            </div>
          )}

          {/* Hover time indicator (when no thumbnails) */}
          {!hoverThumbnail && hoverProgress !== null && thumbnails.length === 0 && (
            <div
              className="absolute bottom-7 -translate-x-1/2 pointer-events-none z-10 text-[10px] text-white bg-black/80 px-2 py-1 rounded"
              style={{ left: `${hoverProgress}%` }}
            >
              {formatTime(hoverTime)}
            </div>
          )}

          {/* Track */}
          <div className={`hovod-track w-full bg-white/20 rounded-full relative overflow-hidden transition-all ${scrubbing ? 'h-1.5' : 'h-1 group-hover/progress:h-1.5'}`}>
            <div className="absolute inset-y-0 left-0 bg-white/15 rounded-full" style={{ width: `${bufferedPercent}%` }} />
            <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${progressPercent}%`, backgroundColor: accent }} />
          </div>

          {/* Hover indicator line */}
          {hoverProgress !== null && (
            <div className="absolute bottom-0 w-px h-1 group-hover/progress:h-1.5 bg-white/50 transition-all" style={{ left: `${hoverProgress}%` }} />
          )}

          {/* Comment marker dots with hover tooltips */}
          {commentMarkers && duration > 0 && commentMarkers.map((marker, i) => {
            const position = (marker.timestampSec / duration) * 100;
            return (
              <div
                key={i}
                className="absolute bottom-0 -translate-x-1/2 z-[12] group/marker"
                style={{ left: `${position}%` }}
              >
                <div
                  className="w-2.5 h-2.5 rounded-full ring-1 ring-black/40 opacity-90 hover:opacity-100 hover:scale-150 transition-all"
                  style={{ backgroundColor: accent }}
                />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover/marker:block pointer-events-none z-[50] min-w-[140px] max-w-[200px]">
                  <div className="bg-zinc-900/95 backdrop-blur border border-zinc-700/80 rounded-lg px-2.5 py-1.5 shadow-2xl text-left">
                    <p className="text-[11px] font-medium text-white truncate">{marker.authorName}</p>
                    <p className="text-[10px] text-zinc-400 mt-0.5 line-clamp-2">{marker.body}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom controls row */}
        <div className="flex items-center gap-3 px-3 pb-2.5 pt-1 text-white text-sm">
          <button onClick={togglePlay} className="hover:opacity-80 transition-opacity" aria-label={playing ? t.player.pause : t.player.play}>
            {playing ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>

          <button onClick={toggleMute} className="hover:opacity-80 transition-opacity" aria-label={muted ? t.player.unmute : t.player.mute}>
            {muted ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z" /><path d="M15.54 8.46a5 5 0 010 7.07" /><path d="M19.07 4.93a10 10 0 010 14.14" /></svg>
            )}
          </button>

          <span className="text-xs text-zinc-300 tabular-nums">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <div className="flex-1" />

          {/* Captions toggle */}
          {subtitlesUrl && (
            <button
              onClick={toggleCaptions}
              className={`hover:opacity-80 transition-opacity ${captionsOn ? '' : 'opacity-50'}`}
              aria-label={captionsOn ? t.player.disableSubtitles : t.player.enableSubtitles}
              aria-pressed={captionsOn}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M7 12h2m4 0h4M7 16h10" />
              </svg>
            </button>
          )}

          {/* Quality selector */}
          {levels.length > 1 && (
            <div className="relative" ref={qualityMenuRef}>
              <button
                onClick={() => setShowQualityMenu(!showQualityMenu)}
                className="flex items-center gap-1.5 text-xs hover:opacity-80 transition-opacity px-2 py-1 rounded"
                aria-label={t.player.videoQuality}
                aria-expanded={showQualityMenu}
                aria-haspopup="menu"
              >
                {pendingLevel !== null ? (
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-zinc-500 border-t-white animate-spin" aria-hidden="true" />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                  </svg>
                )}
                {qualityLabel}
              </button>
              {showQualityMenu && (
                <div role="menu" className="absolute bottom-full right-0 mb-2 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-lg overflow-hidden shadow-2xl min-w-[140px]">
                  <button
                    role="menuitemradio"
                    aria-checked={selectedLevel === -1}
                    onClick={() => switchQuality(-1)}
                    className={`w-full px-3 py-2.5 text-xs text-left hover:bg-zinc-800 flex items-center justify-between transition-colors ${selectedLevel === -1 ? '' : 'text-zinc-300'}`}
                    style={selectedLevel === -1 ? { color: accent } : undefined}
                  >
                    <span>{t.player.auto}</span>
                    {selectedLevel === -1 && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>}
                  </button>
                  {sortedLevels.map((l) => (
                    <button
                      key={l.index}
                      role="menuitemradio"
                      aria-checked={selectedLevel === l.index}
                      onClick={() => switchQuality(l.index)}
                      className={`w-full px-3 py-2.5 text-xs text-left hover:bg-zinc-800 flex items-center justify-between transition-colors ${selectedLevel === l.index ? '' : 'text-zinc-300'}`}
                      style={selectedLevel === l.index ? { color: accent } : undefined}
                    >
                      <span>{l.height}p</span>
                      {selectedLevel === l.index && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <button onClick={toggleFullscreen} className="hover:opacity-80 transition-opacity" aria-label={isFullscreen ? t.player.exitFullscreen : t.player.fullscreen}>
            {isFullscreen ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" /></svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
