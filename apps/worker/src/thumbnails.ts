import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, type SourceProbe, type FfmpegCapabilities } from './ffmpeg.js';
import { buildVideoFilter } from './transcoding.js';

/** Base interval between scrubber thumbnails (seconds) */
const BASE_INTERVAL_SEC = 5;
/** Upper bound on the number of tiles in a sprite (the interval grows with duration) */
const MAX_TILES = 400;
const THUMB_WIDTH = 160;
const COLS = 5;
/** JPEG hard limit is 65535 px per dimension — keep a safety margin */
const MAX_SPRITE_DIMENSION = 65_000;

export interface SpriteLayout {
  interval: number;
  count: number;
  cols: number;
  rows: number;
  thumbWidth: number;
  thumbHeight: number;
}

function formatVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

/**
 * Computes a sprite layout bounded to MAX_TILES tiles and the JPEG dimension
 * limit. The thumbnail interval scales with duration so very long videos still
 * produce a single, valid sprite.
 */
export function computeSpriteLayout(durationSec: number, srcWidth: number, srcHeight: number): SpriteLayout {
  const duration = Math.max(0, durationSec);

  let thumbHeight = Math.round((THUMB_WIDTH / (srcWidth || 1)) * (srcHeight || 0));
  if (thumbHeight % 2 !== 0) thumbHeight += 1;
  if (thumbHeight <= 0) thumbHeight = 90;
  if (thumbHeight > MAX_SPRITE_DIMENSION) throw new Error('Source aspect ratio is too extreme for a thumbnail sprite');

  const maxRows = Math.max(1, Math.floor(MAX_SPRITE_DIMENSION / thumbHeight));
  const maxTiles = Math.min(MAX_TILES, maxRows * COLS);

  let interval = BASE_INTERVAL_SEC;
  let count = Math.max(1, Math.ceil(duration / interval));
  if (count > maxTiles) {
    interval = Math.ceil(duration / maxTiles);
    count = Math.max(1, Math.ceil(duration / interval));
  }

  return { interval, count, cols: COLS, rows: Math.ceil(count / COLS), thumbWidth: THUMB_WIDTH, thumbHeight };
}

export interface ThumbnailOptions {
  capabilities?: FfmpegCapabilities;
}

/**
 * Generates a scrubber-preview sprite (thumbnails/sprite.jpg) and its VTT map.
 * Throws on failure — callers should treat this as non-fatal (the encode is
 * still valid without a scrubber preview).
 */
export async function generateThumbnails(
  sourcePath: string,
  outputDir: string,
  source: SourceProbe,
  opts: ThumbnailOptions = {},
): Promise<SpriteLayout> {
  if (source.videoStreamIndex === null) throw new Error('Source has no video stream');

  const thumbDir = path.join(outputDir, 'thumbnails');
  await mkdir(thumbDir, { recursive: true });

  const layout = computeSpriteLayout(source.duration, source.width, source.height);
  const { interval, count, cols, rows, thumbWidth, thumbHeight } = layout;

  await runFfmpeg([
    '-y',
    '-i', sourcePath,
    '-map', `0:${source.videoStreamIndex}`,
    '-an',
    '-vf', buildVideoFilter(source, opts.capabilities, {
      extra: [`fps=1/${interval}`, `scale=${thumbWidth}:${thumbHeight}`, `tile=${cols}x${rows}`],
    }),
    '-q:v', '5',
    '-frames:v', '1',
    '-update', '1',
    path.join(thumbDir, 'sprite.jpg'),
  ], { timeoutMs: Math.max(5 * 60_000, source.duration * 2_000), label: 'sprite' });

  let vtt = 'WEBVTT\n\n';
  for (let i = 0; i < count; i++) {
    const start = i * interval;
    const end = Math.min((i + 1) * interval, source.duration);
    if (end <= start) break;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * thumbWidth;
    const y = row * thumbHeight;
    vtt += `${formatVttTime(start)} --> ${formatVttTime(end)}\n`;
    vtt += `sprite.jpg#xywh=${x},${y},${thumbWidth},${thumbHeight}\n\n`;
  }
  await writeFile(path.join(thumbDir, 'thumbnails.vtt'), vtt, 'utf-8');

  return layout;
}
