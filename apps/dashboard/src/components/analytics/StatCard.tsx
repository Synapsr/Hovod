import type { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  subValue,
  icon,
}: {
  label: string;
  value: string;
  subValue?: string;
  icon: ReactNode;
}) {
  return (
    <div className="p-4 bg-zinc-900/60 border border-zinc-800/60 rounded-xl backdrop-blur-sm">
      <div className="flex items-center gap-2 text-zinc-500 text-[11px] font-medium uppercase tracking-wider mb-2.5">
        <span className="text-zinc-600">{icon}</span>
        {label}
      </div>
      <div className="text-2xl font-semibold text-zinc-50 tabular-nums tracking-tight">
        {value}
      </div>
      {subValue && (
        <div className="text-[11px] text-zinc-500 mt-1">{subValue}</div>
      )}
    </div>
  );
}
