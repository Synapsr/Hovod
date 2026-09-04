import { getToken, handleUnauthorized } from './auth.js';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || '';
const API = API_BASE;

const DEFAULT_TIMEOUT_MS = 30_000;

/** Endpoints where a 401 is a normal answer (bad credentials), not an expired session. */
const AUTH_ENDPOINTS = ['/v1/auth/login', '/v1/auth/signup'];

/** Envelope every API response is wrapped in. Extra keys (pagination…) are preserved. */
export interface ApiEnvelope<T> {
  data: T;
  [key: string]: unknown;
}

export interface ApiInit extends RequestInit {
  /** Do not force a JSON Content-Type (binary bodies). */
  raw?: boolean;
  /** Resolve with the full `{ data, ... }` envelope instead of just `data`. */
  envelope?: boolean;
  /** Override the request timeout (ms). */
  timeoutMs?: number;
}

/** Error carrying the HTTP status so callers can branch on it. */
export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable reason from the API body (`subscription_required`, `storage_limit`…). */
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/* ─── Subscription (402) ─────────────────────────────────── */

/**
 * A 402 is not a generic failure: the org is out of entitlement or over a limit.
 * `api()` broadcasts it so `SubscriptionGate` can put the paywall in front of the
 * user instead of letting each call site invent its own error toast.
 */
export const SUBSCRIPTION_REQUIRED_EVENT = 'hovod:subscription-required';

export interface SubscriptionRequiredDetail {
  /** Human-readable message from the API. */
  error: string;
  /** `subscription_required` | `storage_limit` | `encoding_limit` | `api_keys_limit` | `members_limit` | … */
  code: string;
  /** Stripe subscription status, when the API knows it. */
  status?: string | null;
}

function emitSubscriptionRequired(detail: SubscriptionRequiredDetail): void {
  try {
    window.dispatchEvent(new CustomEvent<SubscriptionRequiredDetail>(SUBSCRIPTION_REQUIRED_EVENT, { detail }));
  } catch { /* no window (tests) — the thrown ApiError is still enough */ }
}

export async function api<T>(path: string, init?: ApiInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body && !init.raw) headers['Content-Type'] = 'application/json';

  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Merge caller-provided headers (e.g. Content-Type for binary uploads)
  if (init?.headers) {
    const h = init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : Array.isArray(init.headers)
        ? Object.fromEntries(init.headers)
        : init.headers as Record<string, string>;
    Object.assign(headers, h);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({} as { error?: string; code?: string; status?: string | null }));
      // Centralised session expiry: drop the token and bounce to /login?from=…
      if (res.status === 401 && !AUTH_ENDPOINTS.some((p) => path.startsWith(p))) {
        handleUnauthorized();
      }
      const code = typeof json.code === 'string' ? json.code : null;
      if (res.status === 402) {
        emitSubscriptionRequired({
          error: json.error || 'Subscription required',
          code: code ?? 'subscription_required',
          status: json.status ?? null,
        });
      }
      throw new ApiError(json.error || `Request failed (${res.status})`, res.status, code);
    }

    const json = await res.json() as ApiEnvelope<T>;
    return (init?.envelope ? json : json.data) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/** Same as `api()` but resolves with the full envelope (data + pagination metadata). */
export function apiEnvelope<T>(path: string, init?: ApiInit): Promise<ApiEnvelope<T>> {
  return api<ApiEnvelope<T>>(path, { ...init, envelope: true });
}

/* ─── Paginated list endpoints ───────────────────────────── */

/** Keyset pagination block returned next to `data` by list endpoints. */
export interface Pagination {
  limit: number;
  hasMore: boolean;
  /** Opaque cursor for the next page, or null when this was the last one. */
  nextCursor: string | null;
  /** Only present when the list is unfiltered (a cheap COUNT). */
  total?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: Pagination;
}

/** GET a keyset-paginated list, keeping the `pagination` block. */
export async function apiPaginated<T>(path: string, init?: ApiInit): Promise<PaginatedResponse<T>> {
  const envelope = await apiEnvelope<T[]>(path, init);
  const pagination = envelope.pagination as Pagination | undefined;
  return {
    data: envelope.data ?? [],
    // Tolerate an older API that answers without a pagination block.
    pagination: pagination ?? { limit: envelope.data?.length ?? 0, hasMore: false, nextCursor: null },
  };
}
