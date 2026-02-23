import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WhisperProvider, WhisperResult } from './whisper.js';

const WHISPER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Creates a Whisper provider compatible with any OpenAI-compatible endpoint.
 * Works with: OpenAI, Groq, local whisper servers, etc.
 */
export function createWhisperProvider(apiUrl: string, apiKey: string, model: string): WhisperProvider {
  return {
    async transcribe(audioPath: string): Promise<WhisperResult> {
      const audioBuffer = await readFile(audioPath);
      const fileName = path.basename(audioPath);

      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer]), fileName);
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
        throw new Error(`Whisper API error (${response.status}): ${errorText}`);
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
