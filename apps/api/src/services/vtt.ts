interface Segment {
  start: number;
  end: number;
  text: string;
}

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

/** Generate a WebVTT subtitle string from transcript segments */
export function generateVttFromSegments(segments: Segment[]): string {
  let vtt = 'WEBVTT\n\n';
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    vtt += `${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}\n${text}\n\n`;
  }
  return vtt;
}
