import type { ThumbnailCue } from './types.js';

export function timeAgo(d: string, time?: { justNow: string; mAgo: string; hAgo: string; dAgo: string }): string {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  const t = time ?? { justNow: 'just now', mAgo: '{n}m ago', hAgo: '{n}h ago', dAgo: '{n}d ago' };
  if (s < 60) return t.justNow;
  if (s < 3600) return t.mAgo.replace('{n}', String(Math.floor(s / 60)));
  if (s < 86400) return t.hAgo.replace('{n}', String(Math.floor(s / 3600)));
  return t.dAgo.replace('{n}', String(Math.floor(s / 86400)));
}

export function formatDuration(sec: number | null): string {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatTime(s: number): string {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function parseVttTimestamp(ts: string): number {
  const parts = ts.split(':');
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
  }
  const [m, s] = parts;
  return parseInt(m) * 60 + parseFloat(s);
}

export function parseThumbnailVtt(text: string, baseUrl: string): ThumbnailCue[] {
  const base = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
  const cues: ThumbnailCue[] = [];
  const blocks = text.trim().split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        const [startStr, endStr] = lines[i].split('-->').map(s => s.trim());
        const ref = lines[i + 1]?.trim();
        if (ref && ref.includes('#xywh=')) {
          const [file, frag] = ref.split('#xywh=');
          const [x, y, w, h] = frag.split(',').map(Number);
          cues.push({
            start: parseVttTimestamp(startStr),
            end: parseVttTimestamp(endStr),
            url: base + file,
            x, y, w, h,
          });
        }
        break;
      }
    }
  }
  return cues;
}

export function formatWatchTime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function estimateRenditionSize(bitrateKbps: number, durationSec: number): number {
  return ((bitrateKbps + 128) * 1000 / 8) * durationSec;
}

export const STATUS_CFG: Record<string, { dot: string; bg: string; text: string }> = {
  created:    { dot: 'bg-zinc-500',    bg: 'bg-zinc-500/10',    text: 'text-zinc-400' },
  uploaded:   { dot: 'bg-blue-500',    bg: 'bg-blue-500/10',    text: 'text-blue-400' },
  queued:     { dot: 'bg-amber-500',   bg: 'bg-amber-500/10',   text: 'text-amber-400' },
  processing: { dot: 'bg-blue-500',    bg: 'bg-blue-500/10',    text: 'text-blue-400' },
  ready:      { dot: 'bg-emerald-500', bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  error:      { dot: 'bg-red-500',     bg: 'bg-red-500/10',     text: 'text-red-400' },
  deleted:    { dot: 'bg-zinc-600',    bg: 'bg-zinc-600/10',    text: 'text-zinc-500' },
};
