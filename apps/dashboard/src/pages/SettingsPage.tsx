import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, API_BASE } from '../lib/api.js';
import { getToken, getUser } from '../lib/auth.js';
import { useSettings, applyAccentColor } from '../lib/settings-context.js';
import { UsageBar } from '../components/UsageBar.js';
import { useT } from '../lib/i18n/index.js';
import type { PlatformSettings } from '../lib/types.js';
import type { Translations } from '../lib/i18n/index.js';

/* ─── Types ──────────────────────────────────────────────── */

interface OrgData {
  id: string;
  name: string;
  slug: string;
  tier: string;
  usage: {
    encodingMinutes: number;
    storageGb: number;
    deliveryMinutes: number;
  };
  limits: {
    encodingMinutes: number;
    storageGb: number;
    deliveryMinutes: number;
    maxAssets: number;
    apiKeys: number;
    rateLimitPerMin: number;
  };
}

interface ApiKeyData {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

interface MeData {
  user: { id: string; email: string; name: string };
  org: { id: string; name: string; slug: string; tier: string };
  billingEnabled?: boolean;
}

const TIER_STYLE: Record<string, string> = {
  free: 'text-zinc-400 bg-zinc-800 border-zinc-700',
  pro: 'text-accent-400 bg-accent-500/10 border-accent-500/20',
  business: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
};

function tierLabel(tier: string, t: Translations): string {
  if (tier === 'pro') return t.orgs.pro;
  if (tier === 'business') return t.orgs.business;
  return t.orgs.free;
}

/* ─── Color presets ──────────────────────────────────────── */

const COLOR_PRESETS = [
  '#4f46e5', // indigo
  '#2563eb', // blue
  '#7c3aed', // violet
  '#db2777', // pink
  '#dc2626', // red
  '#ea580c', // orange
  '#16a34a', // green
  '#0891b2', // cyan
];

/* ─── Toggle component ───────────────────────────────────── */

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
        checked ? 'bg-accent-600' : 'bg-zinc-700'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg transform transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

/* ─── Platform Settings (shared between modes) ───────────── */

function PlatformSettingsSection() {
  const { t } = useT();
  const { settings, refetch } = useSettings();
  const [primaryColor, setPrimaryColor] = useState(settings.primaryColor);
  const [theme, setTheme] = useState(settings.theme);
  const [aiAutoTranscribe, setAiAutoTranscribe] = useState(settings.aiAutoTranscribe);
  const [aiAutoChapter, setAiAutoChapter] = useState(settings.aiAutoChapter);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPrimaryColor(settings.primaryColor);
    setTheme(settings.theme);
    setAiAutoTranscribe(settings.aiAutoTranscribe);
    setAiAutoChapter(settings.aiAutoChapter);
  }, [settings]);

  const hasChanges =
    primaryColor !== settings.primaryColor ||
    theme !== settings.theme ||
    aiAutoTranscribe !== settings.aiAutoTranscribe ||
    aiAutoChapter !== settings.aiAutoChapter;

  const handleColorChange = (color: string) => {
    setPrimaryColor(color);
    applyAccentColor(color);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api<PlatformSettings>('/v1/settings', {
        method: 'PATCH',
        body: JSON.stringify({ primaryColor, theme, aiAutoTranscribe, aiAutoChapter }),
      });
      await refetch();
      setSuccess(t.settings.settingsSaved);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.settings.failedSave);
      applyAccentColor(settings.primaryColor);
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (file: File) => {
    setUploadingLogo(true);
    setError('');
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/v1/settings/logo`, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: file,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `Upload failed (${res.status})`);
      }
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.settings.failedUploadLogo);
    } finally {
      setUploadingLogo(false);
    }
  };

  const removeLogo = async () => {
    setError('');
    try {
      await api('/v1/settings/logo', { method: 'DELETE' });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.settings.failedRemoveLogo);
    }
  };

  return (
    <>
      {/* Error / Success */}
      {error && (
        <div className="flex items-center justify-between text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-400 ml-3">{t.common.dismiss}</button>
        </div>
      )}
      {success && (
        <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
          {success}
        </div>
      )}

      {/* Appearance */}
      <section className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
        <h2 className="text-sm font-semibold text-zinc-300 mb-5">{t.settings.appearance}</h2>

        {/* Primary color */}
        <div className="mb-6">
          <label className="text-xs text-zinc-500 mb-2 block">{t.settings.primaryColor}</label>
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  onClick={() => handleColorChange(c)}
                  className={`w-7 h-7 rounded-lg border-2 transition-all ${
                    primaryColor === c ? 'border-white scale-110' : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
            <div className="flex items-center gap-2 ml-2">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => handleColorChange(e.target.value)}
                className="w-7 h-7 rounded-lg cursor-pointer border-0 bg-transparent [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch-wrapper]:p-0"
              />
              <input
                type="text"
                value={primaryColor}
                onChange={(e) => {
                  const v = e.target.value;
                  if (/^#[0-9a-fA-F]{0,6}$/.test(v)) {
                    setPrimaryColor(v);
                    if (/^#[0-9a-fA-F]{6}$/.test(v)) applyAccentColor(v);
                  }
                }}
                className="w-20 h-8 px-2 text-xs font-mono bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-300 outline-none focus:border-accent-500/60 transition-colors"
              />
            </div>
          </div>
        </div>

        {/* Theme (public pages) */}
        <div className="mb-6">
          <label className="text-xs text-zinc-500 mb-2 block">{t.settings.publicTheme}</label>
          <p className="text-xs text-zinc-600 mb-2">{t.settings.themeDesc}</p>
          <div className="flex gap-2">
            <button
              onClick={() => setTheme('dark')}
              className={`h-9 px-4 text-sm font-medium rounded-lg transition-colors ${
                theme === 'dark'
                  ? 'bg-accent-600 text-white'
                  : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 border border-zinc-700/60'
              }`}
            >
              {t.settings.dark}
            </button>
            <button
              onClick={() => setTheme('light')}
              className={`h-9 px-4 text-sm font-medium rounded-lg transition-colors ${
                theme === 'light'
                  ? 'bg-accent-600 text-white'
                  : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 border border-zinc-700/60'
              }`}
            >
              {t.settings.light}
            </button>
          </div>
        </div>

        {/* Logo */}
        <div>
          <label className="text-xs text-zinc-500 mb-2 block">{t.settings.logo}</label>
          <p className="text-xs text-zinc-600 mb-3">{t.settings.logoDesc}</p>
          {settings.logoUrl ? (
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-zinc-800/60 border border-zinc-700/60 flex items-center justify-center overflow-hidden">
                <img src={settings.logoUrl} alt="Logo" className="w-full h-full object-contain" />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => logoInputRef.current?.click()}
                  className="h-8 px-3 text-xs font-medium rounded-lg bg-zinc-800/60 text-zinc-300 border border-zinc-700/60 hover:bg-zinc-800 transition-colors"
                  disabled={uploadingLogo}
                >
                  {uploadingLogo ? t.common.uploading : t.settings.replace}
                </button>
                <button
                  onClick={removeLogo}
                  className="h-8 px-3 text-xs font-medium rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                >
                  {t.common.remove}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => logoInputRef.current?.click()}
              disabled={uploadingLogo}
              className="h-9 px-4 text-sm font-medium rounded-lg bg-zinc-800/60 text-zinc-300 border border-zinc-700/60 hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              {uploadingLogo ? t.common.uploading : t.settings.uploadLogo}
            </button>
          )}
          <input
            ref={logoInputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadLogo(file);
              e.target.value = '';
            }}
          />
        </div>
      </section>

      {/* AI Defaults */}
      <section className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
        <h2 className="text-sm font-semibold text-zinc-300 mb-1">{t.settings.aiDefaults}</h2>
        <p className="text-xs text-zinc-600 mb-5">
          {t.settings.aiDefaultsDesc}
        </p>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-zinc-200">{t.settings.autoTranscribe}</p>
              <p className="text-xs text-zinc-500 mt-0.5">{t.settings.autoTranscribeDesc}</p>
            </div>
            <Toggle checked={aiAutoTranscribe} onChange={setAiAutoTranscribe} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-zinc-200">{t.settings.autoChapter}</p>
              <p className="text-xs text-zinc-500 mt-0.5">{t.settings.autoChapterDesc}</p>
            </div>
            <Toggle checked={aiAutoChapter} onChange={setAiAutoChapter} />
          </div>
        </div>
      </section>

      {/* Save */}
      {hasChanges && (
        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={saving}
            className="h-9 px-5 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-50"
          >
            {saving ? t.common.saving : t.common.saveChanges}
          </button>
        </div>
      )}
    </>
  );
}

/* ─── Cloud Settings ─────────────────────────────────────── */

function CloudSettings() {
  const { t } = useT();
  const user = getUser();
  const orgId = user?.org;

  const [error, setError] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [orgName, setOrgName] = useState('');

  const queryKey = ['org-settings', orgId];

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey,
    enabled: !!orgId,
    queryFn: async () => {
      const [orgData, keysData, meData] = await Promise.all([
        api<OrgData>(`/v1/orgs/${orgId}`),
        api<ApiKeyData[]>(`/v1/orgs/${orgId}/api-keys`),
        api<MeData>('/v1/auth/me'),
      ]);
      return { org: orgData, keys: keysData, me: meData };
    },
  });

  const org = data?.org ?? null;
  const keys = data?.keys ?? [];
  const me = data?.me ?? null;
  const billingEnabled = data?.me.billingEnabled ?? false;

  const nameMutation = useMutation({
    mutationFn: (name: string) => api(`/v1/orgs/${orgId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    onSuccess: async () => {
      setEditingName(false);
      setError('');
      await refetch();
    },
    onError: (err) => setError(err instanceof Error ? err.message : t.settings.failedUpdateName),
  });
  const savingName = nameMutation.isPending;

  const saveOrgName = () => {
    const name = orgName.trim();
    if (!orgId || !name || name === org?.name) {
      setEditingName(false);
      return;
    }
    setError('');
    nameMutation.mutate(name);
  };

  /* Billing — these navigate away, so they must show a pending state
     instead of letting the user click twice. */
  const checkoutMutation = useMutation({
    mutationFn: (tier: 'pro' | 'business') => api<{ url: string }>('/v1/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ tier }),
    }),
    onSuccess: ({ url }) => { window.location.href = url; },
    onError: (err) => setError(err instanceof Error ? err.message : t.settings.failedCheckout),
  });

  const portalMutation = useMutation({
    mutationFn: () => api<{ url: string }>('/v1/billing/portal', { method: 'POST' }),
    onSuccess: ({ url }) => { window.location.href = url; },
    onError: (err) => setError(err instanceof Error ? err.message : t.settings.failedPortal),
  });

  const billingBusy = checkoutMutation.isPending || portalMutation.isPending;

  if (isLoading) {
    return (
      <div className="space-y-6" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-32 bg-zinc-900/60 border border-zinc-800/60 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="py-20 text-center" role="alert">
        <p className="text-sm text-zinc-300">{t.settings.failedLoadSettings}</p>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="mt-4 h-9 px-4 text-sm font-medium rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-50"
        >
          {isFetching ? t.common.loading : t.common.retry}
        </button>
      </div>
    );
  }

  const tierKey = org?.tier ?? 'free';
  const tierClassName = TIER_STYLE[tierKey] ?? TIER_STYLE.free!;
  const tierLabelText = tierLabel(tierKey, t);

  return (
    <div className="space-y-6">
      {/* Error Banner */}
      {error && (
        <div className="flex items-center justify-between text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-red-500 hover:text-red-400 ml-3">
            {t.common.dismiss}
          </button>
        </div>
      )}

      {/* Platform Settings */}
      <PlatformSettingsSection />

      {/* Account */}
      {me && (
        <section className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
          <h2 className="text-sm font-semibold text-zinc-300 mb-4">{t.settings.account}</h2>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-accent-600/20 border border-accent-500/30 flex items-center justify-center shrink-0">
              <span className="text-lg font-semibold text-accent-400 uppercase">
                {me.user.name.charAt(0)}
              </span>
            </div>
            <div>
              <p className="text-sm font-medium text-zinc-200">{me.user.name}</p>
              <p className="text-xs text-zinc-500">{me.user.email}</p>
            </div>
          </div>
        </section>
      )}

      {/* Organization */}
      <section className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-300">{t.settings.organization}</h2>
          {!editingName && (
            <button
              onClick={() => { setOrgName(org?.name ?? ''); setEditingName(true); }}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              {t.common.edit}
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-zinc-500 mb-1">{t.settings.name}</p>
            {editingName ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveOrgName(); if (e.key === 'Escape') { setEditingName(false); setOrgName(org?.name ?? ''); } }}
                  className="flex-1 h-8 px-2.5 text-sm bg-zinc-800/60 border border-zinc-700/60 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors"
                  autoFocus
                  disabled={savingName}
                />
                <button
                  onClick={saveOrgName}
                  disabled={savingName || !orgName.trim()}
                  className="h-8 px-3 text-xs font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40"
                >
                  {savingName ? t.common.saving : t.common.save}
                </button>
                <button
                  onClick={() => { setEditingName(false); setOrgName(org?.name ?? ''); }}
                  className="h-8 px-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                  disabled={savingName}
                >
                  {t.common.cancel}
                </button>
              </div>
            ) : (
              <p className="text-sm text-zinc-200">{org?.name ?? '\u2014'}</p>
            )}
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">{t.settings.slug}</p>
            <p className="text-sm text-zinc-200 font-mono">{org?.slug ?? '\u2014'}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">{t.settings.plan}</p>
            <span className={`inline-block text-xs font-medium px-2.5 py-0.5 rounded-full border ${tierClassName}`}>
              {tierLabelText}
            </span>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">{t.settings.orgId}</p>
            <p className="text-xs text-zinc-400 font-mono truncate">{org?.id ?? '\u2014'}</p>
          </div>
        </div>
      </section>

      {/* Usage (only shown when billing is enabled) */}
      {billingEnabled && org && (
        <section className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
          <h2 className="text-sm font-semibold text-zinc-300 mb-4">{t.settings.usageThisMonth}</h2>
          <div className="space-y-4">
            <UsageBar label={t.settings.encoding} current={org.usage.encodingMinutes} limit={org.limits.encodingMinutes} unit="min" />
            <UsageBar label={t.settings.storage} current={org.usage.storageGb} limit={org.limits.storageGb} unit="GB" />
            <UsageBar label={t.settings.delivery} current={org.usage.deliveryMinutes} limit={org.limits.deliveryMinutes} unit="min" />
          </div>
        </section>
      )}

      {/* API Keys — link to dedicated page */}
      <section className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-300">{t.nav.apiKeys}</h2>
            <p className="text-xs text-zinc-500 mt-1">
              {t.settings.keysActive.replace('{count}', String(keys.length))}
            </p>
          </div>
          <Link
            to="/api-keys"
            className="text-xs font-medium text-accent-400 hover:text-accent-500 transition-colors flex items-center gap-1"
          >
            {t.settings.manage}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </Link>
        </div>
      </section>

      {/* Billing */}
      {billingEnabled && (
        <section className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl">
          <h2 className="text-sm font-semibold text-zinc-300 mb-4">{t.settings.billing}</h2>
          {org?.tier === 'free' ? (
            <div className="space-y-3">
              <p className="text-sm text-zinc-400">
                {t.settings.freePlanMsg}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => checkoutMutation.mutate('pro')}
                  disabled={billingBusy}
                  className="h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {checkoutMutation.isPending && checkoutMutation.variables === 'pro'
                    ? t.common.loading
                    : t.settings.upgradePro}
                </button>
                <button
                  onClick={() => checkoutMutation.mutate('business')}
                  disabled={billingBusy}
                  className="h-9 px-4 text-sm font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {checkoutMutation.isPending && checkoutMutation.variables === 'business'
                    ? t.common.loading
                    : t.settings.upgradeBusiness}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-zinc-400">
                {t.settings.onPlan.replace('{tier}', tierLabelText)}
              </p>
              <button
                onClick={() => portalMutation.mutate()}
                disabled={billingBusy}
                className="h-9 px-4 text-sm font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {portalMutation.isPending ? t.common.loading : t.settings.manageSubscription}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/* ─── Settings Page ──────────────────────────────────────── */

export function SettingsPage() {
  const { t } = useT();
  return (
    <div className="max-w-2xl mx-auto">
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-zinc-50">{t.settings.title}</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {t.settings.subtitle}
        </p>
      </div>

      <CloudSettings />
    </div>
  );
}
