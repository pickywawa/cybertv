export interface M3uEntry {
  name: string;
  url: string;
  attrs: Record<string, string>;
  duration: number;
}

export interface M3uHeader {
  epgUrls: string[];
  attrs: Record<string, string>;
}

const ATTR_RE = /([\w-]+)=("([^"]*)"|'([^']*)'|([^\s,]+))/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) out[m[1].toLowerCase()] = (m[3] ?? m[4] ?? m[5] ?? '').trim();
  return out;
}

/** Index of the comma separating attributes from the display name (outside quotes) */
function titleComma(line: string): number {
  let q = false;
  for (let i = 8; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) return i;
  }
  return -1;
}

/**
 * Streaming M3U parser: feed lines, get entries via callback. Handles #EXTINF, #EXTGRP,
 * #EXTVLCOPT (ignored), header url-tvg/x-tvg-url.
 */
export class M3uParser {
  header: M3uHeader = { epgUrls: [], attrs: {} };
  private pending: Omit<M3uEntry, 'url'> | null = null;
  private group: string | undefined;
  count = 0;

  constructor(private onEntry: (e: M3uEntry) => void) {}

  push(raw: string) {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#EXTM3U')) {
      const attrs = parseAttrs(line.slice(7));
      this.header.attrs = attrs;
      const epg = attrs['url-tvg'] || attrs['x-tvg-url'] || attrs['tvg-url'];
      if (epg) this.header.epgUrls.push(...epg.split(',').map((s) => s.trim()).filter(Boolean));
      return;
    }
    if (line.startsWith('#EXTINF')) {
      const ci = titleComma(line);
      const head = ci >= 0 ? line.slice(8, ci) : line.slice(8);
      const name = ci >= 0 ? line.slice(ci + 1).trim() : '';
      const dm = head.match(/^\s*(-?\d+(?:\.\d+)?)/);
      const attrs = parseAttrs(head);
      this.pending = { name: name || attrs['tvg-name'] || '', attrs, duration: dm ? parseFloat(dm[1]) : -1 };
      this.group = undefined;
      return;
    }
    if (line.startsWith('#EXTGRP:')) {
      this.group = line.slice(8).trim();
      return;
    }
    if (line.startsWith('#')) return;
    if (this.pending) {
      const e: M3uEntry = { ...this.pending, url: line };
      if (!e.attrs['group-title'] && this.group) e.attrs['group-title'] = this.group;
      this.pending = null;
      this.count++;
      this.onEntry(e);
    }
  }
}

export type M3uKind = 'live' | 'movie' | 'episode';

export function classifyEntry(e: M3uEntry): M3uKind {
  const u = e.url.toLowerCase();
  if (/\/series\//.test(u)) return 'episode';
  if (/\/movies?\//.test(u)) return 'movie';
  const ext = u.split('?')[0].split('.').pop() || '';
  if (['mp4', 'mkv', 'avi', 'mov', 'm4v', 'wmv', 'webm'].includes(ext)) {
    return /S\d{1,2}\s*E\d{1,3}/i.test(e.name) ? 'episode' : 'movie';
  }
  return 'live';
}

/** "http://h:p/live/u/p/123.ts" -> Xtream-style parts (for catch-up on M3U from Xtream panels) */
export function xtreamPartsFromUrl(url: string): { server: string; user: string; pass: string; id: string } | null {
  const m = url.match(/^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(?:\.\w+)?$/);
  return m ? { server: m[1], user: m[2], pass: m[3], id: m[4] } : null;
}
