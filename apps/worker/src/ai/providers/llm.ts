/** LLM provider interface for chapter generation */

export interface Chapter {
  title: string;
  startTime: number;
  endTime: number;
}

export interface LlmProvider {
  generateChapters(transcript: string, durationSec: number): Promise<Chapter[]>;
}
