import type { WhisperResult } from './providers/whisper.js';

/** Format seconds to WebVTT timestamp (HH:MM:SS.mmm) */
function formatVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return (
    h.toString().padStart(2, '0') + ':' +
    m.toString().padStart(2, '0') + ':' +
    s.toString().padStart(2, '0') + '.' +
    ms.toString().padStart(3, '0')
  );
}

/** Generate a WebVTT subtitle file from Whisper transcription segments */
export function generateVtt(result: WhisperResult): string {
  let vtt = 'WEBVTT\n\n';

  for (const segment of result.segments) {
    const text = segment.text.trim();
    if (!text) continue;

    vtt += `${formatVttTime(segment.start)} --> ${formatVttTime(segment.end)}\n`;
    vtt += `${text}\n\n`;
  }

  return vtt;
}
