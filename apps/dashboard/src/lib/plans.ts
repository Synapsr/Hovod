import type { PlanId, PlanInfo, PlanLimits } from './types.js';
import type { Translations } from './i18n/index.js';

/**
 * The two Hovod Cloud plans, mirroring `PLAN_LIMITS` in `@hovod/db` and the
 * marketing site. `GET /v1/config` returns the authoritative copy in cloud mode;
 * this constant is the fallback so the signup page can render before (or without)
 * that request — and so a self-hosted build never depends on it at all.
 */
export const PLAN_IDS: readonly PlanId[] = ['pro', 'business'] as const;

const PRO_LIMITS: PlanLimits = {
  encodingMinutes: 500,
  aiMinutes: 50,
  storageGb: 50,
  apiKeys: 5,
  members: 3,
  rateLimitPerMin: 300,
};

const BUSINESS_LIMITS: PlanLimits = {
  encodingMinutes: 2000,
  aiMinutes: 500,
  storageGb: 250,
  apiKeys: 20,
  members: 10,
  rateLimitPerMin: 600,
};

/**
 * Last-resort prices, used only when the server advertises none (an older API,
 * or Stripe unreachable). Hovod Cloud sells in USD; the server is authoritative.
 */
export const PLANS: Record<PlanId, PlanInfo> = {
  pro: { id: 'pro', name: 'Pro', amount: 29, currency: 'usd', limits: PRO_LIMITS },
  business: { id: 'business', name: 'Business', amount: 99, currency: 'usd', limits: BUSINESS_LIMITS },
};

export const DEFAULT_PLAN: PlanId = 'pro';

/** Narrow an arbitrary string (a `?plan=` query param, a stored value) to a plan id. */
export function toPlanId(value: string | null | undefined): PlanId | null {
  return value === 'pro' || value === 'business' ? value : null;
}

/**
 * Merge what the server advertises with the built-in table: the server wins on
 * price and limits, the constant fills in anything it omits.
 */
export function resolvePlans(serverPlans: PlanInfo[] | undefined): PlanInfo[] {
  if (!serverPlans?.length) return PLAN_IDS.map((id) => PLANS[id]);
  return serverPlans.map((p) => {
    const fallback = PLANS[p.id] ?? PLANS[DEFAULT_PLAN];
    return {
      id: p.id ?? fallback.id,
      name: p.name || fallback.name,
      amount: typeof p.amount === 'number' ? p.amount : fallback.amount,
      currency: p.currency || fallback.currency,
      limits: { ...fallback.limits, ...(p.limits ?? {}) },
    };
  });
}

/**
 * The monthly price as the viewer's locale would write it. The currency comes
 * from Stripe, so this never invents a conversion — it only formats.
 */
export function formatPlanPrice(plan: PlanInfo, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: plan.currency.toUpperCase(),
      minimumFractionDigits: Number.isInteger(plan.amount) ? 0 : 2,
    }).format(plan.amount);
  } catch {
    // Unknown currency code: show the number and the code rather than nothing.
    return `${plan.amount} ${plan.currency.toUpperCase()}`;
  }
}

const fmt = (n: number) => n.toLocaleString();

/** The bullet list shown under a plan card — same wording as the marketing page. */
export function planFeatures(plan: PlanInfo, t: Translations): string[] {
  const l = plan.limits;
  const features = [
    t.plans.featureEncoding.replace('{n}', fmt(l.encodingMinutes)),
    t.plans.featureAi.replace('{n}', fmt(l.aiMinutes)),
    t.plans.featureStorage.replace('{n}', fmt(l.storageGb)),
    t.plans.featureMembers.replace('{n}', fmt(l.members)),
    t.plans.featureApiKeys.replace('{n}', fmt(l.apiKeys)),
    t.plans.featureViews,
    t.plans.featureStreaming,
  ];
  if (plan.id === 'business') features.push(t.plans.featurePriority);
  return features;
}
