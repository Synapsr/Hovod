import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';

const QUALITY_COLORS: Record<string, string> = {
  '360': '#f59e0b',
  '720': '#6366f1',
  '1080': '#22c55e',
};

interface Props {
  data: Record<string, number>;
}

export function QualityDonut({ data }: Props) {
  const entries = Object.entries(data)
    .map(([key, value]) => ({
      name: `${key}p`,
      value,
      color: QUALITY_COLORS[key] || '#71717a',
    }))
    .sort((a, b) => parseInt(a.name) - parseInt(b.name));

  if (entries.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-zinc-600 text-sm">
        No data yet
      </div>
    );
  }

  const total = entries.reduce((s, e) => s + e.value, 0);

  return (
    <div className="h-40 flex items-center gap-4">
      <div className="w-28 h-28 flex-shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={entries}
              cx="50%"
              cy="50%"
              innerRadius={30}
              outerRadius={50}
              dataKey="value"
              stroke="none"
              paddingAngle={2}
            >
              {entries.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: '#18181b',
                border: '1px solid #3f3f46',
                borderRadius: '8px',
                fontSize: '12px',
                color: '#fafafa',
              }}
              formatter={(value: any) => [
                `${Math.round((Number(value) / total) * 100)}%`,
                'Share',
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-col gap-2">
        {entries.map((entry) => (
          <div key={entry.name} className="flex items-center gap-2 text-xs">
            <div
              className="w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span className="text-zinc-400">{entry.name}</span>
            <span className="text-zinc-500">
              {Math.round((entry.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
