/** Whisper-compatible transcription provider interface */

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface WhisperSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: WhisperWord[];
}

export interface WhisperResult {
  language: string;
  duration: number;
  text: string;
  segments: WhisperSegment[];
}

export interface WhisperProvider {
  transcribe(audioPath: string): Promise<WhisperResult>;
}
