import type { LlmProvider, Chapter } from './llm.js';

const LLM_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const DEFAULT_ANTHROPIC_URL = 'https://api.anthropic.com/v1';

const SYSTEM_PROMPT = `You are a video chapter generator. Given a transcript of a video, identify the main topics and generate chapters.

Rules:
- Output ONLY valid JSON: {"chapters":[{"title":"...","startTime":0,"endTime":45.5},...]}
- Generate between 3 and 10 chapters depending on the video length and content
- Titles should be concise (3-8 words), descriptive, and in the same language as the transcript
- Chapters must cover the entire video: the first chapter starts at 0, the last chapter ends at the total duration
- Chapters must not overlap and must be contiguous (each chapter's endTime equals the next chapter's startTime)
- Do not include generic titles like "Introduction" or "Conclusion" unless the content warrants it
- Respond with ONLY the JSON object, no other text`;

/**
 * Creates an LLM provider for the Anthropic Messages API.
 */
export function createAnthropicLlmProvider(apiKey: string, model: string, apiUrl?: string): LlmProvider {
  const baseUrl = apiUrl || DEFAULT_ANTHROPIC_URL;

  return {
    async generateChapters(transcript: string, durationSec: number): Promise<Chapter[]> {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [
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
        throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const textBlock = data.content?.find((b: { type: string }) => b.type === 'text');
      if (!textBlock?.text) throw new Error('Anthropic returned empty response');

      // Extract JSON from the response (may contain markdown code blocks)
      const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Anthropic response contains no JSON');

      const parsed = JSON.parse(jsonMatch[0]);
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
