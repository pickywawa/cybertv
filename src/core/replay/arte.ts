import { fetchJson } from '../net/http';
import type { ReplayItem, ReplayRail, ReplayShow, ResolvedStream } from './types';

/**
 * ARTE: the public "emac" API of arte.tv (pages, zones, collections) and its player config
 * (HLS up to 1080p, no DRM). Availability depends on the viewer's country (mostly Europe).
 */
const API = 'https://api.arte.tv/api';
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const arteLang = (lang: string) => (['fr', 'de', 'en', 'es', 'pl', 'it'].includes(lang) ? lang : 'fr');

const img = (u?: string, size = '940x530') => (u ? u.replace('__SIZE__', size) : undefined);

export function arteItem(x: Json): ReplayItem | null {
  const pid: string | undefined = x?.programId;
  if (!pid || !x.title) return null;
  const show = !!x.kind?.isCollection || /^RC-/.test(pid);
  if (!show && !x.player?.config && x.availability?.hasVideoStreams === false) return null;
  const end = x.availability?.end ? Date.parse(x.availability.end) : undefined;
  return {
    id: `arte:${pid}`,
    provider: 'arte',
    kind: show ? 'show' : 'video',
    title: x.title,
    subtitle: x.subtitle || undefined,
    desc: x.shortDescription || x.teaserText || undefined,
    image: img(x.mainImage?.url),
    durationSec: typeof x.duration === 'number' && x.duration > 0 ? x.duration : undefined,
    expires: end && !Number.isNaN(end) ? end : undefined,
    channel: 'ARTE',
    genre: x.genre?.label || x.kind?.label || undefined,
    age: typeof x.ageRating === 'number' ? x.ageRating : undefined,
  };
}

const PAGES: { code: string; label: string; max: number }[] = [
  { code: 'HOME', label: '', max: 14 },
  { code: 'CIN', label: 'Cinéma', max: 5 },
  { code: 'SER', label: 'Séries', max: 5 },
  { code: 'DOR', label: 'Documentaires', max: 4 },
];
const SKIP_ZONES = /^(favorites|resume-watching|genres_|playlists_)/;

function zoneRails(page: Json, label: string, max: number, seen: Set<string>): { rails: ReplayRail[]; hero: ReplayItem[] } {
  const rails: ReplayRail[] = [];
  const hero: ReplayItem[] = [];
  for (const z of page?.zones || []) {
    const data: Json[] = z?.content?.data || [];
    const ids = new Set<string>();
    const items = data.map(arteItem).filter((x): x is ReplayItem => !!x && !ids.has(x.id) && !!ids.add(x.id));
    const tpl: string = z?.displayOptions?.template || '';
    if (/slider|single|event-/.test(tpl)) {
      hero.push(...items.filter((i) => i.image));
      continue;
    }
    if (!tpl.startsWith('horizontal') || SKIP_ZONES.test(z.code || '') || items.length < 4) continue;
    const title = String(z.title || '').trim();
    const full = label && title.toLowerCase() !== label.toLowerCase() ? `${label} · ${title}` : title || label;
    if (seen.has(full.toLowerCase())) continue;
    seen.add(full.toLowerCase());
    rails.push({ id: `arte:${z.id || z.code}`, provider: 'arte', title: full, items });
    if (rails.length >= max) break;
  }
  return { rails, hero };
}

export async function arteCatalog(lang: string): Promise<{ rails: ReplayRail[]; hero: ReplayItem[] }> {
  const l = arteLang(lang);
  const pages = await Promise.all(PAGES.map((p) => fetchJson<Json>(`${API}/emac/v4/${l}/web/pages/${p.code}/`, 20000).catch(() => null)));
  if (!pages[0]) throw new Error('ARTE indisponible');
  const seen = new Set<string>();
  const rails: ReplayRail[] = [];
  const hero: ReplayItem[] = [];
  pages.forEach((page, i) => {
    if (!page) return;
    const r = zoneRails(page, PAGES[i].label, PAGES[i].max, seen);
    rails.push(...r.rails);
    if (i === 0) hero.push(...r.hero);
  });
  return { rails, hero };
}

/** a collection (series, saga): one list per season / part */
export async function arteShow(pid: string, lang: string): Promise<ReplayShow> {
  const l = arteLang(lang);
  const page = await fetchJson<Json>(`${API}/emac/v4/${l}/web/collections/${pid}/`, 20000);
  const head = (page?.zones || []).find((z: Json) => /single-collection/.test(z?.displayOptions?.template || ''))?.content?.data?.[0];
  const meta = page?.metadata || {};
  const seasons: ReplayShow['seasons'] = [];
  for (const z of page?.zones || []) {
    const items = ((z?.content?.data || []) as Json[]).map(arteItem).filter((x): x is ReplayItem => !!x && x.kind === 'video');
    if (!items.length || /single/.test(z?.displayOptions?.template || '')) continue;
    seasons.push({ title: String(z.title || meta.title || ''), items });
  }
  return {
    item: {
      id: `arte:${pid}`,
      provider: 'arte',
      kind: 'show',
      title: meta.title || head?.title || pid,
      desc: meta.description || head?.shortDescription,
      image: img(head?.mainImage?.url) || img(meta.images?.[0]?.url),
      channel: 'ARTE',
    },
    seasons,
  };
}

function pickStream(streams: Json[], lang: string): Json | undefined {
  const want = lang === 'de' ? /allemand|deutsch/i : /fran[cç]ais/i;
  return streams.find((s) => want.test(s?.versions?.[0]?.label || '')) || streams[0];
}

async function config(pid: string, lang: string): Promise<Json> {
  const c = await fetchJson<Json>(`${API}/player/v2/config/${arteLang(lang)}/${pid}`, 15000);
  return c?.data?.attributes;
}

export async function arteStream(pid: string, lang: string): Promise<ResolvedStream> {
  const a = await config(pid, lang);
  const s = pickStream(a?.streams || [], arteLang(lang));
  if (!s?.url) throw new Error(a?.restriction?.geoblocking?.restrictedArea ? 'geo' : 'unavailable');
  return { url: s.url, label: s.versions?.[0]?.label ? `ARTE · ${s.versions[0].label}` : 'ARTE' };
}

export async function arteInfo(pid: string, lang: string): Promise<ReplayItem> {
  const a = await config(pid, lang);
  const m = a?.metadata || {};
  const end = a?.rights?.end ? Date.parse(a.rights.end) : undefined;
  return {
    id: `arte:${pid}`,
    provider: 'arte',
    kind: 'video',
    title: m.title || pid,
    subtitle: m.subtitle || undefined,
    desc: m.description || undefined,
    image: m.images?.[0]?.url,
    durationSec: m.duration?.seconds || undefined,
    expires: end && !Number.isNaN(end) ? end : undefined,
    channel: 'ARTE',
  };
}
