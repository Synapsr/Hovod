import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import type { AnalyticsTimeSeries } from '../../lib/types.js';
import { useSettings } from '../../lib/settings-context.js';
import { useT } from '../../lib/i18n/index.js';

/**
 * Bucket labels: day buckets are `YYYY-MM-DD` (shown as a calendar day), hour
 * buckets are `YYYY-MM-DDTHH:00:00Z` (UTC — shown in the viewer's local time).
 */
function formatBucket(date: string, granularity: 'hour' | 'day', long = false): string {
  if (granularity === 'hour' || date.includes('T')) {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return date;
    return long
      ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit' });
  }
  const d = new Date(date + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function ViewsChart({
  data,
  granularity = 'day',
}: {
  data: AnalyticsTimeSeries[];
  granularity?: 'hour' | 'day';
}) {
  const { settings } = useSettings();
  const { t } = useT();
  const color = settings.primaryColor;

  if (data.length === 0 || data.every((d) => d.views === 0)) {
    return (
      <div className="h-52 flex items-center justify-center text-zinc-600 text-sm">
        {t.analytics.noDataYet}
      </div>
    );
  }

  // Hour buckets over 7 days = 168 points: thin the axis so labels stay legible.
  const tickInterval = granularity === 'hour' ? 23 : Math.max(0, Math.floor(data.length / 8) - 1);

  return (
    <div className="h-52">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="viewsGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#27272a"
            vertical={false}
          />
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => formatBucket(v, granularity)}
            stroke="#52525b"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            interval={tickInterval}
            minTickGap={24}
          />
          <YAxis
            stroke="#52525b"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#18181b',
              border: '1px solid #3f3f46',
              borderRadius: '8px',
              fontSize: '12px',
              color: '#fafafa',
            }}
            labelFormatter={(label: unknown) => formatBucket(String(label), granularity, true)}
            formatter={(value: unknown, name: unknown) => [
              Number(value).toLocaleString(),
              name === 'uniqueViewers' ? t.analytics.uniqueViewers : t.analytics.totalViews,
            ]}
          />
          <Area
            type="monotone"
            dataKey="views"
            stroke={color}
            strokeWidth={2}
            fill="url(#viewsGradient)"
          />
          <Area
            type="monotone"
            dataKey="uniqueViewers"
            stroke={color}
            strokeOpacity={0.45}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            fill="none"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
