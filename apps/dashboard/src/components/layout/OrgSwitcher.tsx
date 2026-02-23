import { useCallback, useEffect, useRef, useState } from 'react';
import type { Organization } from '../../lib/types.js';
import { api } from '../../lib/api.js';
import { getCurrentOrgId, setToken } from '../../lib/auth.js';
import { useSettings } from '../../lib/settings-context.js';
import { useT } from '../../lib/i18n/index.js';

const TIER_STYLE: Record<string, string> = {
  free: 'text-zinc-400 bg-zinc-800 border-zinc-700',
  pro: 'text-accent-400 bg-accent-500/10 border-accent-500/20',
  business: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
};

export function OrgSwitcher() {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [createError, setCreateError] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentOrgId = getCurrentOrgId();
  const { settings } = useSettings();
  const { t } = useT();

  const TIER_LABEL: Record<string, string> = {
    free: t.orgs.free,
    pro: t.orgs.pro,
    business: t.orgs.business,
  };

  const fetchOrgs = useCallback(async () => {
    try {
      const data = await api<Organization[]>('/v1/orgs');
      setOrgs(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchOrgs(); }, [fetchOrgs]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setNewOrgName('');
        setCreateError('');
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (creating && inputRef.current) inputRef.current.focus();
  }, [creating]);

  const currentOrg = orgs.find((o) => o.id === currentOrgId);
  const tierKey = currentOrg?.tier ?? 'free';
  const tierStyle = TIER_STYLE[tierKey] ?? TIER_STYLE.free!;
  const tierLabel = TIER_LABEL[tierKey] ?? TIER_LABEL.free!;

  const handleSwitch = async (orgId: string) => {
    if (orgId === currentOrgId || switching) return;
    setSwitching(true);
    try {
      const { token } = await api<{ token: string }>('/v1/auth/switch-org', {
        method: 'POST',
        body: JSON.stringify({ orgId }),
      });
      setToken(token);
      window.location.href = '/videos';
    } catch {
      setSwitching(false);
    }
  };

  const handleCreateOrg = async () => {
    const name = newOrgName.trim();
    if (!name || switching) return;
    setSwitching(true);
    setCreateError('');
    try {
      const { token } = await api<{ token: string }>('/v1/orgs', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      setToken(token);
      window.location.href = '/videos';
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : t.orgs.failedCreateOrg);
      setSwitching(false);
    }
  };

  if (!currentOrg) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen(!open); setCreating(false); setCreateError(''); }}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-900/50 hover:bg-zinc-800/50 transition-colors"
      >
        {/* Org avatar — logo if available, otherwise first letter */}
        {settings.logoUrl ? (
          <img src={settings.logoUrl} alt={currentOrg.name} className="w-8 h-8 rounded-lg object-contain shrink-0" />
        ) : (
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-600/20 to-accent-600/5 border border-accent-500/20 flex items-center justify-center shrink-0">
            <span className="text-xs font-bold text-accent-400 uppercase">
              {currentOrg.name.charAt(0)}
            </span>
          </div>
        )}
        <div className="min-w-0 flex-1 text-left">
          <div className="text-sm font-medium text-zinc-200 truncate">{currentOrg.name}</div>
          <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border ${tierStyle}`}>
            {tierLabel}
          </span>
        </div>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          className={`text-zinc-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-1.5 z-50 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl shadow-black/40 overflow-hidden">
          {/* Org list */}
          <div className="py-1.5">
            <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
              {t.orgs.organizations}
            </p>
            {orgs.map((org) => {
              const ts = TIER_STYLE[org.tier] ?? TIER_STYLE.free!;
              const tl = TIER_LABEL[org.tier] ?? TIER_LABEL.free!;
              const isActive = org.id === currentOrgId;
              return (
                <button
                  key={org.id}
                  onClick={() => { handleSwitch(org.id); setOpen(false); }}
                  disabled={switching}
                  className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors ${
                    isActive ? 'bg-zinc-800/60' : 'hover:bg-zinc-800/40'
                  } ${switching ? 'opacity-50' : ''}`}
                >
                  <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700/60 flex items-center justify-center shrink-0">
                    <span className="text-[10px] font-bold text-zinc-400 uppercase">{org.name.charAt(0)}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-200 truncate">{org.name}</div>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${ts}`}>
                      {tl}
                    </span>
                  </div>
                  {isActive && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-accent-400 shrink-0">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>

          {/* Separator */}
          <div className="border-t border-zinc-800" />

          {/* Create org */}
          <div className="p-2">
            {creating ? (
              <div className="space-y-2">
                <input
                  ref={inputRef}
                  type="text"
                  placeholder={t.orgs.orgName}
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreateOrg(); if (e.key === 'Escape') { setCreating(false); setNewOrgName(''); setCreateError(''); } }}
                  className="w-full h-8 px-2.5 text-sm bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors"
                  disabled={switching}
                />
                {createError && (
                  <p className="text-[11px] text-red-400 px-1">{createError}</p>
                )}
                <div className="flex gap-1.5">
                  <button
                    onClick={() => { setCreating(false); setNewOrgName(''); setCreateError(''); }}
                    className="flex-1 h-7 text-xs font-medium rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
                    disabled={switching}
                  >
                    {t.common.cancel}
                  </button>
                  <button
                    onClick={handleCreateOrg}
                    disabled={!newOrgName.trim() || switching}
                    className="flex-1 h-7 text-xs font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {switching ? t.common.creating : t.common.create}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40 transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                {t.orgs.createOrg}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
