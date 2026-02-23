import { env } from '../env.js';
import { createWhisperProvider } from './providers/openai-whisper.js';
import { createOpenAiLlmProvider } from './providers/openai-llm.js';
import { createAnthropicLlmProvider } from './providers/anthropic-llm.js';
import type { WhisperProvider } from './providers/whisper.js';
import type { LlmProvider } from './providers/llm.js';

/** Whether AI transcription is configured and enabled */
export function isAiConfigured(): boolean {
  return env.AI_ENABLED && !!env.WHISPER_API_URL && !!env.WHISPER_API_KEY;
}

/** Whether LLM chaptering is configured */
export function isChapteringConfigured(): boolean {
  return !!env.LLM_PROVIDER && !!env.LLM_API_KEY && !!env.LLM_MODEL;
}

/** Create a Whisper provider from env vars */
export function createWhisper(): WhisperProvider {
  if (!env.WHISPER_API_URL || !env.WHISPER_API_KEY) {
    throw new Error('Whisper API not configured (WHISPER_API_URL and WHISPER_API_KEY required)');
  }
  return createWhisperProvider(env.WHISPER_API_URL, env.WHISPER_API_KEY, env.WHISPER_MODEL);
}

/** Create an LLM provider from env vars */
export function createLlm(): LlmProvider {
  if (!env.LLM_PROVIDER || !env.LLM_API_KEY || !env.LLM_MODEL) {
    throw new Error('LLM not configured (LLM_PROVIDER, LLM_API_KEY, and LLM_MODEL required)');
  }

  switch (env.LLM_PROVIDER) {
    case 'openai':
    case 'custom':
      return createOpenAiLlmProvider(env.LLM_API_KEY, env.LLM_MODEL, env.LLM_API_URL);
    case 'groq':
      return createOpenAiLlmProvider(env.LLM_API_KEY, env.LLM_MODEL, env.LLM_API_URL ?? 'https://api.groq.com/openai/v1');
    case 'anthropic':
      return createAnthropicLlmProvider(env.LLM_API_KEY, env.LLM_MODEL, env.LLM_API_URL);
    default:
      throw new Error(`Unknown LLM provider: ${env.LLM_PROVIDER}`);
  }
}
