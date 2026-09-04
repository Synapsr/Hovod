import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Organization } from '../../lib/types.js';
import { api } from '../../lib/api.js';
import { getCurrentOrgId, setToken } from '../../lib/auth.js';
import { useSettings } from '../../lib/settings-context.js';
import { useT } from '../../lib/i18n/index.js';
import { useSubscription } from '../SubscriptionGate.js';
import type { PlanId } from '../../lib/types.js';

const PLAN_STYLE: Record<PlanId, string> = {
  pro: 'text-accent-400 bg-accent-500/10 border-accent-500/20',
  business: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
};

/**
 * Plan chip — cloud only. A self-hosted install has no plan and no billing, so it
 * must not grow a badge that hints at one.
 */
function PlanChip({ plan, className = '' }: { plan: PlanId | null | undefined; className?: string }) {
  const { t } = useT();
  if (!plan) return null;
  const label = plan === 'business' ? t.plans.business : t.plans.pro;
  return (
    <span className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded border ${PLAN_STYLE[plan]} ${className}`}>
      {label}
    </span>
  );
}

/** Last known org name, so the switcher still has something to show when /v1/orgs fails. */
const ORG_NAME_KEY = 'hovod_last_org';

function readCachedOrgName(orgId: string): string | null {
  try {
    const raw = localStorage.getItem(ORG_NAME_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id: string; name: string };
    return parsed.id === orgId ? parsed.name : null;
  } catch {
    return null;
  }
}

function cacheOrgName(orgId: string, name: string): void {
  try {
    localStorage.setItem(ORG_NAME_KEY, JSON.stringify({ id: orgId, name }));
  } catch { /* ignore */ }
}

export function OrgSwitcher() {
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
  const { cloud, me } = useSubscription();

  const { data: orgs, isError, refetch, isFetching } = useQuery({
    queryKey: ['orgs'],
    queryFn: () => api<Organization[]>('/v1/orgs'),
    enabled: !!currentOrgId,
  });

  const loadedOrg = orgs?.find((o) => o.id === currentOrgId);

  useEffect(() => {
    if (loadedOrg) cacheOrgName(loadedOrg.id, loadedOrg.name);
  }, [loadedOrg]);

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

  if (!currentOrgId) return null;

  /* The org list can fail — the switcher must not disappear with it.
     Fall back to the last known name plus the plan carried by /v1/auth/me. */
  const currentOrg: Pick<Organization, 'id' | 'name' | 'plan'> = loadedOrg ?? {
    id: currentOrgId,
    name: readCachedOrgName(currentOrgId) ?? t.orgs.organizations,
    plan: me?.org.plan ?? null,
  };

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

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen(!open); setCreating(false); setCreateError(''); }}
        aria-expanded={open}
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
          {cloud && <PlanChip plan={currentOrg.plan ?? me?.org.plan ?? null} />}
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
            {isError ? (
              <div className="px-3 py-2" role="alert">
                <p className="text-[11px] text-zinc-400 mb-2">{t.orgs.failedLoadOrgs}</p>
                <button
                  onClick={() => refetch()}
                  disabled={isFetching}
                  className="h-7 px-2.5 text-xs font-medium rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-50"
                >
                  {isFetching ? t.common.loading : t.common.retry}
                </button>
              </div>
            ) : (orgs ?? []).map((org) => {
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
                    {cloud && <PlanChip plan={org.plan} />}
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
                  aria-label={t.orgs.orgName}
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
