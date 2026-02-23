import type { Asset } from '../lib/types.js';
import { timeAgo, formatDuration } from '../lib/helpers.js';
import { StatusBadge } from './StatusBadge.js';
import { useT } from '../lib/i18n/index.js';

export function AssetCard({ asset, onClick }: { asset: Asset; onClick: () => void }) {
  const { t } = useT();
  return (
    <div
      className="group bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden cursor-pointer transition-all hover:border-zinc-700 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20"
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`Open ${asset.title}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
      {/* Thumbnail area */}
      <div
        className={`relative h-32 flex items-center justify-center overflow-hidden
          ${asset.status === 'ready'      ? 'bg-gradient-to-br from-emerald-950/40 to-zinc-900' :
            asset.status === 'processing' ? 'bg-gradient-to-br from-blue-950/40 to-zinc-900' :
            asset.status === 'error'      ? 'bg-gradient-to-br from-red-950/40 to-zinc-900' :
            'bg-zinc-900/60'}`}
      >
        {asset.thumbnailUrl && (
          <img
            src={asset.thumbnailUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}
        {asset.status === 'ready' && (
          <div className="relative z-10 w-12 h-12 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center group-hover:bg-black/50 transition-colors">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" className="text-white ml-0.5">
              <path d="M4 2.5v13l11-6.5z" />
            </svg>
          </div>
        )}
        {asset.status === 'processing' && (
          <div className="relative z-10 w-10 h-10 rounded-full border-2 border-blue-500/30 border-t-blue-400 animate-spin" />
        )}
        {asset.status === 'error' && (
          <div className="relative z-10 w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center text-red-400 text-lg font-bold">!</div>
        )}
        {!['ready', 'processing', 'error'].includes(asset.status) && (
          <div className="relative z-10 w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center text-zinc-600" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="5" width="14" height="10" rx="2" />
              <path d="M9 3v3M13 3v3" />
            </svg>
          </div>
        )}
        {asset.thumbnailUrl && asset.durationSec != null && asset.durationSec > 0 && (
          <span className="absolute bottom-1.5 right-1.5 z-10 text-[11px] font-medium text-white bg-black/70 px-1.5 py-0.5 rounded">
            {formatDuration(asset.durationSec)}
          </span>
        )}
      </div>

      {/* Card body */}
      <div className="px-4 py-3">
        <p className="text-sm font-medium truncate mb-2" title={asset.title}>{asset.title}</p>
        <div className="flex items-center justify-between">
          <StatusBadge status={asset.status} />
          <div className="flex items-center gap-2">
            {!asset.thumbnailUrl && asset.durationSec != null && asset.durationSec > 0 && (
              <span className="text-[11px] text-zinc-500">{formatDuration(asset.durationSec)}</span>
            )}
            <span className="text-[11px] text-zinc-600">{timeAgo(asset.createdAt, t.time)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
