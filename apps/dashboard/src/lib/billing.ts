import { useMutation } from '@tanstack/react-query';
import { api } from './api.js';
import type { MeOrg, PlanId } from './types.js';
import type { Translations } from './i18n/index.js';

/** Both the signup and the checkout endpoints hand back a Stripe URL — under either name. */
interface RedirectResponse {
  url?: string;
  checkoutUrl?: string;
}

function redirectTo(res: RedirectResponse): void {
  const url = res.checkoutUrl ?? res.url;
  if (url) window.location.href = url;
}

/**
 * `POST /v1/billing/checkout { plan }` — creates a Stripe Checkout session for the
 * current org and leaves the SPA. Returns a pending state so the button can be
 * disabled while the browser is on its way out.
 */
export function useCheckout(onError: (message: string) => void, t: Translations) {
  return useMutation({
    mutationFn: (plan: PlanId) =>
      api<RedirectResponse>('/v1/billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) }),
    onSuccess: redirectTo,
    onError: (err) => onError(err instanceof Error ? err.message : t.billing.failedCheckout),
  });
}

/** `POST /v1/billing/portal` — Stripe customer portal (plan change, card, invoices). */
export function useBillingPortal(onError: (message: string) => void, t: Translations) {
  return useMutation({
    mutationFn: () => api<RedirectResponse>('/v1/billing/portal', { method: 'POST' }),
    onSuccess: redirectTo,
    onError: (err) => onError(err instanceof Error ? err.message : t.billing.failedPortal),
  });
}

/* ─── Presentation helpers ───────────────────────────────── */

export function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function formatStorageGb(bytes: number): number {
  return Math.round((bytes / 1_000_000_000) * 10) / 10;
}

export type SubscriptionChip = { label: string; className: string };

/**
 * The chip next to the plan name in Settings. `cancelAtPeriodEnd` wins over a
 * plain "active" — a subscription that is running out is not the same thing.
 */
export function subscriptionChip(org: MeOrg, t: Translations): SubscriptionChip {
  const status = org.subscriptionStatus;
  if (status === 'past_due' || status === 'unpaid') {
    return { label: t.billing.statusPastDue, className: 'text-amber-400 bg-amber-500/10 border-amber-500/20' };
  }
  if (status === 'canceled' || org.entitlement === 'readonly') {
    return { label: t.billing.statusCanceled, className: 'text-red-400 bg-red-500/10 border-red-500/20' };
  }
  if (org.cancelAtPeriodEnd) {
    return { label: t.billing.statusCanceling, className: 'text-amber-400 bg-amber-500/10 border-amber-500/20' };
  }
  if (status === 'active' || status === 'trialing' || org.entitlement === 'active') {
    return { label: t.billing.statusActive, className: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' };
  }
  return { label: t.billing.statusPending, className: 'text-zinc-400 bg-zinc-800 border-zinc-700' };
}

/** Message for a 402 `code`, falling back to the generic "subscription required". */
export function limitMessage(code: string | null | undefined, t: Translations): string {
  switch (code) {
    case 'storage_limit': return t.billing.limitStorage;
    case 'encoding_limit': return t.billing.limitEncoding;
    case 'ai_limit': return t.billing.limitAi;
    case 'api_keys_limit': return t.billing.limitApiKeys;
    case 'members_limit': return t.billing.limitMembers;
    default: return t.billing.blockedBody;
  }
}
