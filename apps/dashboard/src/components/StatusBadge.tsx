import { STATUS_CFG } from '../lib/helpers.js';
import { useT } from '../lib/i18n/index.js';

export function StatusBadge({ status }: { status: string }) {
  const { t } = useT();
  const c = STATUS_CFG[status] ?? STATUS_CFG.created;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${c.bg} ${c.text}`}>
      <span
        className={`w-1.5 h-1.5 rounded-full ${c.dot} ${status === 'processing' ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      {t.status[status as keyof typeof t.status] || status}
    </span>
  );
}
