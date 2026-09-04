import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { API_BASE } from '../lib/api.js';
import type { PlaybackData } from '../lib/types.js';
import { Player } from './Player.js';
import { useT } from '../lib/i18n/index.js';

const PLAYBACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_START_TIME = 60 * 60 * 24; // 24h

const THEME = {
  dark: { bg: '#000000', text: 'text-zinc-400', muted: 'text-zinc-600', spinner: 'border-zinc-700 border-t-zinc-400' },
  light: { bg: '#ffffff', text: 'text-zinc-600', muted: 'text-zinc-500', spinner: 'border-zinc-300 border-t-zinc-500' },
};

/**
 * Embed query parameters (documented in docs/api-reference.md → "Embed parameters"):
 *   autoplay=1  attempt to play immediately (falls back to muted when blocked)
 *   muted=1     start muted
 *   loop=1      loop playback
 *   cc=1        captions on by default
 *   t=<sec>     start position in seconds
 *   color=#hex  accent color
 *   title=...   title overlay
 *   owner=1     owner preview (dashboard iframe) — playback is not counted in analytics
 */
function readEmbedParams() {
  const search = new URLSearchParams(window.location.search);
  const flag = (k: string) => {
    const v = search.get(k);
    return v === '1' || v === 'true';
  };
  const rawColor = search.get('color') || undefined;
  const rawTitle = search.get('title') || undefined;
  const rawT = search.get('t');
  const startTime = rawT !== null ? Number(rawT) : NaN;

  return {
    autoplay: flag('autoplay'),
    muted: flag('muted'),
    loop: flag('loop'),
    cc: flag('cc'),
    owner: flag('owner'),
    startTime: Number.isFinite(startTime) && startTime > 0 ? Math.min(startTime, MAX_START_TIME) : undefined,
    color: rawColor && HEX_COLOR_RE.test(rawColor) ? rawColor : undefined,
    title: rawTitle ? rawTitle.slice(0, 200) : undefined,
  };
}

function readPlaybackId(): string {
  const match = window.location.pathname.match(/\/embed\/([^/?#]+)/);
  const id = match ? decodeURIComponent(match[1]) : '';
  return PLAYBACK_ID_RE.test(id) ? id : '';
}

/** Public playback lookup — plain fetch: no auth token, no dashboard client code in the embed bundle. */
async function fetchPlayback(playbackId: string): Promise<PlaybackData> {
  const res = await fetch(`${API_BASE}/v1/playback/${playbackId}`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const json = await res.json();
  return json.data as PlaybackData;
}

export function EmbedPlayer() {
  const { t } = useT();
  const playbackId = useMemo(readPlaybackId, []);
  const params = useMemo(readEmbedParams, []);

  const [data, setData] = useState<PlaybackData | null>(null);
  const [error, setError] = useState('');

  // The embed document must never scroll (html/body/#root rules live in player.css)
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.classList.add('hovod-embed');
    return () => html.classList.remove('hovod-embed');
  }, []);

  useEffect(() => {
    if (!playbackId) {
      setError(t.embed.notFound);
      return;
    }
    let cancelled = false;
    fetchPlayback(playbackId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setError(t.embed.notFound); });
    return () => { cancelled = true; };
  }, [playbackId, t.embed.notFound]);

  const theme = data?.settings?.theme === 'light' ? THEME.light : THEME.dark;
  // Query param color takes priority over org settings color
  const accentColor = params.color || data?.settings?.primaryColor;

  useEffect(() => {
    document.body.style.backgroundColor = theme.bg;
  }, [theme.bg]);

  if (error) {
    return (
      <div className="fixed inset-0 overflow-hidden flex items-center justify-center" style={{ backgroundColor: theme.bg }}>
        <div className="text-center px-4">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-500 mx-auto mb-3">
            <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" />
          </svg>
          <p className={`text-sm ${theme.text}`}>{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={`fixed inset-0 overflow-hidden flex items-center justify-center text-sm ${theme.muted}`} style={{ backgroundColor: theme.bg }}>
        <div className={`w-5 h-5 rounded-full border-2 animate-spin mr-2 ${theme.spinner}`} />
        {t.embed.loadingPlayer}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ backgroundColor: theme.bg }}>
      <Player
        url={data.manifestUrl}
        thumbnailVttUrl={data.thumbnailVttUrl}
        poster={data.thumbnailUrl ?? undefined}
        accentColor={accentColor}
        title={params.title}
        assetId={data.assetId}
        playbackId={playbackId}
        playerType="embed"
        owner={params.owner}
        subtitlesUrl={data.ai?.subtitlesUrl ?? undefined}
        fill
        backgroundColor={theme.bg}
        autoplay={params.autoplay}
        muted={params.muted}
        loop={params.loop}
        startTime={params.startTime}
        defaultCaptions={false}
        forceCaptions={params.cc}
      />
    </div>
  );
}
