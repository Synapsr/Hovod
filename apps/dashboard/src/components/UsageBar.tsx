import { useT } from '../lib/i18n/index.js';

export function UsageBar({
  label,
  current,
  limit,
  unit,
}: {
  label: string;
  current: number;
  limit: number;
  unit: string;
}) {
  const { t } = useT();
  const isUnlimited = limit === -1;
  const percent = isUnlimited ? 0 : limit > 0 ? Math.min((current / limit) * 100, 100) : 0;
  const color =
    percent > 90 ? 'bg-red-500' : percent > 70 ? 'bg-amber-500' : 'bg-accent-500';

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm text-zinc-300">{label}</span>
        <span className="text-xs text-zinc-500 tabular-nums">
          {current.toLocaleString()} / {isUnlimited ? t.common.unlimited : limit.toLocaleString()}{' '}
          {unit}
        </span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        {!isUnlimited && (
          <div
            className={`h-full rounded-full transition-all duration-500 ${color}`}
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
    </div>
  );
}
