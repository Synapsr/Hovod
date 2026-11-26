/**
 * Playback token of a private (signed) video, as passed in the page URL:
 * `/embed/<playbackId>?token=…` or `/watch/<playbackId>?token=…`.
 *
 * Every public playback request (info, comments, reactions, download) must
 * carry it, otherwise the API answers 403 for a signed asset.
 */

/** Tokens are base64url JWT-like strings; anything else is ignored. */
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 1024;

/** API error codes for a missing / rejected playback token. */
export const PLAYBACK_TOKEN_ERRORS = new Set(['playback_token_required', 'playback_token_invalid']);

export function readPlaybackToken(search: string = window.location.search): string | null {
  const token = new URLSearchParams(search).get('token');
  if (!token || token.length > MAX_TOKEN_LENGTH || !TOKEN_RE.test(token)) return null;
  return token;
}

/** Append `token=` to an API path when the page was opened with one. */
export function withPlaybackToken(path: string, token: string | null = readPlaybackToken()): string {
  if (!token) return path;
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** Add a query parameter to a URL that may already carry a query (presigned URLs do). */
export function appendQuery(url: string, key: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}
