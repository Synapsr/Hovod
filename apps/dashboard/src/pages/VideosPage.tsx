import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Asset } from '../lib/types.js';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n/index.js';
import { AssetCard } from '../components/AssetCard.js';

/** Statuses that are still changing — the list only polls while one of these is present. */
const TRANSITIONAL = new Set(['created', 'uploaded', 'queued', 'processing']);
const POLL_INTERVAL = 5000;

export function VideosPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const { t } = useT();

  const { data: assets, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['assets'],
    queryFn: () => api<Asset[]>('/v1/assets'),
    // Poll only while something is still transcoding, and never in a hidden tab.
    refetchInterval: (query) =>
      query.state.data?.some((a) => TRANSITIONAL.has(a.status)) ? POLL_INTERVAL : false,
    refetchIntervalInBackground: false,
  });

  const filtered = useMemo(() => {
    const list = assets ?? [];
    if (!search) return list;
    const needle = search.toLowerCase();
    return list.filter((a) => a.title.toLowerCase().includes(needle));
  }, [assets, search]);

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
          {!isLoading && !isError && (
            <span className="text-xs font-medium text-zinc-500 bg-zinc-900 border border-zinc-800 px-2.5 py-0.5 rounded-full">
              {filtered.length}
            </span>
          )}
        </h2>
        <input
          type="text"
          placeholder={t.videos.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t.videos.searchAssets}
          disabled={isLoading || isError}
          className="h-9 w-56 px-3 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors disabled:opacity-50"
        />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-[188px] rounded-xl bg-zinc-900 border border-zinc-800 animate-pulse" />
          ))}
        </div>
      ) : isError ? (
        /* A failed request must never look like an empty library. */
        <div className="py-20 text-center" role="alert">
          <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <p className="text-sm text-zinc-300">{t.videos.failedLoadVideos}</p>
          <p className="text-xs text-zinc-600 mt-1">
            {error instanceof Error ? error.message : t.common.somethingWentWrong}
          </p>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="mt-4 h-9 px-4 text-sm font-medium rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-50"
          >
            {isFetching ? t.common.loading : t.common.retry}
          </button>
        </div>
      ) : filtered.length === 0 ? (
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
