import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import type { AssetDetail, PlaybackPolicy } from '../lib/types.js';
import { useT } from '../lib/i18n/index.js';

/** States in which the worker may still write files — the API refuses a policy change then (409). */
const BUSY_STATUSES = new Set(['queued', 'processing']);

/**
 * Public / Private switch for one asset.
 *
 * Switching moves the playback files between the public `playback/` prefix and
 * the private `private/` prefix server-side, so it can take a few seconds on
 * long videos; every query that embeds a playback URL is refreshed afterwards.
 */
export function PlaybackAccessPanel({ asset }: { asset: AssetDetail }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const policy: PlaybackPolicy = asset.playbackPolicy ?? 'public';
  const busy = BUSY_STATUSES.has(asset.status);

  const mutation = useMutation({
    mutationFn: (next: PlaybackPolicy) =>
      api(`/v1/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify({ playbackPolicy: next }) }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['asset', asset.id] });
      queryClient.invalidateQueries({ queryKey: ['playback', asset.id] });
      queryClient.invalidateQueries({ queryKey: ['share-token', asset.id] });
      queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
  });

  const options: Array<{ value: PlaybackPolicy; label: string }> = [
    { value: 'public', label: t.playbackAccess.public },
    { value: 'signed', label: t.playbackAccess.private },
  ];

  return (
    <div className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4">{t.playbackAccess.title}</h3>
      <div className="inline-flex p-0.5 rounded-lg bg-zinc-800/80" role="radiogroup" aria-label={t.playbackAccess.title}>
        {options.map((option) => {
          const active = policy === option.value;
          return (
            <button
              key={option.value}
              role="radio"
              aria-checked={active}
              disabled={busy || mutation.isPending || active}
              onClick={() => mutation.mutate(option.value)}
              className={`h-7 px-3 text-xs font-medium rounded-md transition-colors disabled:cursor-default ${
                active ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200 disabled:opacity-50'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-zinc-500 mt-3 leading-relaxed">
        {mutation.isPending
          ? t.playbackAccess.switching
          : busy
            ? t.playbackAccess.busyHint
            : policy === 'signed' ? t.playbackAccess.privateHint : t.playbackAccess.publicHint}
      </p>
      {mutation.isError && (
        <p className="text-[11px] text-red-400 mt-2" role="alert">
          {t.playbackAccess.failed}{mutation.error instanceof Error && mutation.error.message ? ` — ${mutation.error.message}` : ''}
        </p>
      )}
    </div>
  );
}
