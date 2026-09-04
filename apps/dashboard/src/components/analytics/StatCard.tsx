import type { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  subValue,
  icon,
  hint,
}: {
  label: string;
  value: string;
  subValue?: string;
  icon: ReactNode;
  /** Definition shown as a tooltip (native `title`) next to the label. */
  hint?: string;
}) {
  return (
    <div className="p-4 bg-zinc-900/60 border border-zinc-800/60 rounded-xl backdrop-blur-sm" title={hint}>
      <div className="flex items-center gap-2 text-zinc-500 text-[11px] font-medium uppercase tracking-wider mb-2.5">
        <span className="text-zinc-600">{icon}</span>
        <span className="truncate">{label}</span>
        {hint && (
          <span className="ml-auto text-zinc-600 cursor-help" aria-label={hint}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </span>
        )}
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
