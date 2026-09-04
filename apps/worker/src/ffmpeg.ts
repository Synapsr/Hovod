import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour default
const STDERR_RING_SIZE = 40;
const MAX_ERROR_LENGTH = 900;
const PROGRESS_LOG_INTERVAL_MS = 10_000;

export interface RunFfmpegOptions {
  timeoutMs?: number;
  /** Short label used as log prefix, e.g. "720p" */
  label?: string;
}

/** Lines that carry no diagnostic value when picking an error message. */
function isNoiseLine(line: string): boolean {
  const l = line.trim();
  if (!l) return true;
  if (/^(frame|size|video|audio|Lsize)=/.test(l)) return true;
  if (/^(Press \[q\]|Conversion failed!|Exiting normally)/.test(l)) return true;
  if (/^\s*(configuration|libav|libsw|libpost|built with)/.test(l)) return true;
  if (/^(Input|Output) #\d+/.test(l) || /^\s+(Stream|Metadata|Duration|Program|Side data|encoder|handler_name|title|creation_time|vendor_id|language|major_brand|minor_version|compatible_brands|comment|timecode)/.test(l)) return true;
  // libx264 end-of-encode statistics and muxer chatter
  if (/^\[libx264 @ [^\]]+\] (using|profile|frame [IPB]:|mb [IPB]|8x8 transform|coded y|i16|i8|i4|ref [PB]|Weighted|kb\/s:|consecutive|direct|final ratefactor|Qavg)/.test(l)) return true;
  if (/^\[(hls|mp4|mov|segment) @ [^\]]+\] Opening/.test(l)) return true;
  return false;
}

/**
 * Picks the most meaningful diagnostic line from FFmpeg's stderr tail:
 * prefers lines that look like errors, otherwise the last non-noise line.
 */
export function pickErrorLine(lines: string[]): string | null {
  const candidates = lines.filter((l) => !isNoiseLine(l));
  if (candidates.length === 0) return null;
  const errorish = candidates.filter((l) => /error|invalid|failed|unsupported|not found|no such|unable|cannot|could not|denied|too large|corrupt|no space/i.test(l));
  const pick = errorish.length > 0 ? errorish[errorish.length - 1] : candidates[candidates.length - 1];
  return pick.trim().slice(0, MAX_ERROR_LENGTH);
}

export async function runFfmpeg(args: string[], timeoutMsOrOptions?: number | RunFfmpegOptions): Promise<void> {
  const options: RunFfmpegOptions = typeof timeoutMsOrOptions === 'number'
    ? { timeoutMs: timeoutMsOrOptions }
    : (timeoutMsOrOptions ?? {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prefix = options.label ? `[ffmpeg:${options.label}]` : '[ffmpeg]';

  return new Promise<void>((resolve, reject) => {
    // warnings/errors only (kept in the ring buffer for error reporting) + periodic progress stats
    const proc = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'warning', '-stats', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let killed = false;
    let killTimer: NodeJS.Timeout | null = null;
    const ring: string[] = [];
    let lastProgressLog = 0;
    let partial = '';

    const pushLine = (line: string) => {
      const trimmed = line.trimEnd();
      if (!trimmed) return;
      ring.push(trimmed);
      if (ring.length > STDERR_RING_SIZE) ring.shift();

      // Progress lines are emitted very frequently — throttle them in the logs
      if (/^(frame|size)=/.test(trimmed)) {
        const now = Date.now();
        if (now - lastProgressLog >= PROGRESS_LOG_INTERVAL_MS) {
          lastProgressLog = now;
          console.log(`${prefix} ${trimmed}`);
        }
        return;
      }
      if (!isNoiseLine(trimmed)) console.log(`${prefix} ${trimmed}`);
    };

    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      partial += chunk;
      // FFmpeg uses \r for progress updates and \n for regular lines
      const parts = partial.split(/\r\n|\r|\n/);
      partial = parts.pop() ?? '';
      for (const part of parts) pushLine(part);
    });

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      // Force kill after 5s if SIGTERM doesn't work
      killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000);
      reject(new Error(`FFmpeg process timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (partial) pushLine(partial);
      if (killed) return; // Already rejected by timeout
      if (code === 0) return resolve();

      const detail = pickErrorLine(ring);
      const base = code === null ? `FFmpeg was killed by signal ${signal}` : `FFmpeg exited with code ${code}`;
      reject(new Error(detail ? `${base}: ${detail}`.slice(0, MAX_ERROR_LENGTH) : base));
    });
  });
}

/* ─── ffprobe ────────────────────────────────────────────── */

export interface SourceProbe {
  /** Display width after applying rotation metadata (0 when no video stream) */
  width: number;
  /** Display height after applying rotation metadata (0 when no video stream) */
  height: number;
  duration: number;
  /** Frames per second of the chosen video stream (0 when unknown) */
  fps: number;
  /** Absolute stream index of the chosen video stream, or null when none */
  videoStreamIndex: number | null;
  /** Absolute stream index of the first audio stream, or null when none */
  audioStreamIndex: number | null;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number;
  pixFmt: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  /** True when color_transfer is PQ (smpte2084) or HLG (arib-std-b67) */
  isHdr: boolean;
  /** Rotation in degrees from stream side data / tags (0, 90, 180, 270) */
  rotation: number;
}

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  color_transfer?: string;
  color_primaries?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
  side_data_list?: { side_data_type?: string; rotation?: number }[];
  tags?: { rotate?: string };
}

function parseFps(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split('/').map(Number);
  if (!num || !den || !Number.isFinite(num) || !Number.isFinite(den)) return 0;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

function parseRotation(stream: FfprobeStream): number {
  let rotation = 0;
  const sideData = stream.side_data_list?.find((s) => typeof s.rotation === 'number');
  if (sideData && typeof sideData.rotation === 'number') rotation = sideData.rotation;
  else if (stream.tags?.rotate) rotation = Number(stream.tags.rotate) || 0;
  rotation = Math.round(rotation) % 360;
  if (rotation < 0) rotation += 360;
  return rotation;
}

function runFfprobe(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', ['-v', 'error', '-of', 'json', ...args]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`Failed to start ffprobe: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim().split('\n').filter(Boolean).pop();
        return reject(new Error(`ffprobe exited with code ${code}${detail ? `: ${detail.slice(0, 300)}` : ''}`));
      }
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch {
        reject(new Error('Failed to parse ffprobe output'));
      }
    });
  });
}

/**
 * Probes every stream of the source and picks the first real video stream
 * (skipping embedded cover art / attached pictures) plus the first audio stream.
 */
export async function ffprobe(filePath: string): Promise<SourceProbe> {
  const data = await runFfprobe(['-show_streams', '-show_format', filePath]) as {
    streams?: FfprobeStream[];
    format?: { duration?: string };
  };
  const streams = data.streams ?? [];

  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic === 1));
  const audio = streams.find((s) => s.codec_type === 'audio');

  const durationCandidates = [video?.duration, data.format?.duration, audio?.duration]
    .map((d) => parseFloat(d ?? ''))
    .filter((d) => Number.isFinite(d) && d > 0);
  const duration = durationCandidates[0] ?? 0;

  const rotation = video ? parseRotation(video) : 0;
  const swap = rotation === 90 || rotation === 270;
  const rawWidth = video?.width ?? 0;
  const rawHeight = video?.height ?? 0;
  const colorTransfer = video?.color_transfer ?? null;

  return {
    width: swap ? rawHeight : rawWidth,
    height: swap ? rawWidth : rawHeight,
    duration,
    fps: video ? (parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate)) : 0,
    videoStreamIndex: typeof video?.index === 'number' ? video.index : null,
    audioStreamIndex: typeof audio?.index === 'number' ? audio.index : null,
    hasAudio: !!audio,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    audioChannels: audio?.channels ?? 0,
    pixFmt: video?.pix_fmt ?? null,
    colorTransfer,
    colorPrimaries: video?.color_primaries ?? null,
    isHdr: colorTransfer === 'smpte2084' || colorTransfer === 'arib-std-b67',
    rotation,
  };
}

/** Probes the actual dimensions of an encoded output (HLS playlist or segment). */
export async function probeOutputDimensions(filePath: string): Promise<{ width: number; height: number } | null> {
  const data = await runFfprobe(['-select_streams', 'v:0', '-show_entries', 'stream=width,height', filePath]) as {
    streams?: { width?: number; height?: number }[];
  };
  const stream = data.streams?.find((s) => s.width && s.height);
  if (!stream || !stream.width || !stream.height) return null;
  return { width: stream.width, height: stream.height };
}

/** Probes the duration (seconds) of a media file, 0 when unknown. */
export async function probeDuration(filePath: string): Promise<number> {
  const data = await runFfprobe(['-show_entries', 'format=duration', filePath]) as { format?: { duration?: string } };
  const d = parseFloat(data.format?.duration ?? '');
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/* ─── Runtime capability probe ───────────────────────────── */

export interface FfmpegCapabilities {
  zscale: boolean;
  tonemap: boolean;
  /** True when the full HDR → SDR tone-mapping chain can be used */
  hdrToneMapping: boolean;
  version: string;
}

let capabilitiesPromise: Promise<FfmpegCapabilities> | null = null;

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => resolve(out));
  });
}

/**
 * Detects which filters the runtime FFmpeg build provides. Runs once and is
 * cached for the lifetime of the process.
 */
export function getFfmpegCapabilities(): Promise<FfmpegCapabilities> {
  if (!capabilitiesPromise) {
    capabilitiesPromise = (async () => {
      let filters = '';
      let version = 'unknown';
      try {
        filters = await runCapture('ffmpeg', ['-hide_banner', '-filters']);
      } catch (err) {
        console.warn(`[ffmpeg] Capability probe failed: ${(err as Error).message}`);
      }
      try {
        const v = await runCapture('ffmpeg', ['-version']);
        version = v.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown';
      } catch { /* ignore */ }

      const hasFilter = (name: string) => new RegExp(`^\\s*[.A-Z]{2,3}\\s+${name}\\s`, 'm').test(filters);
      const zscale = hasFilter('zscale');
      const tonemap = hasFilter('tonemap');
      return { zscale, tonemap, hdrToneMapping: zscale && tonemap, version };
    })();
  }
  return capabilitiesPromise;
}
