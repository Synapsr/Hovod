import { useSettings } from '../../lib/settings-context.js';
import { useT } from '../../lib/i18n/index.js';

const ORDER = ['desktop', 'mobile', 'tablet', 'unknown'] as const;

/** Views per device type (desktop / mobile / tablet), as horizontal bars. */
export function DevicesChart({ data }: { data: Record<string, number> }) {
  const { settings } = useSettings();
  const { t } = useT();
  const color = settings.primaryColor;

  const labels: Record<string, string> = {
    desktop: t.analytics.deviceDesktop,
    mobile: t.analytics.deviceMobile,
    tablet: t.analytics.deviceTablet,
    unknown: t.analytics.deviceUnknown,
  };

  const entries = Object.entries(data)
    .filter(([, v]) => v > 0)
    .sort((a, b) => {
      const ia = ORDER.indexOf(a[0] as (typeof ORDER)[number]);
      const ib = ORDER.indexOf(b[0] as (typeof ORDER)[number]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  const total = entries.reduce((s, [, v]) => s + v, 0);

  if (total === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">
        {t.analytics.noDataYet}
      </div>
    );
  }

  return (
    <div className="h-40 flex flex-col justify-center gap-3">
      {entries.map(([key, value]) => {
        const pctValue = Math.round((value / total) * 100);
        return (
          <div key={key} className="text-xs">
            <div className="flex items-center justify-between mb-1">
              <span className="text-zinc-400">{labels[key] ?? key}</span>
              <span className="text-zinc-500 tabular-nums">
                {value.toLocaleString()} · {pctValue}%
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{ width: `${pctValue}%`, backgroundColor: color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
