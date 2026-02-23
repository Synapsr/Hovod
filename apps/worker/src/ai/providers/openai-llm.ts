import type { LlmProvider, Chapter } from './llm.js';

const LLM_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';

const SYSTEM_PROMPT = `You are a video chapter generator. Given a transcript of a video, identify the main topics and generate chapters.

Rules:
- Output valid JSON: {"chapters":[{"title":"...","startTime":0,"endTime":45.5},...]}
- Generate between 3 and 10 chapters depending on the video length and content
- Titles should be concise (3-8 words), descriptive, and in the same language as the transcript
- Chapters must cover the entire video: the first chapter starts at 0, the last chapter ends at the total duration
- Chapters must not overlap and must be contiguous (each chapter's endTime equals the next chapter's startTime)
- Do not include generic titles like "Introduction" or "Conclusion" unless the content warrants it`;

/**
 * Creates an LLM provider compatible with any OpenAI-compatible chat completions endpoint.
 * Works with: OpenAI, Groq, Together, local LLM servers, etc.
 */
export function createOpenAiLlmProvider(apiKey: string, model: string, apiUrl?: string): LlmProvider {
  const baseUrl = apiUrl || DEFAULT_OPENAI_URL;

  return {
    async generateChapters(transcript: string, durationSec: number): Promise<Chapter[]> {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Generate chapters for this ${Math.round(durationSec)}s video.\n\nTranscript:\n${transcript}`,
            },
          ],
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`LLM API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('LLM returned empty response');

      const parsed = JSON.parse(content);
      const chapters: Chapter[] = parsed.chapters;

      if (!Array.isArray(chapters) || chapters.length === 0) {
        throw new Error('LLM returned invalid chapters format');
      }

      return chapters.map((ch) => ({
        title: String(ch.title),
        startTime: Number(ch.startTime),
        endTime: Number(ch.endTime),
      }));
    },
  };
}
