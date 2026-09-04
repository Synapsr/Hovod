import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, API_BASE } from '../lib/api.js';
import { getToken, getUser } from '../lib/auth.js';
import { useSettings, applyAccentColor } from '../lib/settings-context.js';
import { UsageBar } from '../components/UsageBar.js';
import { useSubscription } from '../components/SubscriptionGate.js';
import {
  formatDate,
  formatStorageGb,
  subscriptionChip,
  useBillingPortal,
} from '../lib/billing.js';
import { PLANS } from '../lib/plans.js';
import { useT } from '../lib/i18n/index.js';
import type { MeData, PlatformSettings } from '../lib/types.js';

/* ─── Types ──────────────────────────────────────────────── */

interface OrgData {
  id: string;
  name: string;
  slug: string;
}

interface ApiKeyData {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
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
      const [orgData, keysData] = await Promise.all([
        api<OrgData>(`/v1/orgs/${orgId}`),
        api<ApiKeyData[]>(`/v1/orgs/${orgId}/api-keys`),
      ]);
      return { org: orgData, keys: keysData };
    },
  });

  const org = data?.org ?? null;
  const keys = data?.keys ?? [];
  // `/v1/auth/me` is already loaded by SubscriptionGate — plan, limits and usage all come from it.
  const { me, cloud } = useSubscription();

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

  /* Both buttons leave the SPA for Stripe, so they must show a pending state
     instead of letting the user click twice. */
  const portalMutation = useBillingPortal(setError, t);

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
            <p className="text-xs text-zinc-500 mb-1">{t.settings.orgId}</p>
            <p className="text-xs text-zinc-400 font-mono truncate">{org?.id ?? '\u2014'}</p>
          </div>
        </div>
      </section>

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

      {/* Subscription — cloud only; a self-hosted install has no plan and no billing */}
      {cloud && me && (
        <SubscriptionCard me={me} portal={portalMutation} />
      )}

    </div>
  );
}

/* ─── Subscription card (cloud only) ─────────────────────── */

function SubscriptionCard({
  me,
  portal,
}: {
  me: MeData;
  portal: ReturnType<typeof useBillingPortal>;
}) {
  const { t, locale } = useT();
  const org = me.org;
  const limits = me.limits;
  const chip = subscriptionChip(org, t);
  const planName = org.plan ? PLANS[org.plan]?.name ?? org.plan : '\u2014';

  // Which date matters depends on where the subscription is heading.
  const dateLine = org.subscriptionStatus === 'canceled'
    ? t.billing.endedOn.replace('{date}', formatDate(org.currentPeriodEnd, locale))
    : org.cancelAtPeriodEnd
      ? t.billing.cancelsOn.replace('{date}', formatDate(org.currentPeriodEnd, locale))
      : org.currentPeriodEnd
        ? t.billing.renewsOn.replace('{date}', formatDate(org.currentPeriodEnd, locale))
        : null;

  return (
    <section className="p-5 bg-zinc-900/60 border border-zinc-800/60 rounded-xl" data-testid="subscription-card">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h2 className="text-sm font-semibold text-zinc-300">{t.billing.subscription}</h2>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-base font-semibold text-zinc-100">{planName}</span>
            <span className={`inline-block text-[11px] font-medium px-2 py-0.5 rounded-full border ${chip.className}`}>
              {chip.label}
            </span>
          </div>
          {dateLine && <p className="text-xs text-zinc-500 mt-1">{dateLine}</p>}
        </div>
      </div>

      {limits && (
        <div className="space-y-4">
          <UsageBar
            label={t.billing.usageEncoding}
            current={Math.round(me.usage.encodingMinutes)}
            limit={limits.encodingMinutes}
            unit="min"
          />
          <UsageBar
            label={t.billing.usageAi}
            current={Math.round(me.usage.aiMinutes)}
            limit={limits.aiMinutes}
            unit="min"
          />
          <UsageBar
            label={t.billing.usageStorage}
            current={formatStorageGb(me.usage.storageBytes)}
            limit={limits.storageGb}
            unit="GB"
          />
          <p className="text-[11px] text-zinc-600">{t.billing.usageResets}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-5">
        <button
          type="button"
          onClick={() => portal.mutate()}
          disabled={portal.isPending}
          className="h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {portal.isPending ? t.billing.opening : t.billing.manageBilling}
        </button>
        <button
          type="button"
          onClick={() => portal.mutate()}
          disabled={portal.isPending}
          className="h-9 px-4 text-sm font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t.billing.changePlan}
        </button>
      </div>
    </section>
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
