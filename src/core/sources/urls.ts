import type { Channel, Source } from '../types';
import { normalizeServer } from './xtream';
import { xtreamPartsFromUrl } from './m3u';

export interface Secrets {
  /** sourceId -> password */
  [sourceId: string]: string | undefined;
}

export type Engine = 'native' | 'web';

function liveExt(src: Source, engine: Engine, preferHls: boolean): string {
  const f = src.account?.formats;
  if (engine === 'web' || preferHls) return !f || f.includes('m3u8') ? 'm3u8' : 'ts';
  return !f || f.includes('ts') ? 'ts' : 'm3u8';
}

/** `preferHls`: the local live buffer only records HLS, so ask Xtream for its m3u8 output */
export function liveUrl(ch: Channel, src: Source, pass: string | undefined, engine: Engine, preferHls = false): string {
  if (src.type === 'm3u') return ch.url!;
  return `${normalizeServer(src.url)}/live/${src.username}/${pass}/${ch.extId}.${liveExt(src, engine, preferHls)}`;
}

export function movieUrl(extId: string, ext: string, src: Source, pass?: string, direct?: string): string {
  if (src.type === 'm3u') return direct!;
  return `${normalizeServer(src.url)}/movie/${src.username}/${pass}/${extId}.${ext || 'mp4'}`;
}

export function episodeUrl(extId: string, ext: string, src: Source, pass?: string, direct?: string): string {
  if (src.type === 'm3u') return direct!;
  return `${normalizeServer(src.url)}/series/${src.username}/${pass}/${extId}.${ext || 'mp4'}`;
}

/** Wall-clock parts of `ts` in `timeZone` (server tz for Xtream timeshift) */
function partsInTz(ts: number, timeZone?: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { Y: p.year, m: p.month, d: p.day, H: p.hour, M: p.minute, S: p.second };
}

export function canCatchup(ch: Channel): boolean {
  return ch.catchupDays > 0 && !!ch.catchupMode;
}

/**
 * Build a catch-up url for [start, stop] (ms). Returns null if unsupported.
 */
export function catchupUrl(ch: Channel, src: Source, pass: string | undefined, start: number, stop: number): string | null {
  if (!canCatchup(ch)) return null;
  const durMin = Math.max(1, Math.ceil((stop - start) / 60000));
  const nowS = Math.floor(Date.now() / 1000);
  const startS = Math.floor(start / 1000);
  const stopS = Math.floor(stop / 1000);

  const xc = (server: string, user: string, pw: string, id: string, tz?: string) => {
    const p = partsInTz(start, tz);
    return `${normalizeServer(server)}/timeshift/${user}/${pw}/${durMin}/${p.Y}-${p.m}-${p.d}:${p.H}-${p.M}/${id}.ts`;
  };

  if (src.type === 'xtream') return xc(src.url, src.username!, pass || '', ch.extId, src.account?.timezone);

  const url = ch.url || '';
  switch (ch.catchupMode) {
    case 'xc': {
      const parts = xtreamPartsFromUrl(url);
      return parts ? xc(parts.server, parts.user, parts.pass, parts.id) : null;
    }
    case 'shift':
      return `${url}${url.includes('?') ? '&' : '?'}utc=${startS}&lutc=${nowS}`;
    case 'flussonic': {
      const m = url.match(/^(.*)\/(?:index|video|mono)[^/]*\.(m3u8|ts)(\?.*)?$/);
      if (m) return `${m[1]}/archive-${startS}-${durMin * 60}.${m[2]}${m[3] || ''}`;
      return `${url.replace(/\/$/, '')}/timeshift_abs-${startS}.ts`;
    }
    case 'default':
    case 'append': {
      if (!ch.catchupSource) return ch.catchupMode === 'append' ? null : null;
      const p = partsInTz(start, 'UTC');
      const e = partsInTz(stop, 'UTC');
      let s = ch.catchupSource
        .replace(/\$\{start\}|\{utc\}|\{start\}|\{timestamp\}/g, String(startS))
        .replace(/\$\{end\}|\{utcend\}|\{end\}/g, String(stopS))
        .replace(/\$\{timestamp\}|\{lutc\}|\{now\}/g, String(nowS))
        .replace(/\$\{duration\}|\{duration\}/g, String(stopS - startS))
        .replace(/\$\{offset\}|\{offset\}/g, String(nowS - startS))
        .replace(/\{Y\}/g, p.Y).replace(/\{m\}/g, p.m).replace(/\{d\}/g, p.d)
        .replace(/\{H\}/g, p.H).replace(/\{M\}/g, p.M).replace(/\{S\}/g, p.S)
        .replace(/\{utc:YmdHMS\}/g, `${p.Y}${p.m}${p.d}${p.H}${p.M}${p.S}`)
        .replace(/\{utcend:YmdHMS\}/g, `${e.Y}${e.m}${e.d}${e.H}${e.M}${e.S}`);
      return ch.catchupMode === 'append' ? url + s : s;
    }
  }
  return null;
}
