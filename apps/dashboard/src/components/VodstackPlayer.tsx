import { useEffect, useRef } from 'react';
import Hls from 'hls.js';
import {
  MediaPlayer,
  MediaProvider,
  Track,
  type MediaPlayerInstance,
} from '@vidstack/react';
import {
  defaultLayoutIcons,
  DefaultVideoLayout,
} from '@vidstack/react/player/layouts/default';
import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';

interface VodstackPlayerProps {
  url: string;
  title?: string;
  poster?: string;
  subtitlesUrl?: string;
  thumbnailVttUrl?: string;
  autoplay?: boolean;
  startTime?: number;
}

// Vidstack tabanlı alternatif oynatıcı.
// pirumar/vodstack `web/src/components/VideoPlayer.tsx` dosyasından uyarlandı
// (MIT lisanslı): HLS + progresif MP4, altyazı/chapter parçaları, küçük resim
// önizlemeli hazır arayüz. Vodstack backend'ine bağlı değildir — doğrudan
// verilen url ile çalışır, bu yüzden Hovod'un mevcut oynatıcısına drop-in
// alternatif olur.
export function VodstackPlayer({
  url,
  title,
  poster,
  subtitlesUrl,
  thumbnailVttUrl,
  autoplay = false,
  startTime,
}: VodstackPlayerProps) {
  const playerRef = useRef<MediaPlayerInstance>(null);
  const pendingSeek = useRef<number | null>(startTime ?? null);

  useEffect(() => {
    pendingSeek.current = startTime ?? null;
  }, [url, startTime]);

  const type = url.includes('.m3u8')
    ? ('application/x-mpegurl' as const)
    : ('video/mp4' as const);

  return (
    <div className="aspect-video overflow-hidden rounded-xl bg-black">
      <MediaPlayer
        ref={playerRef}
        className="h-full w-full"
        title={title}
        src={{ src: url, type }}
        poster={poster}
        crossOrigin
        playsInline
        autoPlay={autoplay}
        onCanPlay={() => {
          if (pendingSeek.current != null) {
            const p = playerRef.current;
            if (p) {
              p.currentTime = pendingSeek.current;
              p.play().catch(() => {});
            }
            pendingSeek.current = null;
          }
        }}
        onProviderChange={(provider: unknown) => {
          const hlsProvider = provider as {
            type?: string;
            library?: unknown;
          } | null;
          if (hlsProvider?.type === 'hls') {
            hlsProvider.library = Hls;
          }
        }}
      >
        <MediaProvider />
        {subtitlesUrl && (
          <Track
            kind="subtitles"
            src={subtitlesUrl}
            label="Türkçe"
            lang="tr"
            type="vtt"
            default
          />
        )}
        <DefaultVideoLayout
          thumbnails={thumbnailVttUrl}
          icons={defaultLayoutIcons}
        />
      </MediaPlayer>
    </div>
  );
}
