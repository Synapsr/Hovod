import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg } from './ffmpeg.js';

function formatVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

export async function generateThumbnails(
  sourcePath: string,
  outputDir: string,
  srcWidth: number,
  srcHeight: number,
  durationSec: number,
): Promise<void> {
  const thumbDir = path.join(outputDir, 'thumbnails');
  await mkdir(thumbDir, { recursive: true });

  const interval = 5;
  const thumbWidth = 160;
  const cols = 5;
  const totalThumbs = Math.max(1, Math.ceil(durationSec / interval));
  const rows = Math.ceil(totalThumbs / cols);

  let thumbHeight = Math.round((thumbWidth / (srcWidth || 1)) * srcHeight);
  if (thumbHeight % 2 !== 0) thumbHeight += 1;
  if (thumbHeight <= 0) thumbHeight = 90;

  await runFfmpeg([
    '-y', '-i', sourcePath,
    '-vf', `fps=1/${interval},scale=${thumbWidth}:${thumbHeight},tile=${cols}x${rows}`,
    '-q:v', '5',
    '-frames:v', '1',
    path.join(thumbDir, 'sprite.jpg'),
  ]);

  let vtt = 'WEBVTT\n\n';
  for (let i = 0; i < totalThumbs; i++) {
    const start = i * interval;
    const end = Math.min((i + 1) * interval, durationSec);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * thumbWidth;
    const y = row * thumbHeight;
    vtt += `${formatVttTime(start)} --> ${formatVttTime(end)}\n`;
    vtt += `sprite.jpg#xywh=${x},${y},${thumbWidth},${thumbHeight}\n\n`;
  }
  await writeFile(path.join(thumbDir, 'thumbnails.vtt'), vtt, 'utf-8');
}
