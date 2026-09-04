import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  organizations,
  ENTITLEMENT_MODE,
  PLAN_LIMITS,
  SUBSCRIPTION_STATUS,
  type EntitlementMode,
  type Plan,
  type PlanLimits,
} from '@hovod/db';
import { db } from '../db.js';
import { isCloud } from '../env.js';
import { isPublicRoute } from '../middleware/auth.js';
import { AppError } from '../middleware/error-handler.js';

/**
 * What an organization may do right now, derived from the subscription mirror
 * that `syncSubscription()` keeps in `organizations`.
 *
 * Self-host: always `selfhost` — unlimited, never blocks, no DB hit.
 */

export interface Entitlement {
  mode: EntitlementMode;
  plan: Plan | null;
  /** `null` in self-host (unlimited). In cloud, the limits of the chosen plan (also for pending orgs). */
  limits: PlanLimits | null;
  /** Stripe status verbatim, `null` without a subscription. */
  status: string | null;
  graceUntil: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** Org columns the state machine needs (a subset of `organizations`). */
export interface EntitlementSource {
  plan: string | null;
  subscriptionStatus: string | null;
  graceUntil: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: number | boolean | null;
}

/** Requests per minute for self-host installs (no plan to read it from). */
export const SELFHOST_RATE_LIMIT_PER_MIN = 600;

const CACHE_TTL_MS = 30_000;

export const SELFHOST_ENTITLEMENT: Entitlement = Object.freeze({
  mode: ENTITLEMENT_MODE.SELFHOST,
  plan: null,
  limits: null,
  status: null,
  graceUntil: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
});

function isPlan(value: string | null): value is Plan {
  return value === 'pro' || value === 'business';
}

/**
 * The entitlement state machine — pure, so it can be unit-tested without a DB.
 *
 * - `active` / `trialing`                                → `active`
 * - `past_due` and now < grace_until                     → `grace`
 * - `past_due` after grace, `unpaid`, `canceled`,
 *   `incomplete`, `incomplete_expired`, `paused`         → `readonly`
 * - no subscription status at all                        → `pending`
 */
export function computeEntitlement(org: EntitlementSource, now: Date = new Date(), cloud: boolean = isCloud): Entitlement {
  if (!cloud) return SELFHOST_ENTITLEMENT;

  const plan = isPlan(org.plan) ? org.plan : null;
  const limits = plan ? PLAN_LIMITS[plan] : null;
  const status = org.subscriptionStatus ?? null;
  const base = {
    plan,
    limits,
    status,
    graceUntil: org.graceUntil ?? null,
    currentPeriodEnd: org.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: !!org.cancelAtPeriodEnd,
  };

  if (!status) return { mode: ENTITLEMENT_MODE.PENDING, ...base };

  if (status === SUBSCRIPTION_STATUS.ACTIVE || status === SUBSCRIPTION_STATUS.TRIALING) {
    return { mode: ENTITLEMENT_MODE.ACTIVE, ...base };
  }

  if (status === SUBSCRIPTION_STATUS.PAST_DUE) {
    if (org.graceUntil && now.getTime() < org.graceUntil.getTime()) {
      return { mode: ENTITLEMENT_MODE.GRACE, ...base };
    }
    return { mode: ENTITLEMENT_MODE.READONLY, ...base };
  }

  // unpaid, canceled, incomplete, incomplete_expired, paused — and anything Stripe adds later.
  return { mode: ENTITLEMENT_MODE.READONLY, ...base };
}

/** True when the org may perform mutating requests. */
export function canMutate(entitlement: Entitlement): boolean {
  return entitlement.mode === ENTITLEMENT_MODE.SELFHOST
    || entitlement.mode === ENTITLEMENT_MODE.ACTIVE
    || entitlement.mode === ENTITLEMENT_MODE.GRACE;
}

/** Per-minute request budget of an org (self-host: fixed). */
export function rateLimitFor(entitlement: Entitlement): number {
  return entitlement.limits?.rateLimitPerMin ?? SELFHOST_RATE_LIMIT_PER_MIN;
}

/* ─── Cache ──────────────────────────────────────────────── */

const cache = new Map<string, { value: Entitlement; expiresAt: number }>();

/** Drop the cached entitlement of an org (called by `syncSubscription`). */
export function invalidateEntitlement(orgId: string): void {
  cache.delete(orgId);
}

/** Forget every cached entitlement (tests / reconcile). */
export function clearEntitlementCache(): void {
  cache.clear();
}

/** Entitlement of an org, cached in-process for 30 s. Unknown org → `pending` (cloud) so it can never mutate. */
export async function getOrgEntitlement(orgId: string): Promise<Entitlement> {
  if (!isCloud) return SELFHOST_ENTITLEMENT;

  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [org] = await db
    .select({
      plan: organizations.plan,
      subscriptionStatus: organizations.subscriptionStatus,
      graceUntil: organizations.graceUntil,
      currentPeriodEnd: organizations.currentPeriodEnd,
      cancelAtPeriodEnd: organizations.cancelAtPeriodEnd,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const value = computeEntitlement(
    org ?? { plan: null, subscriptionStatus: null, graceUntil: null, currentPeriodEnd: null, cancelAtPeriodEnd: 0 },
  );
  cache.set(orgId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/* ─── Route guard ────────────────────────────────────────── */

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Path prefixes that never need an active subscription (auth, billing recovery, invitations). */
const EXEMPT_PREFIXES = ['/v1/auth/', '/v1/billing/', '/v1/invitations/'];

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * True when the entitlement guard must not run for this request: public routes,
 * the auth / billing / invitation flows (which are how a pending or lapsed org
 * gets back to active) and org listing / creation.
 */
export function isEntitlementExempt(method: string, url: string): boolean {
  if (isPublicRoute(url)) return true;
  const path = pathOf(url);
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  // /v1/orgs GET (switcher) and POST (a new org starts its own checkout).
  if ((path === '/v1/orgs' || path === '/v1/orgs/') && (method === 'GET' || method === 'POST')) return true;
  return false;
}

/**
 * Error raised when a plan limit is hit. Serialised by the error handler as
 * `{ error, code }` with HTTP 402 so the dashboard can show the right upsell.
 */
export class LimitError extends AppError {
  constructor(code: 'storage_limit' | 'encoding_limit' | 'ai_limit' | 'api_keys_limit' | 'members_limit' | 'subscription_required', message: string) {
    super(402, message, code);
    this.name = 'LimitError';
  }
}

/**
 * `requireActiveSubscription` — global preHandler (registered after auth).
 *
 * Read-only and pending orgs may still GET (their videos keep playing and the
 * dashboard keeps rendering); every other method gets 402 with a machine code.
 * API keys of such orgs receive the same treatment. No-op in self-host.
 */
export async function requireActiveSubscription(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isCloud) return;
  if (isEntitlementExempt(request.method, request.url)) return;
  if (READ_METHODS.has(request.method)) return;
  if (!request.orgId) return; // auth already rejected it (or a public route slipped through)

  const entitlement = await getOrgEntitlement(request.orgId);
  if (canMutate(entitlement)) return;

  await reply.code(402).send({
    error: 'subscription_required',
    code: 'subscription_required',
    status: entitlement.status,
    entitlement: entitlement.mode,
  });
}

export function registerEntitlementGuard(app: FastifyInstance): void {
  app.addHook('preHandler', requireActiveSubscription);
}
