import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OverviewAnalytics } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatNumber, formatWatchTime } from '../lib/helpers.js';
import { useT } from '../lib/i18n/index.js';
import { StatCard } from '../components/analytics/StatCard.js';
import { ViewsChart } from '../components/analytics/ViewsChart.js';
import { PeakHoursChart } from '../components/analytics/PeakHoursChart.js';

const PERIODS = ['7d', '30d', '90d'] as const;

export function AnalyticsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<OverviewAnalytics | null>(null);
  const [period, setPeriod] = useState<string>('30d');
  const [loading, setLoading] = useState(true);
  const { t } = useT();

  const fetchData = useCallback(async () => {
    try {
      const result = await api<OverviewAnalytics>(
        `/v1/analytics/overview?period=${period}`,
      );
      setData(result);
    } catch { /* ignore polling errors */ }
    finally { setLoading(false); }
  }, [period]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const i = setInterval(fetchData, 60_000);
    return () => clearInterval(i);
  }, [fetchData]);

  const s = data?.summary;

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
        <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                period === p
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-zinc-900/60 border border-zinc-800/60 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : !data || (data.summary.totalViews === 0 && data.timeSeries.length === 0) ? (
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
          {/* Stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
              label={t.analytics.totalViews}
              value={formatNumber(s!.totalViews)}
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              }
            />
            <StatCard
              label={t.analytics.watchTime}
              value={formatWatchTime(s!.totalWatchTimeSec)}
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              }
            />
            <StatCard
              label={t.analytics.assets}
              value={formatNumber(s!.totalAssets)}
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
                  <line x1="7" y1="2" x2="7" y2="22" />
                  <line x1="17" y1="2" x2="17" y2="22" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                </svg>
              }
            />
            <StatCard
              label={t.analytics.engagement}
              value={`${s!.avgEngagementScore}`}
              subValue={t.analytics.outOf100}
              icon={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                </svg>
              }
            />
          </div>

          {/* Views chart */}
          <div className="mt-4 p-4 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
            <h3 className="text-xs font-medium text-zinc-400 mb-3">{t.analytics.viewsOverTime}</h3>
            <ViewsChart data={data.timeSeries} />
          </div>

          {/* Bottom row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            {/* Top assets */}
            <div className="p-4 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
              <h3 className="text-xs font-medium text-zinc-400 mb-3">{t.analytics.topAssets}</h3>
              {data.topAssets.length === 0 ? (
                <div className="text-zinc-600 text-sm py-4 text-center">{t.analytics.noDataYet}</div>
              ) : (
                <div className="space-y-2">
                  {data.topAssets.slice(0, 5).map((asset, i) => (
                    <button
                      key={asset.assetId}
                      onClick={() => navigate(`/videos/${asset.assetId}`)}
                      className="w-full flex items-center gap-3 text-sm hover:bg-zinc-800/40 rounded-lg px-2 py-1.5 transition-colors"
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
              <h3 className="text-xs font-medium text-zinc-400 mb-3">{t.analytics.peakHours}</h3>
              <PeakHoursChart data={data.peakHours} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
