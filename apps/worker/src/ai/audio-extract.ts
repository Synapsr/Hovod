import path from 'node:path';
import { runFfmpeg } from '../ffmpeg.js';

/**
 * Extracts audio from a video file as mono MP3 optimized for Whisper.
 * - 16kHz sample rate (Whisper's native rate)
 * - 64kbps bitrate (~0.48 MB/min, keeps files under API limits)
 * - Mono channel (speech doesn't need stereo)
 */
export async function extractAudio(sourcePath: string, outputDir: string): Promise<string> {
  const audioPath = path.join(outputDir, 'audio.mp3');

  await runFfmpeg([
    '-y',
    '-i', sourcePath,
    '-vn',                  // strip video
    '-acodec', 'libmp3lame',
    '-b:a', '64k',
    '-ar', '16000',         // 16kHz
    '-ac', '1',             // mono
    audioPath,
  ]);

  return audioPath;
}
