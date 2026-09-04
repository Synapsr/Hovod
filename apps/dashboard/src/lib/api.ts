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
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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
      const json = await res.json().catch(() => ({} as { error?: string }));
      // Centralised session expiry: drop the token and bounce to /login?from=…
      if (res.status === 401 && !AUTH_ENDPOINTS.some((p) => path.startsWith(p))) {
        handleUnauthorized();
      }
      throw new ApiError(json.error || `Request failed (${res.status})`, res.status);
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
