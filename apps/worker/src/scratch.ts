import { mkdir, readdir, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

export const JOB_DIR_PREFIX = 'hovod-';
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Free space (bytes) on the filesystem holding `dir`. */
export async function getFreeSpace(dir: string): Promise<number> {
  const fs = await statfs(dir);
  return Number(fs.bavail) * Number(fs.bsize);
}

function formatGb(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

/**
 * Ensures at least `requiredBytes` are free under `dir`. Throws a clear,
 * user-facing error otherwise. A failed statfs is logged and ignored so an
 * exotic filesystem never blocks processing.
 */
export async function ensureFreeSpace(dir: string, requiredBytes: number, what = 'processing'): Promise<void> {
  let free: number;
  try {
    free = await getFreeSpace(dir);
  } catch (err) {
    console.warn(`[scratch] Could not check free space in ${dir}: ${(err as Error).message}`);
    return;
  }
  if (free < requiredBytes) {
    throw new Error(`Not enough scratch space for ${what}: ${formatGb(free)} free in ${dir}, ${formatGb(requiredBytes)} required`);
  }
}

/** Removes leftover job directories (hovod-*) older than 24h from a previous run. */
export async function sweepStaleJobDirs(workDir: string, now = Date.now()): Promise<number> {
  await mkdir(workDir, { recursive: true });
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(workDir);
  } catch (err) {
    console.warn(`[scratch] Could not list ${workDir}: ${(err as Error).message}`);
    return 0;
  }

  for (const entry of entries) {
    if (!entry.startsWith(JOB_DIR_PREFIX)) continue;
    const full = path.join(workDir, entry);
    try {
      const s = await stat(full);
      if (!s.isDirectory()) continue;
      if (now - s.mtimeMs < STALE_AFTER_MS) continue;
      await rm(full, { recursive: true, force: true });
      removed += 1;
      console.log(`[scratch] Removed stale job directory ${full}`);
    } catch (err) {
      console.warn(`[scratch] Could not remove ${full}: ${(err as Error).message}`);
    }
  }
  return removed;
}
