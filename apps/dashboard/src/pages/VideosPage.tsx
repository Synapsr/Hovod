import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Asset } from '../lib/types.js';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n/index.js';
import { AssetCard } from '../components/AssetCard.js';

export function VideosPage() {
  const navigate = useNavigate();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [search, setSearch] = useState('');
  const { t } = useT();

  const refresh = useCallback(async () => {
    try {
      const list = await api<Asset[]>('/v1/assets');
      setAssets(list);
    } catch { /* ignore polling errors */ }
  }, []);

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 5000);
    return () => clearInterval(i);
  }, [refresh]);

  const filtered = search
    ? assets.filter((a) => a.title.toLowerCase().includes(search.toLowerCase()))
    : assets;

  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-lg font-semibold text-zinc-50">{t.videos.title}</h1>
          <p className="text-sm text-zinc-500 mt-1">{t.videos.subtitle}</p>
        </div>
        <button
          onClick={() => navigate('/videos/new')}
          className="flex items-center gap-2 h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t.videos.newVideo}
        </button>
      </div>

      {/* Assets header */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-base font-semibold flex items-center gap-2">
          {t.videos.assets}
          <span className="text-xs font-medium text-zinc-500 bg-zinc-900 border border-zinc-800 px-2.5 py-0.5 rounded-full">
            {filtered.length}
          </span>
        </h2>
        <input
          type="text"
          placeholder={t.videos.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t.videos.searchAssets}
          className="h-9 w-56 px-3 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors"
        />
      </div>

      {/* Asset grid */}
      {filtered.length === 0 ? (
        <div className="py-20 text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-600" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="4" y="6" width="16" height="12" rx="2" />
              <path d="M9 3v3M15 3v3M10 12l2-2 2 2" />
            </svg>
          </div>
          <p className="text-sm text-zinc-400">{t.videos.noVideos}</p>
          <p className="text-xs text-zinc-600 mt-1">{t.videos.noVideosHint}</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
          {filtered.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              onClick={() => navigate(`/videos/${asset.id}`)}
            />
          ))}
        </div>
      )}
    </>
  );
}
