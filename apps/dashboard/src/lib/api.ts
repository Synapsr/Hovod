import { getToken } from './auth.js';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || '';
const API = API_BASE;

const DEFAULT_TIMEOUT_MS = 30_000;

export async function api<T>(path: string, init?: RequestInit & { raw?: boolean }): Promise<T> {
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
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || `Request failed (${res.status})`);
    }

    const json = await res.json();
    return json.data;
  } finally {
    clearTimeout(timeout);
  }
}
