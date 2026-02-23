import { useT } from '../lib/i18n/index.js';

interface CopyFieldProps {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}

export function CopyField({ label, value, copied, onCopy }: CopyFieldProps) {
  const { t } = useT();
  return (
    <div>
      <label className="text-xs text-zinc-500 mb-1.5 block">{label}</label>
      <div
        className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-zinc-800/50 border border-zinc-700/50 cursor-pointer hover:border-zinc-600 transition-colors group"
        onClick={onCopy}
      >
        <span className="flex-1 min-w-0 text-sm font-mono text-zinc-300 truncate">
          {value}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onCopy(); }}
          className={`shrink-0 h-7 px-3 text-xs font-medium rounded-md transition-colors ${
            copied
              ? 'bg-emerald-500/20 text-emerald-400'
              : 'bg-zinc-700/60 text-zinc-300 hover:bg-zinc-600/60'
          }`}
        >
          {copied ? t.common.copied : t.common.copy}
        </button>
      </div>
    </div>
  );
}
