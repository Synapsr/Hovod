import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, SUBSCRIPTION_REQUIRED_EVENT, type SubscriptionRequiredDetail } from '../lib/api.js';
import { useBillingPortal, useCheckout, formatDate, limitMessage } from '../lib/billing.js';
import { resolvePlans, DEFAULT_PLAN } from '../lib/plans.js';
import { useServerConfig } from '../lib/server-config.js';
import { useT } from '../lib/i18n/index.js';
import { Modal } from './Modal.js';
import { PlanCards } from './PlanCards.js';
import type { Entitlement, MeData, PlanId } from '../lib/types.js';

/** Where a would-be cloud customer is pointed when they'd rather self-host. */
export const SELF_HOST_README_URL = 'https://github.com/Synapsr/Hovod#readme';

/* ─── `GET /v1/auth/me` ──────────────────────────────────── */

/**
 * One shared query for the session. The sidebar, the settings page and this gate
 * all read the same cache entry, so the dashboard asks the API once.
 */
export const ME_QUERY_KEY = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: () => api<MeData>('/v1/auth/me'),
    staleTime: 30_000,
  });
}

/* ─── Context ────────────────────────────────────────────── */

interface SubscriptionContextValue {
  me: MeData | null;
  /** `selfhost` whenever the API has not (yet) said otherwise — never lock a self-host install out. */
  entitlement: Entitlement;
  cloud: boolean;
  /** Refresh `/v1/auth/me`. */
  refetch: () => void;
}

const SubscriptionContext = createContext<SubscriptionContextValue>({
  me: null,
  entitlement: 'selfhost',
  cloud: false,
  refetch: () => {},
});

export function useSubscription() {
  return useContext(SubscriptionContext);
}

/* ─── Screens ────────────────────────────────────────────── */

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 px-4 py-12 flex items-start sm:items-center justify-center">
      <div className="w-full max-w-2xl">{children}</div>
    </div>
  );
}

function Spinner() {
  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center" aria-busy="true">
      <div className="w-6 h-6 rounded-full border-2 border-zinc-700 border-t-accent-500 animate-spin" />
    </div>
  );
}

/**
 * Shown full-page while the org has no subscription at all (`pending`), and inside
 * the read-only modal as the way back to an active plan.
 */
export function Paywall({ title, body }: { title?: string; body?: string }) {
  const { t } = useT();
  const { config } = useServerConfig();
  const { me } = useSubscription();
  const [error, setError] = useState('');
  const plans = useMemo(() => resolvePlans(config?.plans), [config]);
  const checkout = useCheckout(setError, t);
  const [selected, setSelected] = useState<PlanId>(me?.org.plan ?? DEFAULT_PLAN);

  const start = (plan: PlanId) => {
    setSelected(plan);
    setError('');
    checkout.mutate(plan);
  };

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-50">{title ?? t.billing.paywallTitle}</h1>
      <p className="text-sm text-zinc-400 mt-1.5">{body ?? t.billing.paywallBody}</p>

      {error && (
        <p className="mt-4 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2" role="alert">
          {error}
        </p>
      )}

      <div className="mt-6">
        <PlanCards
          plans={plans}
          selected={selected}
          onSelect={start}
          ctaLabel={t.plans.selectPlan}
          pendingPlan={checkout.isPending ? checkout.variables ?? null : null}
          disabled={checkout.isPending}
        />
      </div>

      <div className="mt-6 rounded-xl border border-zinc-800/60 bg-zinc-900/40 px-4 py-3">
        <p className="text-xs text-zinc-500">{t.billing.paywallSelfHost}</p>
        <a
          href={SELF_HOST_README_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs font-medium text-accent-400 hover:text-accent-500 transition-colors"
        >
          {t.billing.paywallSelfHostLink} →
        </a>
      </div>
    </div>
  );
}

/**
 * Sticky notice above the dashboard: a grace-period warning while Stripe retries
 * the card, or a read-only notice once the grace period is over.
 * Rendered by `DashboardLayout` so it sits above the scroll area, not over it.
 */
export function SubscriptionBanner() {
  const { t, locale } = useT();
  const { me, entitlement } = useSubscription();
  const [error, setError] = useState('');
  const portal = useBillingPortal(setError, t);

  if (entitlement !== 'grace' && entitlement !== 'readonly') return null;

  const isGrace = entitlement === 'grace';
  const deadline = me?.org.graceUntil;
  const message = isGrace
    ? (deadline
        ? t.billing.graceBanner.replace('{date}', formatDate(deadline, locale))
        : t.billing.graceBannerNoDate)
    : t.billing.readonlyBanner;

  return (
    <div
      role="status"
      data-testid="subscription-banner"
      className={`sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-xs border-b ${
        isGrace
          ? 'bg-amber-500/10 border-amber-500/20 text-amber-300'
          : 'bg-red-500/10 border-red-500/20 text-red-300'
      }`}
    >
      <span className="flex-1 min-w-0">{error || message}</span>
      <button
        type="button"
        onClick={() => { setError(''); portal.mutate(); }}
        disabled={portal.isPending}
        className="shrink-0 h-7 px-3 font-medium rounded-lg bg-zinc-900/60 border border-white/10 text-zinc-100 hover:bg-zinc-900 transition-colors disabled:opacity-50"
      >
        {portal.isPending ? t.billing.opening : t.billing.manageBilling}
      </button>
    </div>
  );
}

/** Modal raised by any 402 answer — quota reached, or org no longer entitled. */
function BlockedModal({ detail, onClose }: { detail: SubscriptionRequiredDetail; onClose: () => void }) {
  const { t } = useT();
  const [error, setError] = useState('');
  const portal = useBillingPortal(setError, t);

  return (
    <Modal title={t.billing.blockedTitle} onClose={onClose} align="center" size="sm" showHeader={false}>
      <div className="p-6" data-testid="subscription-blocked-modal">
        <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400">
            <rect x="1" y="4" width="22" height="16" rx="2" />
            <line x1="1" y1="10" x2="23" y2="10" />
          </svg>
        </div>
        <h2 className="text-base font-semibold text-zinc-100 text-center mb-1">{t.billing.blockedTitle}</h2>
        <p className="text-xs text-zinc-500 text-center mb-5">
          {detail.error || limitMessage(detail.code, t)}
        </p>
        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-4" role="alert">{error}</p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            {t.common.close}
          </button>
          <button
            type="button"
            onClick={() => { setError(''); portal.mutate(); }}
            disabled={portal.isPending}
            className="h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-50"
          >
            {portal.isPending ? t.billing.opening : t.billing.manageBilling}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Gate ───────────────────────────────────────────────── */

/**
 * Layout route wrapped around `DashboardLayout`.
 *
 * Self-host (`entitlement: 'selfhost'`, or an API that says nothing) renders the
 * dashboard untouched — no query result may ever turn into a paywall there.
 */
export function SubscriptionGate() {
  const { data: me, isLoading, isError, refetch } = useMe();
  const [blocked, setBlocked] = useState<SubscriptionRequiredDetail | null>(null);

  // Any 402 from `api()` lands here, wherever it was triggered from.
  useEffect(() => {
    const onBlocked = (e: Event) => {
      setBlocked((e as CustomEvent<SubscriptionRequiredDetail>).detail);
      // The entitlement almost certainly changed — pull a fresh `me`.
      refetch();
    };
    window.addEventListener(SUBSCRIPTION_REQUIRED_EVENT, onBlocked);
    return () => window.removeEventListener(SUBSCRIPTION_REQUIRED_EVENT, onBlocked);
  }, [refetch]);

  const entitlement: Entitlement = me?.org.entitlement ?? 'selfhost';

  const value = useMemo<SubscriptionContextValue>(
    () => ({ me: me ?? null, entitlement, cloud: me?.cloud === true, refetch: () => { refetch(); } }),
    [me, entitlement, refetch],
  );

  const dismiss = useCallback(() => setBlocked(null), []);

  if (isLoading && !me) return <Spinner />;

  // A failed /v1/auth/me is a transport problem, not a billing verdict.
  if (!isError && entitlement === 'pending') {
    return (
      <SubscriptionContext.Provider value={value}>
        <FullScreen>
          <div data-testid="paywall"><Paywall /></div>
        </FullScreen>
      </SubscriptionContext.Provider>
    );
  }

  return (
    <SubscriptionContext.Provider value={value}>
      <Outlet />
      {blocked && <BlockedModal detail={blocked} onClose={dismiss} />}
    </SubscriptionContext.Provider>
  );
}
