import type { Source } from '../types';
import { normalizeServer } from './xtream';

export const normServer = (type: Source['type'], u: string) => (type === 'xtream' ? normalizeServer(u) : u.trim());

/** all servers of a source, the one in use first, then the others in the user's order */
export function serversOf(src: Pick<Source, 'url' | 'servers' | 'type'>): string[] {
  const all = (src.servers?.length ? src.servers : [src.url]).map((u) => normServer(src.type, u)).filter(Boolean);
  const cur = normServer(src.type, src.url);
  return [...new Set([cur, ...all])].filter(Boolean);
}

/** "http://a.example.com:8080/x" → "a.example.com:8080" */
export function serverLabel(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}
