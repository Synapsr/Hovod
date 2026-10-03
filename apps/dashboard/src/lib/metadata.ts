/**
 * MySQL can return JSON objects directly, while MariaDB returns JSON text.
 * Older rows also contain an extra JSON string layer. Normalize both before
 * rendering or spreading metadata in the key-value editor.
 */
export function normalizeCustomMetadata(value: unknown): Record<string, string> | null {
  let parsed = value;
  for (let depth = 0; depth < 2 && typeof parsed === 'string'; depth++) {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  // The editor and the API both require string values. Reject malformed shapes
  // rather than passing nested objects to React or silently rewriting values.
  if (!Object.values(parsed).every((entry) => typeof entry === 'string')) return null;
  return parsed as Record<string, string>;
}
