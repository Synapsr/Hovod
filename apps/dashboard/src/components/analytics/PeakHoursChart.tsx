import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import type { AnalyticsHourly } from '../../lib/types.js';
import { useSettings } from '../../lib/settings-context.js';
import { useT } from '../../lib/i18n/index.js';

// Fill missing hours with 0
function fillHours(data: AnalyticsHourly[]): AnalyticsHourly[] {
  const map = new Map(data.map((d) => [d.hour, d.views]));
  return Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    views: map.get(i) ?? 0,
  }));
}

/** Views per UTC hour of the day (the API always returns the 24 buckets). */
export function PeakHoursChart({ data }: { data: AnalyticsHourly[] }) {
  const { settings } = useSettings();
  const { t } = useT();
  const color = settings.primaryColor;
  const filled = fillHours(data);

  if (data.length === 0 || data.every((d) => d.views === 0)) {
    return (
      <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">
        {t.analytics.noDataYet}
      </div>
    );
  }

  return (
    <div className="h-40">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={filled} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#27272a"
            vertical={false}
          />
          <XAxis
            dataKey="hour"
            stroke="#52525b"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            tickFormatter={(h: number) => `${h}h`}
            interval={2}
          />
          <YAxis
            stroke="#52525b"
            fontSize={10}
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
            labelFormatter={(label: unknown) => `${label}:00 – ${label}:59 UTC`}
            formatter={(value: unknown) => [Number(value).toLocaleString(), t.analytics.totalViews]}
          />
          <Bar
            dataKey="views"
            fill={color}
            radius={[3, 3, 0, 0]}
            maxBarSize={16}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
