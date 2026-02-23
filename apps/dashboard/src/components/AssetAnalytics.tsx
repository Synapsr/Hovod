import { useCallback, useEffect, useState } from 'react';
import type { AssetAnalytics as AssetAnalyticsType } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatNumber, formatWatchTime } from '../lib/helpers.js';
import { StatCard } from './analytics/StatCard.js';
import { ViewsChart } from './analytics/ViewsChart.js';
import { RetentionChart } from './analytics/RetentionChart.js';
import { QualityDonut } from './analytics/QualityDonut.js';
import { useT } from '../lib/i18n/index.js';

const PERIODS = ['7d', '30d', '90d'] as const;

export function AssetAnalytics({ assetId }: { assetId: string }) {
  const { t } = useT();
  const [data, setData] = useState<AssetAnalyticsType | null>(null);
  const [period, setPeriod] = useState<string>('30d');
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const result = await api<AssetAnalyticsType>(
        `/v1/assets/${assetId}/analytics?period=${period}`,
      );
      setData(result);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [assetId, period]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const i = setInterval(fetchData, 60_000);
    return () => clearInterval(i);
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="mt-6">
        <div className="h-8 w-32 bg-zinc-800 rounded animate-pulse mb-4" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 bg-zinc-800/50 rounded-xl animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const lt = data.lifetime;

  return (
    <div className="mt-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{t.analytics.title}</h3>
        <div className="flex items-center bg-zinc-800/50 rounded-lg overflow-hidden">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                period === p
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatCard
          label={t.analytics.totalViews}
          value={formatNumber(lt.totalViews)}
          icon={
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          }
        />
        <StatCard
          label={t.analytics.watchTime}
          value={formatWatchTime(lt.totalWatchTimeSec)}
          icon={
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          }
        />
        <StatCard
          label={t.analytics.avgWatched}
          value={`${lt.avgWatchPercent}%`}
          icon={
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="20" x2="12" y2="10" />
              <line x1="18" y1="20" x2="18" y2="4" />
              <line x1="6" y1="20" x2="6" y2="16" />
            </svg>
          }
        />
        <StatCard
          label={t.analytics.engagement}
          value={`${lt.engagementScore}`}
          subValue={t.analytics.outOf100}
          icon={
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          }
        />
      </div>

      {/* Views chart */}
      <div className="mt-3 p-3.5 bg-zinc-800/40 rounded-xl">
        <h4 className="text-[11px] font-medium text-zinc-500 mb-2">
          {t.analytics.viewsOverTime}
        </h4>
        <ViewsChart data={data.timeSeries} />
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <div className="p-3.5 bg-zinc-800/40 rounded-xl">
          <h4 className="text-[11px] font-medium text-zinc-500 mb-2">
            {t.analytics.viewerRetention}
          </h4>
          <RetentionChart data={lt.retentionCurve} />
        </div>
        <div className="p-3.5 bg-zinc-800/40 rounded-xl">
          <h4 className="text-[11px] font-medium text-zinc-500 mb-2">
            {t.analytics.qualityDistribution}
          </h4>
          <QualityDonut data={lt.qualityDistribution} />
        </div>
      </div>
    </div>
  );
}
