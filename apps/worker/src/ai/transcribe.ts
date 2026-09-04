import { probeDuration } from '../ffmpeg.js';
import type { WhisperProvider, WhisperResult, WhisperSegment } from './providers/whisper.js';

/**
 * Shifts every timestamp of a chunk result by `offset` seconds and renumbers
 * segment ids so the merged transcript is monotonic.
 */
export function offsetResult(result: WhisperResult, offset: number, firstId: number): WhisperSegment[] {
  return result.segments.map((s, i) => ({
    id: firstId + i,
    start: s.start + offset,
    end: s.end + offset,
    text: s.text,
    words: s.words?.map((w) => ({ word: w.word, start: w.start + offset, end: w.end + offset })),
  }));
}

/** Merges per-chunk results (already offset) into a single transcript. */
export function mergeResults(parts: { result: WhisperResult; offset: number }[]): WhisperResult {
  const segments: WhisperSegment[] = [];
  const texts: string[] = [];
  const languages = new Map<string, number>();
  let duration = 0;

  for (const { result, offset } of parts) {
    segments.push(...offsetResult(result, offset, segments.length));
    const text = result.text.trim();
    if (text) texts.push(text);
    if (result.language && result.language !== 'unknown') {
      languages.set(result.language, (languages.get(result.language) ?? 0) + 1);
    }
    duration = Math.max(duration, offset + (result.duration || 0));
  }

  let language = 'unknown';
  let best = 0;
  for (const [lang, count] of languages) {
    if (count > best) { best = count; language = lang; }
  }
  if (segments.length > 0) duration = Math.max(duration, segments[segments.length - 1].end);

  return { language, duration, text: texts.join(' '), segments };
}

/**
 * Transcribes an ordered list of audio chunks sequentially, offsetting each
 * chunk's timestamps by the real (probed) duration of the chunks before it.
 */
export async function transcribeChunks(provider: WhisperProvider, chunkPaths: string[], fallbackChunkSeconds: number): Promise<WhisperResult> {
  const parts: { result: WhisperResult; offset: number }[] = [];
  let offset = 0;

  for (let i = 0; i < chunkPaths.length; i++) {
    const chunkPath = chunkPaths[i];
    if (chunkPaths.length > 1) console.log(`[ai] Transcribing chunk ${i + 1}/${chunkPaths.length}...`);
    const result = await provider.transcribe(chunkPath);
    parts.push({ result, offset });

    const probed = await probeDuration(chunkPath).catch(() => 0);
    offset += probed > 0 ? probed : (result.duration > 0 ? result.duration : fallbackChunkSeconds);
  }

  return parts.length === 1 && parts[0].offset === 0 ? parts[0].result : mergeResults(parts);
}
