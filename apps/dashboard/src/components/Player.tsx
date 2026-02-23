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
}

export function Player({ url, thumbnailVttUrl, poster, accentColor, title, assetId, playbackId, playerType, subtitlesUrl, externalVideoRef, commentMarkers, logoUrl }: PlayerProps) {
  const { t } = useT();
  const accent = accentColor || '#6366f1';
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  // Sync external ref with internal ref
  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    if (externalVideoRef) {
      (externalVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    }
  }, [externalVideoRef]);
  const hideTimerRef = useRef<number>(0);

  const [playing, setPlaying] = useState(false);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [levels, setLevels] = useState<{ height: number; bitrate: number; index: number }[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [autoLevelHeight, setAutoLevelHeight] = useState(0);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [thumbnails, setThumbnails] = useState<ThumbnailCue[]>([]);
  const [hoverProgress, setHoverProgress] = useState<number | null>(null);
  const [hoverTime, setHoverTime] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Initialize HLS
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !url) return;

    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = url;
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(url);
      hls.attachMedia(el);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const lvls = hls.levels.map((l, i) => ({ height: l.height, bitrate: l.bitrate, index: i }));
        setLevels(lvls);
        setCurrentLevel(-1);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        if (hls.autoLevelEnabled) {
          setAutoLevelHeight(hls.levels[data.level]?.height ?? 0);
        }
        if (!hls.autoLevelEnabled) {
          setCurrentLevel(data.level);
        }
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          setError('This video cannot be loaded');
        }
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }
  }, [url]);

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
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVolumeChange = () => setMuted(el.muted);

    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('durationchange', onDurationChange);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('volumechange', onVolumeChange);

    return () => {
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('durationchange', onDurationChange);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
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

  // Fullscreen events
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Adjust subtitle cue positioning to clear the controls overlay when visible
  const controlsVisible = showControls || !playing;
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    // Push subs up when controls overlay is visible and not in fullscreen
    const needsOffset = controlsVisible && !isFullscreen;

    const adjustCues = () => {
      for (let t = 0; t < el.textTracks.length; t++) {
        const track = el.textTracks[t];
        if (!track.cues) continue;
        for (let i = 0; i < track.cues.length; i++) {
          const cue = track.cues[i] as VTTCue;
          cue.line = needsOffset ? -4 : -1;
        }
      }
    };

    adjustCues();

    const onCueChange = () => adjustCues();
    const tracks: TextTrack[] = [];
    for (let t = 0; t < el.textTracks.length; t++) {
      const track = el.textTracks[t];
      track.addEventListener('cuechange', onCueChange);
      tracks.push(track);
    }

    const onAddTrack = (e: TrackEvent) => {
      if (e.track) {
        e.track.addEventListener('cuechange', onCueChange);
        tracks.push(e.track);
        setTimeout(adjustCues, 200);
      }
    };
    el.textTracks.addEventListener('addtrack', onAddTrack);

    return () => {
      for (const track of tracks) {
        track.removeEventListener('cuechange', onCueChange);
      }
      el.textTracks.removeEventListener('addtrack', onAddTrack);
    };
  }, [controlsVisible, isFullscreen]);

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

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    el.paused ? el.play() : el.pause();
  };

  const seek = (fraction: number) => {
    const el = videoRef.current;
    if (!el || !duration) return;
    el.currentTime = Math.max(0, Math.min(duration, fraction * duration));
  };

  const switchQuality = (level: number) => {
    const hls = hlsRef.current;
    if (hls) {
      hls.currentLevel = level;
      setCurrentLevel(level);
    }
    setShowQualityMenu(false);
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    document.fullscreenElement ? document.exitFullscreen() : container.requestFullscreen();
  };

  const toggleMute = () => {
    const el = videoRef.current;
    if (el) el.muted = !el.muted;
  };

  const toggleCaptions = () => {
    const el = videoRef.current;
    if (!el) return;
    const track = el.textTracks[0];
    if (track) {
      const next = track.mode === 'showing' ? 'hidden' : 'showing';
      track.mode = next;
      setCaptionsOn(next === 'showing');
    }
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (buffered / duration) * 100 : 0;

  const hoverThumbnail = hoverProgress !== null
    ? thumbnails.find(t => hoverTime >= t.start && hoverTime < t.end)
    : null;

  const sortedLevels = useMemo(
    () => [...levels].sort((a, b) => b.height - a.height),
    [levels],
  );

  const qualityLabel = currentLevel === -1
    ? `${t.player.auto}${autoLevelHeight ? ` (${autoLevelHeight}p)` : ''}`
    : `${levels.find(l => l.index === currentLevel)?.height ?? '?'}p`;

  return (
    <div
      ref={containerRef}
      className="relative bg-black select-none"
      role="region"
      aria-label={t.player.videoPlayer}
      onMouseMove={resetHideTimer}
    >
      <video
        ref={setVideoRef}
        className="w-full block"
        playsInline
        crossOrigin="anonymous"
        poster={poster}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
      >
        {subtitlesUrl && (
          <track kind="subtitles" src={subtitlesUrl} default={captionsOn} label={t.player.subtitles} />
        )}
      </video>

      {/* Title overlay */}
      {title && (
        <div
          className={`absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent px-4 py-3 transition-opacity duration-300 ${showControls || !playing ? 'opacity-100' : 'opacity-0'}`}
        >
          <span className="text-sm font-medium text-white/90 drop-shadow-sm">{title}</span>
        </div>
      )}

      {/* Big play button when paused */}
      {!playing && duration > 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z" /></svg>
          </div>
        </div>
      )}

      {/* Logo watermark — visible when paused, fades out on play */}
      {logoUrl && (
        <div
          className={`absolute top-4 right-4 transition-all duration-500 ease-out ${
            !playing ? 'opacity-80 scale-100 translate-y-0' : 'opacity-0 scale-90 -translate-y-2 pointer-events-none'
          }`}
        >
          <img src={logoUrl} alt="" className="h-7 max-w-[120px] object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]" />
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
          <div className="text-center px-4">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-500 mx-auto mb-3">
              <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" />
            </svg>
            <p className="text-sm text-zinc-300">{t.player.cannotLoad}</p>
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
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent pt-12 transition-opacity duration-300 ${showControls || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Progress bar */}
        <div
          className="group/progress relative h-6 flex items-end px-3 cursor-pointer"
          role="slider"
          aria-label={t.player.seek}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressPercent)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            setHoverProgress(fraction * 100);
            setHoverTime(fraction * duration);
          }}
          onMouseLeave={() => setHoverProgress(null)}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seek((e.clientX - rect.left) / rect.width);
          }}
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
          <div className="w-full h-1 group-hover/progress:h-1.5 bg-white/20 rounded-full relative overflow-hidden transition-all">
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
            <button onClick={toggleCaptions} className={`hover:opacity-80 transition-opacity ${captionsOn ? '' : 'opacity-50'}`} aria-label={captionsOn ? t.player.disableSubtitles : t.player.enableSubtitles}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="M7 12h2m4 0h4M7 16h10" />
              </svg>
            </button>
          )}

          {/* Quality selector */}
          {levels.length > 1 && (
            <div className="relative">
              <button
                onClick={() => setShowQualityMenu(!showQualityMenu)}
                className="flex items-center gap-1.5 text-xs hover:opacity-80 transition-opacity px-2 py-1 rounded"
                aria-label={t.player.videoQuality}
                aria-expanded={showQualityMenu}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
                {qualityLabel}
              </button>
              {showQualityMenu && (
                <div className="absolute bottom-full right-0 mb-2 bg-zinc-900/95 backdrop-blur border border-zinc-700 rounded-lg overflow-hidden shadow-2xl min-w-[140px]">
                  <button
                    onClick={() => switchQuality(-1)}
                    className={`w-full px-3 py-2.5 text-xs text-left hover:bg-zinc-800 flex items-center justify-between transition-colors ${currentLevel === -1 ? '' : 'text-zinc-300'}`}
                    style={currentLevel === -1 ? { color: accent } : undefined}
                  >
                    <span>{t.player.auto}</span>
                    {currentLevel === -1 && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>}
                  </button>
                  {sortedLevels.map((l) => (
                    <button
                      key={l.index}
                      onClick={() => switchQuality(l.index)}
                      className={`w-full px-3 py-2.5 text-xs text-left hover:bg-zinc-800 flex items-center justify-between transition-colors ${currentLevel === l.index ? '' : 'text-zinc-300'}`}
                      style={currentLevel === l.index ? { color: accent } : undefined}
                    >
                      <span>{l.height}p</span>
                      {currentLevel === l.index && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>}
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
