import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, probeOutputDimensions, type SourceProbe, type FfmpegCapabilities } from './ffmpeg.js';

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
  { quality: '480p',  width: 854,  height: 480,  bitrateKbps: 1800,  profile: 'main', level: '3.1', codecTag: 'avc1.4d401f' },
  { quality: '720p',  width: 1280, height: 720,  bitrateKbps: 3000,  profile: 'main', level: '3.1', codecTag: 'avc1.4d401f' },
  { quality: '1080p', width: 1920, height: 1080, bitrateKbps: 6000,  profile: 'high', level: '4.0', codecTag: 'avc1.640028' },
  { quality: '1440p', width: 2560, height: 1440, bitrateKbps: 10000, profile: 'high', level: '5.0', codecTag: 'avc1.640032' },
  { quality: '2160p', width: 3840, height: 2160, bitrateKbps: 20000, profile: 'high', level: '5.1', codecTag: 'avc1.640033' },
  { quality: '4320p', width: 7680, height: 4320, bitrateKbps: 40000, profile: 'high', level: '6.0', codecTag: 'avc1.64003c' },
];

export const HLS_SEGMENT_SECONDS = 6;
export const AUDIO_BITRATE_KBPS = 128;
export const AUDIO_CODEC_TAG = 'mp4a.40.2';

/** Rungs that get the slower/better "medium" x264 preset; the rest use "fast". */
const MEDIUM_PRESET_QUALITIES = new Set(['360p', '480p']);

/**
 * HDR (PQ / HLG) → SDR BT.709 tone-mapping chain. Requires the zscale and
 * tonemap filters (libzimg); availability is probed at runtime.
 */
export const HDR_TONEMAP_CHAIN = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

export interface EncodeContext {
  source: SourceProbe;
  threads?: number;
  capabilities?: FfmpegCapabilities;
}

export interface RenditionOutput {
  quality: string;
  /** Real encoded dimensions (probed from the produced playlist) */
  width: number;
  height: number;
  /** Declared video peak bitrate (maxrate) in kbps */
  videoBitrateKbps: number;
  /** Audio bitrate in kbps, 0 when no audio stream was mapped */
  audioBitrateKbps: number;
  hasAudio: boolean;
  codecTag: string;
  /** Peak bandwidth in bits/s for EXT-X-STREAM-INF */
  bandwidth: number;
  /** Measured average bandwidth in bits/s (total segment bytes / playlist duration) */
  averageBandwidth: number;
  fps: number;
  /** Playlist path relative to the asset's playback root */
  playlistPath: string;
  /** Total size of the produced segments in bytes */
  segmentBytes: number;
  /** True when the HDR tone-mapping chain was applied */
  toneMapped: boolean;
}

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

/** Whether the HDR → SDR chain should be applied for this source on this FFmpeg build. */
export function shouldToneMap(source: SourceProbe, capabilities?: FfmpegCapabilities): boolean {
  return source.isHdr && !!capabilities?.hdrToneMapping;
}

/**
 * Builds the -vf chain: optional HDR tone-mapping, then the caller's scale
 * expression, then (optionally) a forced 8-bit yuv420p output.
 */
export function buildVideoFilter(
  source: SourceProbe,
  capabilities: FfmpegCapabilities | undefined,
  opts: { scale?: string; extra?: string[]; forceYuv420p?: boolean } = {},
): string {
  const parts: string[] = [];
  if (shouldToneMap(source, capabilities)) parts.push(HDR_TONEMAP_CHAIN);
  if (opts.scale) parts.push(opts.scale);
  if (opts.extra) parts.push(...opts.extra);
  if (opts.forceYuv420p) parts.push('format=yuv420p');
  return parts.join(',');
}

/** Sanitised fps for GOP computations (falls back to 30 when unknown). */
export function effectiveFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 30;
  return Math.min(240, Math.max(1, fps));
}

/** Parses total duration and segment file names from an HLS media playlist. */
async function readMediaPlaylist(playlistPath: string): Promise<{ duration: number; segments: string[] }> {
  const content = await readFile(playlistPath, 'utf-8');
  let duration = 0;
  const segments: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF:')) {
      const value = parseFloat(line.slice('#EXTINF:'.length));
      if (Number.isFinite(value)) duration += value;
    } else if (line && !line.startsWith('#')) {
      segments.push(line);
    }
  }
  return { duration, segments };
}

export async function transcodeRendition(
  sourcePath: string,
  outputDir: string,
  profile: RenditionProfile,
  context: EncodeContext,
): Promise<RenditionOutput> {
  const { source, threads, capabilities } = context;
  if (source.videoStreamIndex === null) throw new Error('Source has no video stream');

  const renditionDir = path.join(outputDir, profile.quality);
  await mkdir(renditionDir, { recursive: true });

  // Dynamic timeout: 4x video duration (minimum 5 min)
  const timeoutMs = source.duration > 0
    ? Math.max(5 * 60_000, source.duration * 4_000)
    : undefined;

  const fps = effectiveFps(source.fps);
  const gop = Math.max(1, Math.round(fps * HLS_SEGMENT_SECONDS));
  const preset = MEDIUM_PRESET_QUALITIES.has(profile.quality) ? 'medium' : 'fast';
  const toneMapped = shouldToneMap(source, capabilities);
  const videoFilter = buildVideoFilter(source, capabilities, {
    scale: `scale=w=${profile.width}:h=${profile.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    forceYuv420p: true,
  });
  const hasAudio = source.audioStreamIndex !== null;
  const playlistFile = path.join(renditionDir, 'index.m3u8');

  await runFfmpeg([
    '-y',
    ...(threads ? ['-threads', String(threads)] : []),
    '-i', sourcePath,
    '-map', `0:${source.videoStreamIndex}`,
    ...(hasAudio ? ['-map', `0:${source.audioStreamIndex}`] : ['-an']),
    '-vf', videoFilter,
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', '23',
    '-maxrate', `${profile.bitrateKbps}k`,
    '-bufsize', `${profile.bitrateKbps * 2}k`,
    '-profile:v', profile.profile,
    '-level', profile.level,
    // Keyframes aligned to segment boundaries (and nowhere else)
    '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${AUDIO_BITRATE_KBPS}k`] : []),
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(renditionDir, 'segment_%03d.ts'),
    playlistFile,
  ], { timeoutMs, label: profile.quality });

  /* Measure what was actually produced */
  const dims = await probeOutputDimensions(playlistFile).catch(() => null)
    ?? await probeFirstSegment(renditionDir).catch(() => null);
  if (!dims) throw new Error(`Could not determine output dimensions for ${profile.quality}`);

  const { duration: playlistDuration, segments } = await readMediaPlaylist(playlistFile);
  let segmentBytes = 0;
  for (const segment of segments) {
    const s = await stat(path.join(renditionDir, segment)).catch(() => null);
    if (s) segmentBytes += s.size;
  }
  const effectiveDuration = playlistDuration > 0 ? playlistDuration : source.duration;
  const averageBandwidth = effectiveDuration > 0 ? Math.round((segmentBytes * 8) / effectiveDuration) : 0;
  const audioBitrateKbps = hasAudio ? AUDIO_BITRATE_KBPS : 0;
  const declaredPeak = (profile.bitrateKbps + audioBitrateKbps) * 1000;

  return {
    quality: profile.quality,
    width: dims.width,
    height: dims.height,
    videoBitrateKbps: profile.bitrateKbps,
    audioBitrateKbps,
    hasAudio,
    codecTag: profile.codecTag,
    // BANDWIDTH must be the peak; never advertise less than what was measured on average
    bandwidth: Math.max(declaredPeak, averageBandwidth),
    averageBandwidth: averageBandwidth || declaredPeak,
    fps,
    playlistPath: `${profile.quality}/index.m3u8`,
    segmentBytes,
    toneMapped,
  };
}

async function probeFirstSegment(renditionDir: string): Promise<{ width: number; height: number } | null> {
  const entries = (await readdir(renditionDir)).filter((f) => f.endsWith('.ts')).sort();
  if (entries.length === 0) return null;
  return probeOutputDimensions(path.join(renditionDir, entries[0]));
}

export async function extractPosterThumbnail(
  sourcePath: string,
  outputDir: string,
  context: EncodeContext,
): Promise<void> {
  const { source, capabilities } = context;
  if (source.videoStreamIndex === null) throw new Error('Source has no video stream');
  const posterTime = Math.max(0, Math.floor(source.duration * 0.25));
  await runFfmpeg([
    '-y',
    // Input seeking (before -i) avoids decoding everything up to the poster time
    '-ss', String(posterTime),
    '-i', sourcePath,
    '-map', `0:${source.videoStreamIndex}`,
    '-an',
    '-frames:v', '1',
    '-vf', buildVideoFilter(source, capabilities, { scale: 'scale=640:-2' }),
    '-q:v', '2',
    '-update', '1',
    path.join(outputDir, 'thumbnail.jpg'),
  ], { timeoutMs: 2 * 60_000, label: 'poster' });
}

/**
 * Creates ONE downloadable MP4 at `<outputDir>/download.mp4` by remuxing the
 * given (highest) rendition's HLS segments — no re-encoding.
 */
export async function createDownloadableMp4(
  outputDir: string,
  profile: Pick<RenditionProfile, 'quality'>,
  durationSec = 0,
): Promise<string> {
  const playlistPath = path.join(outputDir, profile.quality, 'index.m3u8');
  const target = path.join(outputDir, 'download.mp4');

  await runFfmpeg([
    '-y',
    '-i', playlistPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    target,
  ], { timeoutMs: Math.max(2 * 60_000, durationSec * 1000), label: 'download' });

  return target;
}

export async function createMasterPlaylist(
  outputDir: string,
  outputs: RenditionOutput[],
): Promise<void> {
  let content = '#EXTM3U\n#EXT-X-VERSION:3\n';
  for (const r of outputs) {
    const codecs = r.hasAudio ? `${r.codecTag},${AUDIO_CODEC_TAG}` : r.codecTag;
    const attrs = [
      `BANDWIDTH=${r.bandwidth}`,
      `AVERAGE-BANDWIDTH=${r.averageBandwidth}`,
      `RESOLUTION=${r.width}x${r.height}`,
      `CODECS="${codecs}"`,
    ];
    if (r.fps > 0) attrs.push(`FRAME-RATE=${(Math.round(r.fps * 1000) / 1000).toFixed(3)}`);
    content += `#EXT-X-STREAM-INF:${attrs.join(',')}\n`;
    content += `${r.playlistPath}\n`;
  }
  await writeFile(path.join(outputDir, 'master.m3u8'), content, 'utf-8');
}
