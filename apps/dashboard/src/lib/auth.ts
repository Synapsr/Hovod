const TOKEN_KEY = 'hovod_token';

/* ─── Token Management ───────────────────────────────────── */

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/* ─── JWT Payload ────────────────────────────────────────── */

export interface TokenPayload {
  sub: string;
  org: string;
  tier: string;
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

export function logout(): void {
  clearToken();
  window.location.href = '/';
}
