import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg } from '../ffmpeg.js';

/**
 * Whisper-compatible APIs cap uploads at 25 MB. At 64 kbps mono MP3 a
 * 10-minute chunk is ~4.8 MB, comfortably under the limit.
 */
export const AUDIO_CHUNK_SECONDS = 600;

export interface ExtractAudioOptions {
  /** Source duration in seconds — used to derive the FFmpeg timeout */
  durationSec?: number;
  /** Absolute index of the audio stream to extract (defaults to the best audio stream) */
  audioStreamIndex?: number | null;
  /** Chunk length in seconds (defaults to AUDIO_CHUNK_SECONDS) */
  chunkSeconds?: number;
}

/**
 * Extracts audio from a video file as mono MP3 optimized for Whisper, split
 * into ≤ `chunkSeconds` chunks with the segment muxer so every upload stays
 * under the API size limit.
 * - 16kHz sample rate (Whisper's native rate)
 * - 64kbps bitrate (~0.48 MB/min)
 * - Mono channel (speech doesn't need stereo)
 *
 * Returns the ordered list of chunk paths.
 */
export async function extractAudio(sourcePath: string, outputDir: string, opts: ExtractAudioOptions = {}): Promise<string[]> {
  const chunkSeconds = opts.chunkSeconds ?? AUDIO_CHUNK_SECONDS;
  const durationSec = opts.durationSec ?? 0;
  const pattern = path.join(outputDir, 'audio_%03d.mp3');

  await runFfmpeg([
    '-y',
    '-i', sourcePath,
    ...(typeof opts.audioStreamIndex === 'number' ? ['-map', `0:${opts.audioStreamIndex}`] : ['-map', '0:a:0']),
    '-vn',                  // strip video
    '-acodec', 'libmp3lame',
    '-b:a', '64k',
    '-ar', '16000',         // 16kHz
    '-ac', '1',             // mono
    '-f', 'segment',
    '-segment_time', String(chunkSeconds),
    '-reset_timestamps', '1',
    pattern,
  ], { timeoutMs: Math.max(5 * 60_000, durationSec * 2_000), label: 'audio' });

  const files = (await readdir(outputDir))
    .filter((f) => /^audio_\d{3}\.mp3$/.test(f))
    .sort();
  if (files.length === 0) throw new Error('Audio extraction produced no output');
  return files.map((f) => path.join(outputDir, f));
}
