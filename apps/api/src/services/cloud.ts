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

/** Verify a password against a "salt:hash" string. */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const storedHash = Buffer.from(hashHex, 'hex');
  const candidateHash = scryptSync(password, salt, SCRYPT_KEY_LEN);
  return timingSafeEqual(storedHash, candidateHash);
}

/* ─── JWT (HS256 via node:crypto) ────────────────────────── */

interface JwtPayload {
  sub: string;
  org: string;
  tier: string;
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
const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

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

  const [header, body, signature] = parts;
  const expectedSig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');

  if (!timingSafeEqual(Buffer.from(signature!), Buffer.from(expectedSig))) {
    throw new Error('Invalid token signature');
  }

  const payload = JSON.parse(base64urlDecode(body!)) as JwtPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return payload;
}

/* ─── API Key Generation ─────────────────────────────────── */

const API_KEY_PREFIX = 'mk_live_';

/** Generate a new API key. Returns the raw key (shown once) and its SHA-256 hash for storage. */
export function generateApiKey(secret: string): { raw: string; hash: string; prefix: string } {
  const raw = `${API_KEY_PREFIX}${nanoid(ID_LENGTH.API_KEY)}`;
  return { raw, hash: hashApiKey(raw, secret), prefix: raw.slice(0, 12) };
}

/** HMAC-SHA256 hash of an API key for storage and lookup. */
export function hashApiKey(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}
