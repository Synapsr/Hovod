import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg } from './ffmpeg.js';

export interface RenditionProfile {
  quality: string;
  width: number;
  height: number;
  bitrateKbps: number;
  profile: string;
  level: string;
  codecTag: string;
}

export const TRANSCODING_LADDER: RenditionProfile[] = [
  { quality: '360p',  width: 640,  height: 360,  bitrateKbps: 1000,  profile: 'main', level: '3.0', codecTag: 'avc1.4d401e' },
  { quality: '480p',  width: 854,  height: 480,  bitrateKbps: 1800,  profile: 'main', level: '3.0', codecTag: 'avc1.4d401e' },
  { quality: '720p',  width: 1280, height: 720,  bitrateKbps: 3000,  profile: 'main', level: '3.1', codecTag: 'avc1.4d401f' },
  { quality: '1080p', width: 1920, height: 1080, bitrateKbps: 6000,  profile: 'high', level: '4.0', codecTag: 'avc1.640028' },
  { quality: '1440p', width: 2560, height: 1440, bitrateKbps: 10000, profile: 'high', level: '5.0', codecTag: 'avc1.640032' },
  { quality: '2160p', width: 3840, height: 2160, bitrateKbps: 20000, profile: 'high', level: '5.1', codecTag: 'avc1.640033' },
  { quality: '4320p', width: 7680, height: 4320, bitrateKbps: 40000, profile: 'high', level: '6.0', codecTag: 'avc1.64003c' },
];

/**
 * Filter the transcoding ladder to only include renditions at or below the
 * source resolution. Handles portrait videos by comparing against the short
 * side. Always returns at least the lowest rendition (360p) to guarantee
 * a playable output even for very small sources.
 */
export function filterLadder(sourceWidth: number, sourceHeight: number): RenditionProfile[] {
  const shortSide = Math.min(sourceWidth, sourceHeight);
  const filtered = TRANSCODING_LADDER.filter(p => p.height <= shortSide);
  return filtered.length > 0 ? filtered : [TRANSCODING_LADDER[0]];
}

export async function transcodeRendition(
  sourcePath: string,
  outputDir: string,
  profile: RenditionProfile,
  durationSec?: number,
  threads?: number,
): Promise<void> {
  const renditionDir = path.join(outputDir, profile.quality);
  await mkdir(renditionDir, { recursive: true });

  // Dynamic timeout: 4x video duration (minimum 5 min)
  const timeoutMs = durationSec
    ? Math.max(5 * 60_000, durationSec * 4_000)
    : undefined;

  await runFfmpeg([
    '-y',
    ...(threads ? ['-threads', String(threads)] : []),
    '-i', sourcePath,
    '-vf', `scale=w=${profile.width}:h=${profile.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-maxrate', `${profile.bitrateKbps}k`,
    '-bufsize', `${profile.bitrateKbps * 2}k`,
    '-profile:v', profile.profile,
    '-level', profile.level,
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(renditionDir, 'segment_%03d.ts'),
    path.join(renditionDir, 'index.m3u8'),
  ], timeoutMs);
}

export async function extractPosterThumbnail(
  sourcePath: string,
  outputDir: string,
  durationSec: number,
): Promise<void> {
  const posterTime = Math.max(0, Math.floor(durationSec * 0.25));
  await runFfmpeg([
    '-y', '-i', sourcePath,
    '-ss', String(posterTime),
    '-vframes', '1',
    '-vf', 'scale=640:-2',
    '-q:v', '2',
    path.join(outputDir, 'thumbnail.jpg'),
  ]);
}

export async function createDownloadableMp4(
  outputDir: string,
  profile: RenditionProfile,
): Promise<void> {
  const renditionDir = path.join(outputDir, profile.quality);
  const playlistPath = path.join(renditionDir, 'index.m3u8');

  // Fast remux: copies already-encoded streams into MP4 container (no re-encoding)
  await runFfmpeg([
    '-y',
    '-i', playlistPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    path.join(renditionDir, 'download.mp4'),
  ]);
}

export async function createMasterPlaylist(
  outputDir: string,
  profiles: RenditionProfile[],
): Promise<void> {
  let content = '#EXTM3U\n#EXT-X-VERSION:3\n';
  for (const profile of profiles) {
    content += `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bitrateKbps * 1000},RESOLUTION=${profile.width}x${profile.height},CODECS="${profile.codecTag},mp4a.40.2"\n`;
    content += `${profile.quality}/index.m3u8\n`;
  }
  await writeFile(path.join(outputDir, 'master.m3u8'), content, 'utf-8');
}
