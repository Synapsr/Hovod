import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AnalyticsPeriod, OverviewAnalytics } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatNumber, formatWatchTime } from '../lib/helpers.js';
import { useT } from '../lib/i18n/index.js';
import { StatCard } from '../components/analytics/StatCard.js';
import { ViewsChart } from '../components/analytics/ViewsChart.js';
import { PeakHoursChart } from '../components/analytics/PeakHoursChart.js';
import { DevicesChart } from '../components/analytics/DevicesChart.js';
import { PeriodSelector } from '../components/AssetAnalytics.js';

const Icons = {
  eye: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  users: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  clock: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  ),
  pulse: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  bars: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  assets: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
      <line x1="7" y1="2" x2="7" y2="22" />
      <line x1="17" y1="2" x2="17" y2="22" />
      <line x1="2" y1="12" x2="22" y2="12" />
    </svg>
  ),
  alert: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
};

export function AnalyticsPage() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d');
  const { t } = useT();

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['analytics', 'overview', period],
    queryFn: () => api<OverviewAnalytics>(`/v1/analytics/overview?period=${period}`),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  const s = data?.summary;
  const empty = !!data && s!.views === 0 && data.timeSeries.every((p) => p.views === 0);

  return (
    <>
      {/* Page header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-lg font-semibold text-zinc-50 flex items-center gap-2">
            {t.analytics.title}
            <span className="text-[10px] font-medium text-accent-400 bg-accent-500/10 border border-accent-500/20 px-2 py-0.5 rounded-full">
              {t.analytics.live}
            </span>
          </h1>
          <p className="text-sm text-zinc-500 mt-1">{t.analytics.subtitle}</p>
        </div>
        <PeriodSelector value={period} onChange={setPeriod} size="md" />
      </div>

      {isPending ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-zinc-900/60 border border-zinc-800/60 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : isError || !data ? (
        <div className="py-20 text-center">
          <p className="text-sm text-zinc-400">{t.analytics.loadError}</p>
          <button onClick={() => refetch()} className="mt-3 text-xs text-zinc-300 hover:text-zinc-100 underline">
            {t.analytics.retry}
          </button>
        </div>
      ) : empty ? (
        <div className="py-20 text-center">
          <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-600" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
          </div>
          <p className="text-sm text-zinc-400">{t.analytics.noData}</p>
          <p className="text-xs text-zinc-600 mt-1">{t.analytics.noDataHint}</p>
        </div>
      ) : (
        <>
          {/* Stat cards — every tile answers the selected period */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label={t.analytics.totalViews} value={formatNumber(s!.views)} icon={Icons.eye} hint={t.analytics.viewsTooltip} />
            <StatCard label={t.analytics.uniqueViewers} value={formatNumber(s!.uniqueViewers)} icon={Icons.users} hint={t.analytics.uniqueViewersTooltip} />
            <StatCard label={t.analytics.watchTime} value={formatWatchTime(s!.watchTimeSec)} icon={Icons.clock} hint={t.analytics.watchTimeTooltip} />
            <StatCard label={t.analytics.engagement} value={`${s!.engagementScore}`} subValue={t.analytics.outOf100} icon={Icons.pulse} hint={t.analytics.engagementTooltip} />
            <StatCard label={t.analytics.avgWatched} value={`${s!.avgWatchPercent}%`} icon={Icons.bars} />
            <StatCard label={t.analytics.completionRate} value={`${s!.completionRate}%`} icon={Icons.check} hint={t.analytics.completionTooltip} />
            <StatCard label={t.analytics.errors} value={formatNumber(s!.errorCount)} icon={Icons.alert} hint={t.analytics.errorsTooltip} />
            <StatCard label={t.analytics.assets} value={formatNumber(s!.totalAssets)} icon={Icons.assets} />
          </div>

          {/* Views chart */}
          <div className="mt-4 p-4 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
            <h3 className="text-xs font-medium text-zinc-400 mb-3">{t.analytics.viewsOverTime}</h3>
            <ViewsChart data={data.timeSeries} granularity={data.granularity} />
          </div>

          {/* Bottom row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            {/* Top assets */}
            <div className="p-4 bg-zinc-900/60 border border-zinc-800/60 rounded-xl md:col-span-1">
              <h3 className="text-xs font-medium text-zinc-400 mb-3">{t.analytics.topAssets}</h3>
              {data.topAssets.length === 0 ? (
                <div className="text-zinc-600 text-sm py-4 text-center">{t.analytics.noDataYet}</div>
              ) : (
                <div className="space-y-2">
                  {data.topAssets.map((asset, i) => (
                    <button
                      key={asset.assetId}
                      onClick={() => navigate(`/videos/${asset.assetId}`)}
                      className="w-full flex items-center gap-3 text-sm hover:bg-zinc-800/40 rounded-lg px-2 py-1.5 transition-colors"
                      title={`${formatNumber(asset.uniqueViewers)} ${t.analytics.viewers} · ${formatWatchTime(asset.watchTimeSec)} · ${asset.avgWatchPercent}% ${t.analytics.avgWatched.toLowerCase()}`}
                    >
                      <span className="w-5 h-5 flex items-center justify-center text-[10px] font-bold text-zinc-500 bg-zinc-800 rounded">
                        {i + 1}
                      </span>
                      <span className="flex-1 text-zinc-200 truncate text-xs text-left">
                        {asset.title}
                      </span>
                      <span className="text-zinc-500 text-xs tabular-nums">
                        {formatNumber(asset.views)} {t.analytics.views}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Peak hours */}
            <div className="p-4 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
              <h3 className="text-xs font-medium text-zinc-400 mb-3">
                {t.analytics.peakHoursUtc}
                {s!.peakHour !== null && (
                  <span className="ml-2 text-zinc-500 tabular-nums">· {t.analytics.peakHour} {String(s!.peakHour).padStart(2, '0')}:00</span>
                )}
              </h3>
              <PeakHoursChart data={data.peakHours} />
            </div>

            {/* Devices */}
            <div className="p-4 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
              <h3 className="text-xs font-medium text-zinc-400 mb-3">{t.analytics.devices}</h3>
              <DevicesChart data={data.devices} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
