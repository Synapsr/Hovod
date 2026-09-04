const TOKEN_KEY = 'hovod_token';

/** Routes that are usable while logged out — never bounce them to /login. */
const PUBLIC_PATH_PREFIXES = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password/',
  '/invite/',
  '/embed/',
  '/watch/',
];

/** Largest value setTimeout can hold without overflowing to 0. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/* ─── Token Management ───────────────────────────────────── */

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch { /* storage unavailable — the session stays in memory only */ }
  scheduleExpiryLogout();
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

/* ─── JWT Payload ────────────────────────────────────────── */

export interface TokenPayload {
  sub: string;
  org: string;
  /** users.token_version — bumped on password change so old tokens stop working. */
  tv?: number;
  iat: number;
  exp: number;
}

function decodeToken(token: string): TokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const json = atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as TokenPayload;
  } catch {
    return null;
  }
}

/* ─── Auth Helpers ───────────────────────────────────────── */

export function isLoggedIn(): boolean {
  const token = getToken();
  if (!token) return false;
  const payload = decodeToken(token);
  if (!payload) return false;
  return payload.exp > Math.floor(Date.now() / 1000);
}

export function getUser(): TokenPayload | null {
  const token = getToken();
  if (!token) return null;
  return decodeToken(token);
}

export function getCurrentOrgId(): string | null {
  const user = getUser();
  return user?.org ?? null;
}

/* ─── Session expiry ─────────────────────────────────────── */

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

/** Build `/login?from=<current path>` for the page the user was trying to reach. */
export function loginUrlFromHere(): string {
  const here = window.location.pathname + window.location.search;
  if (isPublicPath(window.location.pathname)) return '/login';
  return `/login?from=${encodeURIComponent(here)}`;
}

/**
 * The session is gone (expired token, or the API answered 401).
 * Drops the token and sends the user to /login, remembering where they were.
 * Safe to call repeatedly — it redirects at most once.
 */
let redirecting = false;
export function handleUnauthorized(): void {
  clearToken();
  if (redirecting) return;
  if (isPublicPath(window.location.pathname)) return;
  redirecting = true;
  window.location.replace(loginUrlFromHere());
}

/**
 * Arm a timer that logs the user out the moment the JWT expires, so an idle
 * tab does not sit on a dashboard it can no longer talk to.
 * Called on every setToken(); call once at app start too.
 */
export function scheduleExpiryLogout(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  const payload = getUser();
  if (!payload) return;

  const msLeft = payload.exp * 1000 - Date.now();
  if (msLeft <= 0) {
    handleUnauthorized();
    return;
  }
  expiryTimer = setTimeout(handleUnauthorized, Math.min(msLeft, MAX_TIMEOUT_MS));
}

export function logout(): void {
  clearToken();
  window.location.href = '/login';
}
