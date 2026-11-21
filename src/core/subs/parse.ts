export interface Cue {
  start: number; // seconds
  end: number;
  text: string; // line breaks kept, <i>/<b>/<u> kept, everything else escaped
}

const time = (s: string): number => {
  const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/);
  if (!m) return NaN;
  return parseInt(m[1] || '0', 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, '0'), 10) / 1000;
};

/** keeps <i>, <b>, <u>; escapes everything else (subtitles come from the Internet) */
export function sanitize(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>')
    .replace(/\{\\an?\d+\}/g, '') // ASS position tags left in SRT
    .replace(/&lt;\/?font[^&]*&gt;/gi, '');
}

/** SRT or WebVTT → cues sorted by start */
export function parseSubtitles(raw: string): Cue[] {
  const src = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues: Cue[] = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = time(a);
    const end = time(b);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = lines.slice(i + 1).join('\n').trim();
    if (text) cues.push({ start, end, text: sanitize(text) });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** cues visible at `t` (binary search on start, then scan back for overlaps) */
export function cuesAt(cues: Cue[], t: number): Cue[] {
  let lo = 0;
  let hi = cues.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const out: Cue[] = [];
  for (let k = idx; k >= 0 && k > idx - 8; k--) if (cues[k].end > t) out.unshift(cues[k]);
  return out;
}
