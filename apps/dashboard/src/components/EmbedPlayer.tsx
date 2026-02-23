import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Player } from './Player.js';
import { useT } from '../lib/i18n/index.js';

const PLAYBACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function EmbedPlayer() {
  const { t } = useT();
  const { playbackId = '' } = useParams<{ playbackId: string }>();
  const [searchParams] = useSearchParams();

  const [manifestUrl, setManifestUrl] = useState('');
  const [thumbnailVttUrl, setThumbnailVttUrl] = useState('');
  const [posterUrl, setPosterUrl] = useState<string | undefined>(undefined);
  const [assetId, setAssetId] = useState('');
  const [error, setError] = useState('');
  const [themeBg, setThemeBg] = useState('bg-black');
  const [settingsColor, setSettingsColor] = useState<string | undefined>(undefined);

  const safePlaybackId = PLAYBACK_ID_RE.test(playbackId) ? playbackId : '';

  const rawColor = searchParams.get('color') || undefined;
  const queryAccentColor = rawColor && HEX_COLOR_RE.test(rawColor) ? rawColor : undefined;
  const rawTitle = searchParams.get('title') || undefined;
  const title = rawTitle ? rawTitle.slice(0, 200) : undefined;

  // Query param color takes priority over org settings color
  const accentColor = queryAccentColor || settingsColor;

  useEffect(() => {
    if (!safePlaybackId) return;
    api<{ assetId: string; manifestUrl: string; thumbnailVttUrl: string; thumbnailUrl?: string | null; settings?: { primaryColor: string; theme: string; logoUrl: string | null } }>(`/v1/playback/${safePlaybackId}`)
      .then((d) => {
        setManifestUrl(d.manifestUrl);
        setThumbnailVttUrl(d.thumbnailVttUrl);
        if (d.thumbnailUrl) setPosterUrl(d.thumbnailUrl);
        setAssetId(d.assetId);
        if (d.settings) {
          if (d.settings.theme === 'light') setThemeBg('bg-white');
          setSettingsColor(d.settings.primaryColor);
        }
      })
      .catch(() => setError(t.embed.notFound));
  }, [safePlaybackId, t.embed.notFound]);

  if (error) {
    return (
      <div className={`h-screen flex items-center justify-center ${themeBg}`}>
        <div className="text-center">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-500 mx-auto mb-3">
            <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" />
          </svg>
          <p className="text-sm text-zinc-400">{error}</p>
        </div>
      </div>
    );
  }

  if (!manifestUrl) {
    return (
      <div className={`h-screen flex items-center justify-center ${themeBg} text-zinc-600 text-sm`}>
        <div className="w-5 h-5 rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin mr-2" />
        {t.embed.loadingPlayer}
      </div>
    );
  }

  return (
    <div className={`h-screen flex items-center justify-center ${themeBg}`}>
      <div className="w-full max-h-screen">
        <Player
          url={manifestUrl}
          thumbnailVttUrl={thumbnailVttUrl}
          poster={posterUrl}
          accentColor={accentColor}
          title={title}
          assetId={assetId}
          playbackId={playbackId}
          playerType="embed"
        />
      </div>
    </div>
  );
}
