import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { getUser } from '../lib/auth.js';
import { timeAgo } from '../lib/helpers.js';
import { useT } from '../lib/i18n/index.js';

/* ─── Types ──────────────────────────────────────────────── */

interface ApiKeyData {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

interface OrgInfo {
  tier: string;
  limits: { apiKeys: number };
}

/* ─── Page ───────────────────────────────────────────────── */

export function ApiKeysPage() {
  const { t } = useT();
  const orgId = getUser()?.org;

  const [keys, setKeys] = useState<ApiKeyData[]>([]);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);

  // Revealed key
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState('');

  // Revoke confirmation
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const fetchData = useCallback(async () => {
    if (!orgId) return;
    try {
      const [orgData, keysData, meData] = await Promise.all([
        api<OrgInfo>(`/v1/orgs/${orgId}`),
        api<ApiKeyData[]>(`/v1/orgs/${orgId}/api-keys`),
        api<{ billingEnabled: boolean }>('/v1/auth/me'),
      ]);
      setOrg(orgData);
      setKeys(keysData);
      setBillingEnabled(meData.billingEnabled);
    } catch {
      setError(t.apiKeys.failedLoad);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleCopy = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(''), 2000);
  }, []);

  const createKey = async () => {
    if (!orgId || !newKeyName.trim()) return;
    setCreating(true);
    setError('');
    try {
      const data = await api<{ key: string }>(
        `/v1/orgs/${orgId}/api-keys`,
        { method: 'POST', body: JSON.stringify({ name: newKeyName.trim() }) },
      );
      setRevealedKey(data.key);
      setNewKeyName('');
      setShowCreate(false);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.apiKeys.failedCreate);
    } finally {
      setCreating(false);
    }
  };

  const revokeKey = async (keyId: string) => {
    if (!orgId) return;
    setRevoking(true);
    setError('');
    try {
      await api(`/v1/orgs/${orgId}/api-keys/${keyId}`, { method: 'DELETE' });
      setRevokeTarget(null);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.apiKeys.failedRevoke);
    } finally {
      setRevoking(false);
    }
  };

  /* Loading skeleton */
  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <div className="h-6 w-32 bg-zinc-800 rounded animate-pulse" />
            <div className="h-4 w-64 bg-zinc-800/60 rounded animate-pulse mt-2" />
          </div>
          <div className="h-9 w-28 bg-zinc-800 rounded-lg animate-pulse" />
        </div>
        <div className="h-3 w-40 bg-zinc-800/40 rounded animate-pulse mb-6" />
        <div className="bg-zinc-900/60 border border-zinc-800/60 rounded-xl overflow-hidden">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 border-b border-zinc-800/20 last:border-b-0 animate-pulse bg-zinc-900/30" />
          ))}
        </div>
      </div>
    );
  }

  const limit = org?.limits.apiKeys ?? 1;
  const atLimit = keys.length >= limit;

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-zinc-50">{t.apiKeys.title}</h1>
          <p className="text-sm text-zinc-500 mt-1">{t.apiKeys.subtitle}</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          disabled={atLimit}
          className="h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          title={atLimit ? t.apiKeys.keyLimitReached : undefined}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {t.apiKeys.createKey}
        </button>
      </div>

      {/* Limit bar — only shown when billing is enabled */}
      {billingEnabled && (
        <div className="flex items-center gap-3 mb-6">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
            </svg>
            <span>{t.apiKeys.keysUsed.replace('{count}', String(keys.length)).replace('{limit}', String(limit))}</span>
            <span className="text-zinc-700">&middot;</span>
            <span className="text-zinc-600">{(org?.tier ?? 'free').charAt(0).toUpperCase() + (org?.tier ?? 'free').slice(1)} plan</span>
          </div>
          <div className="flex-1 h-1 bg-zinc-800 rounded-full max-w-32">
            <div
              className={`h-1 rounded-full transition-all ${atLimit ? 'bg-amber-500' : 'bg-accent-500'}`}
              style={{ width: `${Math.min((keys.length / limit) * 100, 100)}%` }}
            />
          </div>
          {org?.tier !== 'business' && (
            <Link to="/settings" className="text-xs text-accent-400 hover:text-accent-500 transition-colors">
              {t.common.upgrade}
            </Link>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center justify-between text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-6">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-400 ml-3">{t.common.dismiss}</button>
        </div>
      )}

      {/* Revealed key */}
      {revealedKey && (
        <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl mb-6">
          <div className="flex items-center gap-2 mb-1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span className="text-sm font-medium text-emerald-400">{t.apiKeys.keyCreated}</span>
          </div>
          <p className="text-xs text-emerald-400/70 mb-3">{t.apiKeys.keyCreatedHint}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-emerald-300 bg-emerald-950/50 px-3 py-2 rounded-lg font-mono truncate select-all">
              {revealedKey}
            </code>
            <button
              onClick={() => handleCopy(revealedKey, 'newKey')}
              className="shrink-0 h-8 px-3 text-xs font-medium rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors flex items-center gap-1.5"
            >
              {copiedField === 'newKey' ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                  {t.common.copied}
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  {t.common.copy}
                </>
              )}
            </button>
          </div>
          <button onClick={() => setRevealedKey(null)} className="text-xs text-zinc-500 hover:text-zinc-400 mt-3 transition-colors">
            {t.common.dismiss}
          </button>
        </div>
      )}

      {/* Keys table / empty state */}
      {keys.length > 0 ? (
        <>
          {/* Desktop table */}
          <div className="hidden sm:block bg-zinc-900/60 border border-zinc-800/60 rounded-xl overflow-hidden">
            <div className="grid grid-cols-[1fr_140px_100px_100px_64px] px-5 py-3 border-b border-zinc-800/40 bg-zinc-900/40">
              <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{t.apiKeys.name}</span>
              <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{t.apiKeys.key}</span>
              <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{t.apiKeys.created}</span>
              <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">{t.apiKeys.lastUsed}</span>
              <span />
            </div>
            {keys.map((key) => (
              <div
                key={key.id}
                className="grid grid-cols-[1fr_140px_100px_100px_64px] items-center px-5 py-3 border-b border-zinc-800/20 last:border-b-0 hover:bg-zinc-800/20 transition-colors"
              >
                <span className="text-sm text-zinc-200 truncate pr-2">{key.name}</span>
                <code className="text-xs text-zinc-500 font-mono">{key.keyPrefix}...</code>
                <span className="text-xs text-zinc-500">{timeAgo(key.createdAt, t.time)}</span>
                <span className="text-xs text-zinc-500">
                  {key.lastUsedAt ? timeAgo(key.lastUsedAt, t.time) : <span className="text-zinc-600">{t.common.never}</span>}
                </span>
                <div className="text-right">
                  <button
                    onClick={() => setRevokeTarget(key.id)}
                    className="text-xs text-red-500/70 hover:text-red-400 transition-colors"
                  >
                    {t.apiKeys.revoke}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Mobile cards */}
          <div className="sm:hidden space-y-3">
            {keys.map((key) => (
              <div key={key.id} className="p-4 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-zinc-200 truncate">{key.name}</span>
                  <button
                    onClick={() => setRevokeTarget(key.id)}
                    className="text-xs text-red-500/70 hover:text-red-400 transition-colors shrink-0 ml-3"
                  >
                    {t.apiKeys.revoke}
                  </button>
                </div>
                <code className="text-xs text-zinc-500 font-mono block mb-2">{key.keyPrefix}...</code>
                <div className="flex gap-4 text-[11px] text-zinc-600">
                  <span>{t.apiKeys.created} {timeAgo(key.createdAt, t.time)}</span>
                  <span>{t.apiKeys.lastUsed} {key.lastUsedAt ? timeAgo(key.lastUsedAt, t.time) : t.common.never.toLowerCase()}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        /* Empty state */
        <div className="text-center py-16">
          <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
            </svg>
          </div>
          <p className="text-sm text-zinc-400">{t.apiKeys.noKeys}</p>
          <p className="text-xs text-zinc-600 mt-1">{t.apiKeys.noKeysHint}</p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors inline-flex items-center gap-2"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t.apiKeys.createKey}
          </button>
        </div>
      )}

      {/* ─── Create dialog ─── */}
      {showCreate && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
          onKeyDown={(e) => { if (e.key === 'Escape' && !creating) { setShowCreate(false); setNewKeyName(''); } }}
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { if (!creating) { setShowCreate(false); setNewKeyName(''); } }} />
          <div
            className="relative z-10 w-full max-w-md mx-4 p-6 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-100 mb-1">{t.apiKeys.createApiKey}</h2>
            <p className="text-xs text-zinc-500 mb-5">{t.apiKeys.createKeyDesc}</p>

            <label className="text-xs font-medium text-zinc-400 block mb-1.5">{t.apiKeys.name}</label>
            <input
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newKeyName.trim()) createKey(); }}
              placeholder={t.apiKeys.keyNamePlaceholder}
              autoFocus
              className="w-full h-10 px-3 text-sm bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors"
              disabled={creating}
            />

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => { setShowCreate(false); setNewKeyName(''); }}
                disabled={creating}
                className="h-9 px-4 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                {t.common.cancel}
              </button>
              <button
                onClick={createKey}
                disabled={!newKeyName.trim() || creating}
                className="h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {creating ? t.common.creating : t.apiKeys.createKey}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Revoke dialog ─── */}
      {revokeTarget && (() => {
        const targetKey = keys.find((k) => k.id === revokeTarget);
        return (
          <div
            className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
            onKeyDown={(e) => { if (e.key === 'Escape' && !revoking) setRevokeTarget(null); }}
          >
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => { if (!revoking) setRevokeTarget(null); }} />
            <div
              className="relative z-10 w-full max-w-sm mx-4 p-6 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <h2 className="text-base font-semibold text-zinc-100 text-center mb-1">{t.apiKeys.revokeApiKey}</h2>
              <p className="text-xs text-zinc-500 text-center mb-5">
                {t.apiKeys.revokeConfirm.replace('{name}', targetKey?.name ?? '')}{' '}
                {t.apiKeys.revokeWarning}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setRevokeTarget(null)}
                  disabled={revoking}
                  className="h-9 px-4 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                  {t.common.cancel}
                </button>
                <button
                  onClick={() => revokeKey(revokeTarget)}
                  disabled={revoking}
                  className="h-9 px-4 text-sm font-medium rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-40"
                >
                  {revoking ? t.apiKeys.revoking : t.apiKeys.revoke}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
