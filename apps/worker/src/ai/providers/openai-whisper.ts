import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WhisperProvider, WhisperResult } from './whisper.js';

const WHISPER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** File-backed Blob (streamed from disk) with an in-memory fallback for old runtimes. */
async function fileBlob(filePath: string): Promise<Blob> {
  if (typeof openAsBlob === 'function') {
    return openAsBlob(filePath, { type: 'audio/mpeg' });
  }
  return new Blob([await readFile(filePath)], { type: 'audio/mpeg' });
}

/**
 * Creates a Whisper provider compatible with any OpenAI-compatible endpoint.
 * Works with: OpenAI, Groq, local whisper servers, etc.
 *
 * `transcribe` handles ONE audio file (≤ 25 MB); long sources are split into
 * chunks by the caller (see ai/transcribe.ts) and merged afterwards.
 */
export function createWhisperProvider(apiUrl: string, apiKey: string, model: string): WhisperProvider {
  return {
    async transcribe(audioPath: string): Promise<WhisperResult> {
      const fileName = path.basename(audioPath);

      const formData = new FormData();
      formData.append('file', await fileBlob(audioPath), fileName);
      formData.append('model', model);
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'segment');

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Whisper API error (${response.status}): ${errorText.slice(0, 500)}`);
      }

      const data = await response.json();

      return {
        language: data.language ?? 'unknown',
        duration: data.duration ?? 0,
        text: data.text ?? '',
        segments: (data.segments ?? []).map((s: Record<string, unknown>, i: number) => ({
          id: (s.id as number) ?? i,
          start: (s.start as number) ?? 0,
          end: (s.end as number) ?? 0,
          text: (s.text as string) ?? '',
          words: s.words as { word: string; start: number; end: number }[] | undefined,
        })),
      };
    },
  };
}
