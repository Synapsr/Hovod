import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AnalyticsPeriod, AssetAnalytics as AssetAnalyticsType } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatNumber, formatWatchTime } from '../lib/helpers.js';
import { StatCard } from './analytics/StatCard.js';
import { ViewsChart } from './analytics/ViewsChart.js';
import { RetentionChart } from './analytics/RetentionChart.js';
import { QualityDonut } from './analytics/QualityDonut.js';
import { PeakHoursChart } from './analytics/PeakHoursChart.js';
import { DevicesChart } from './analytics/DevicesChart.js';
import { useT } from '../lib/i18n/index.js';

const PERIODS: AnalyticsPeriod[] = ['7d', '30d', '90d', 'all'];

const Icons = {
  eye: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  users: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  clock: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  bars: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  ),
  check: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  pulse: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  buffer: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  ),
  alert: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
};

/** Period selector shared by the asset and the overview pages (every tile follows it). */
export function PeriodSelector({
  value,
  onChange,
  size = 'sm',
}: {
  value: AnalyticsPeriod;
  onChange: (p: AnalyticsPeriod) => void;
  size?: 'sm' | 'md';
}) {
  const { t } = useT();
  const cls = size === 'sm'
    ? 'px-2.5 py-1 text-[11px]'
    : 'px-3 py-1.5 text-xs';
  const wrap = size === 'sm'
    ? 'bg-zinc-800/50'
    : 'bg-zinc-900 border border-zinc-800';
  const active = size === 'sm' ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-800 text-zinc-100';
  return (
    <div className={`flex items-center ${wrap} rounded-lg overflow-hidden`} role="tablist">
      {PERIODS.map((p) => (
        <button
          key={p}
          role="tab"
          aria-selected={value === p}
          onClick={() => onChange(p)}
          className={`${cls} font-medium transition-colors ${
            value === p ? active : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {p === 'all' ? t.analytics.allTime : p}
        </button>
      ))}
    </div>
  );
}

export function AssetAnalytics({ assetId }: { assetId: string }) {
  const { t } = useT();
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d');

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['analytics', 'asset', assetId, period],
    queryFn: () => api<AssetAnalyticsType>(`/v1/assets/${assetId}/analytics?period=${period}`),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  if (isPending) {
    return (
      <div className="mt-6">
        <div className="h-8 w-32 bg-zinc-800 rounded animate-pulse mb-4" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-20 bg-zinc-800/50 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="mt-6 p-4 bg-zinc-800/40 rounded-xl flex items-center justify-between gap-3">
        <span className="text-sm text-zinc-400">{t.analytics.loadError}</span>
        <button onClick={() => refetch()} className="text-xs text-zinc-300 hover:text-zinc-100 underline">
          {t.analytics.retry}
        </button>
      </div>
    );
  }

  const s = data.summary;

  return (
    <div className="mt-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{t.analytics.title}</h3>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatCard label={t.analytics.totalViews} value={formatNumber(s.views)} icon={Icons.eye} hint={t.analytics.viewsTooltip} />
        <StatCard label={t.analytics.uniqueViewers} value={formatNumber(s.uniqueViewers)} icon={Icons.users} hint={t.analytics.uniqueViewersTooltip} />
        <StatCard label={t.analytics.watchTime} value={formatWatchTime(s.watchTimeSec)} icon={Icons.clock} hint={t.analytics.watchTimeTooltip} />
        <StatCard label={t.analytics.avgWatched} value={`${s.avgWatchPercent}%`} icon={Icons.bars} />
        <StatCard label={t.analytics.completionRate} value={`${s.completionRate}%`} icon={Icons.check} hint={t.analytics.completionTooltip} />
        <StatCard label={t.analytics.engagement} value={`${s.engagementScore}`} subValue={t.analytics.outOf100} icon={Icons.pulse} hint={t.analytics.engagementTooltip} />
        <StatCard label={t.analytics.buffering} value={`${s.bufferRatio}%`} subValue={`${formatNumber(s.bufferCount)}×`} icon={Icons.buffer} hint={t.analytics.bufferingTooltip} />
        <StatCard label={t.analytics.errors} value={formatNumber(s.errorCount)} subValue={s.errorSessions > 0 ? `${formatNumber(s.errorSessions)} ${t.analytics.views}` : undefined} icon={Icons.alert} hint={t.analytics.errorsTooltip} />
      </div>

      {/* Views chart */}
      <div className="mt-3 p-3.5 bg-zinc-800/40 rounded-xl">
        <h4 className="text-[11px] font-medium text-zinc-500 mb-2">
          {t.analytics.viewsOverTime}
        </h4>
        <ViewsChart data={data.timeSeries} granularity={data.granularity} />
      </div>

      {/* Retention + quality */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <div className="p-3.5 bg-zinc-800/40 rounded-xl">
          <h4 className="text-[11px] font-medium text-zinc-500 mb-2">
            {t.analytics.viewerRetention}
          </h4>
          <RetentionChart data={data.retentionCurve} />
        </div>
        <div className="p-3.5 bg-zinc-800/40 rounded-xl">
          <h4 className="text-[11px] font-medium text-zinc-500 mb-2">
            {t.analytics.qualityDistribution}
          </h4>
          <QualityDonut data={data.qualityDistribution} />
        </div>
      </div>

      {/* Devices + peak hours + referrers */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
        <div className="p-3.5 bg-zinc-800/40 rounded-xl">
          <h4 className="text-[11px] font-medium text-zinc-500 mb-2">{t.analytics.devices}</h4>
          <DevicesChart data={data.devices} />
        </div>
        <div className="p-3.5 bg-zinc-800/40 rounded-xl">
          <h4 className="text-[11px] font-medium text-zinc-500 mb-2">
            {t.analytics.peakHoursUtc}
            {s.peakHour !== null && (
              <span className="ml-2 text-zinc-400 tabular-nums">· {t.analytics.peakHour} {String(s.peakHour).padStart(2, '0')}:00</span>
            )}
          </h4>
          <PeakHoursChart data={data.peakHours} />
        </div>
        <div className="p-3.5 bg-zinc-800/40 rounded-xl">
          <h4 className="text-[11px] font-medium text-zinc-500 mb-2">{t.analytics.topReferrers}</h4>
          {data.topReferrers.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">{t.analytics.noDataYet}</div>
          ) : (
            <ul className="space-y-1.5">
              {data.topReferrers.map((r) => (
                <li key={r.referrer} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 min-w-0 truncate text-zinc-300" title={r.referrer}>
                    {r.referrer === '(direct)' ? t.analytics.direct : r.referrer}
                  </span>
                  <span className="text-zinc-500 tabular-nums">
                    {formatNumber(r.views)} {t.analytics.views}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
