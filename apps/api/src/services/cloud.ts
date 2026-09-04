import { randomBytes, scryptSync, createHmac, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import { ID_LENGTH } from '@hovod/db';

/* ─── Password Hashing (scrypt) ──────────────────────────── */

const SCRYPT_KEY_LEN = 64;
const SALT_LEN = 16;

/** Hash a password with a random salt. Returns "salt:hash" (hex-encoded). */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Constant-time compare that tolerates different lengths instead of throwing. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a password against a "salt:hash" string.
 *
 * Returns false — never throws — for anything that is not a well-formed stored
 * hash (truncated column, non-hex characters, a hash from another algorithm).
 * A malformed row used to reach `timingSafeEqual` with mismatched buffers and
 * surface as a 500 on the login route.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [saltHex, hashHex] = parts as [string, string];
  if (!/^[0-9a-fA-F]+$/.test(saltHex) || !/^[0-9a-fA-F]+$/.test(hashHex)) return false;
  if (saltHex.length !== SALT_LEN * 2 || hashHex.length !== SCRYPT_KEY_LEN * 2) return false;

  try {
    const salt = Buffer.from(saltHex, 'hex');
    const storedHash = Buffer.from(hashHex, 'hex');
    const candidateHash = scryptSync(password, salt, SCRYPT_KEY_LEN);
    return safeEqual(storedHash, candidateHash);
  } catch {
    return false;
  }
}

/* ─── JWT (HS256 via node:crypto) ────────────────────────── */

export interface JwtPayload {
  /** User id. */
  sub: string;
  /** Organization the token is scoped to. */
  org: string;
  /** `users.token_version` at signing time — a bump invalidates the token. */
  tv: number;
  iat: number;
  exp: number;
}

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString();
}

const JWT_HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

/** Access token lifetime. Short enough that a stolen token expires quickly. */
export const JWT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours

/** Sign a JWT with HS256. */
export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = { ...payload, iat: now, exp: now + JWT_EXPIRY_SECONDS };
  const body = base64url(JSON.stringify(fullPayload));
  const data = `${JWT_HEADER}.${body}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Verify and decode a JWT. Throws on invalid/expired tokens. */
export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const [header, body, signature] = parts as [string, string, string];
  const expectedSig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');

  if (!safeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
    throw new Error('Invalid token signature');
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64urlDecode(body)) as JwtPayload;
  } catch {
    throw new Error('Invalid token payload');
  }
  if (!payload || typeof payload.sub !== 'string' || typeof payload.org !== 'string') {
    throw new Error('Invalid token payload');
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  // Tokens minted before token_version existed are treated as version 0.
  if (typeof payload.tv !== 'number') payload.tv = 0;

  return payload;
}

/* ─── API Key Generation ─────────────────────────────────── */

const API_KEY_PREFIX = 'mk_live_';

/** Scopes an API key can carry. `null` in the DB means full access. */
export const API_KEY_SCOPES = { READ: 'read', WRITE: 'write' } as const;

/** True when the key may perform mutating requests. */
export function scopesAllowWrite(scopes: unknown): boolean {
  if (scopes === null || scopes === undefined) return true; // legacy key → full access
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.length === 0) return true;
  return list.includes(API_KEY_SCOPES.WRITE);
}

/** Generate a new API key. Returns the raw key (shown once) and its HMAC hash for storage. */
export function generateApiKey(secret: string): { raw: string; hash: string; prefix: string } {
  const raw = `${API_KEY_PREFIX}${nanoid(ID_LENGTH.API_KEY)}`;
  return { raw, hash: hashApiKey(raw, secret), prefix: raw.slice(0, 12) };
}

/** HMAC-SHA256 hash of an API key for storage and lookup. */
export function hashApiKey(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}
