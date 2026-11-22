import { fetchJson } from '../net/http';
import type { ReplayItem, ReplayRail, ReplayShow, ResolvedStream } from './types';

/**
 * france.tv: the catalogue API used by its mobile apps (channel pages, programs) and the
 * video service used by its players (k7 + Akamai token). Asking as an iOS device returns
 * HLS without DRM for nearly every free video and for the live channels. Mostly France-only.
 */
const YATTA = 'https://api-mobile.yatta.francetv.fr';
const K7 = 'https://k7.ftven.fr/videos/';
const TOKEN = 'https://hdfauth.ftven.fr/esi/TA?format=json';
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const FTV_CHANNELS: { path: string; label: string }[] = [
  { path: 'france-2', label: 'France 2' },
  { path: 'france-3', label: 'France 3' },
  { path: 'france-5', label: 'France 5' },
  { path: 'france-4', label: 'France 4' },
  { path: 'lcp', label: 'LCP' },
  { path: 'public-senat', label: 'Public Sénat' },
];

function picture(images: Json[] | undefined, types = ['vignette_16x9', 'background_16x9', 'carre']): string | undefined {
  for (const type of types) {
    const urls = images?.find((i) => i?.type === type)?.urls;
    if (!urls) continue;
    return urls['w:800'] || urls['w:1024'] || (Object.values(urls)[0] as string | undefined);
  }
  return undefined;
}

const plain = (html?: string) =>
  html ? html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s{2,}/g, ' ').trim() : undefined;

const CSA_AGE: Record<string, number> = { TP: 0, '10': 10, '12': 12, '16': 16, '18': 18 };

export function ftvItem(x: Json): ReplayItem | null {
  if (!x) return null;
  if (x.type === 'program' && x.program_path) {
    return {
      id: `ftvp:${x.program_path}`,
      provider: 'francetv',
      kind: 'show',
      title: x.label,
      desc: plain(x.description) || plain(x.synopsis) || undefined,
      image: picture(x.images),
      channel: x.channel?.label,
    };
  }
  if ((x.type !== 'integrale' && x.type !== 'unitaire') || !x.si_id || x.is_live) return null;
  const end = typeof x.end_date === 'number' ? x.end_date * 1000 : undefined;
  if (end && end < Date.now()) return null;
  const show = x.program?.label;
  const epTitle = x.episode_title || x.title;
  const se = x.season && x.episode ? `S${x.season} E${x.episode}` : x.episode ? `E${x.episode}` : '';
  return {
    id: `ftv:${x.si_id}`,
    provider: 'francetv',
    kind: 'video',
    title: show && show !== epTitle ? show : x.title,
    subtitle: show && show !== epTitle ? [se, epTitle].filter(Boolean).join(' · ') : x.headline_title || undefined,
    desc: plain(x.description),
    image: picture(x.images) || picture(x.program?.images),
    durationSec: x.duration || undefined,
    expires: end,
    channel: x.channel?.label,
    genre: x.category?.label,
    age: CSA_AGE[String(x.rating_csa_code || '').toUpperCase()],
    season: x.season || undefined,
    episode: x.episode || undefined,
  };
}

const items = (list: Json[] | undefined) => {
  const seen = new Set<string>();
  return (list || []).map(ftvItem).filter((x): x is ReplayItem => !!x && !seen.has(x.id) && !!seen.add(x.id));
};

export async function ftvCatalog(): Promise<{ rails: ReplayRail[]; hero: ReplayItem[] }> {
  const pages = await Promise.all(FTV_CHANNELS.map((c) => fetchJson<Json>(`${YATTA}/apps/channels/${c.path}?platform=apps`, 20000).catch(() => null)));
  if (!pages.some(Boolean)) throw new Error('france.tv indisponible');
  const rails: ReplayRail[] = [];
  const hero: ReplayItem[] = [];
  pages.forEach((page, i) => {
    if (!page) return;
    const ch = FTV_CHANNELS[i];
    for (const c of page.collections || []) {
      if (c?.type === 'live') continue;
      const list = items(c.items).map((x) => (x.channel ? x : { ...x, channel: ch.label }));
      if (c?.type === 'mise_en_avant') {
        hero.push(...list.filter((x) => x.image).slice(0, 2));
        continue;
      }
      if (list.length < 4) continue;
      rails.push({ id: `ftv:${ch.path}:${c.id ?? c.label}`, provider: 'francetv', title: `${ch.label} · ${String(c.label || '').trim()}`, items: list });
    }
  });
  return { rails, hero };
}

/** Okoo, france.tv's youth catalogue (3-5, 6-8, 9-12 years…) */
export async function ftvKids(): Promise<{ rails: ReplayRail[]; hero: ReplayItem[] }> {
  const page = await fetchJson<Json>(`${YATTA}/apps/categories/enfants?platform=apps`, 25000);
  const rails: ReplayRail[] = [];
  const hero: ReplayItem[] = [];
  for (const c of page?.collections || []) {
    const list = items(c.items).map((x) => ({ ...x, kids: true, channel: x.channel || 'Okoo' }));
    if (c?.type === 'mise_en_avant') {
      hero.push(...list.filter((x) => x.image).slice(0, 4));
      continue;
    }
    if (list.length < 4) continue;
    rails.push({ id: `okoo:${c.id ?? c.label}`, provider: 'francetv', kids: true, title: `Okoo · ${String(c.label || '').trim()}`, items: list });
  }
  return { rails: rails.slice(0, 16), hero };
}

export async function ftvShow(path: string): Promise<ReplayShow> {
  const page = await fetchJson<Json>(`${YATTA}/apps/program/${encodeURIComponent(path)}?platform=apps`, 25000);
  const head: ReplayItem = ftvItem({ ...page?.item, type: 'program', program_path: path }) || { id: `ftvp:${path}`, provider: 'francetv', kind: 'show', title: page?.label || path };
  const cols: Json[] = page?.collections || [];
  // seasons first; shows without seasons: any list of full videos
  let seasons = cols.filter((c) => c?.type === 'playlist_video').map((c) => ({ title: String(c.label || ''), items: items(c.items).filter((x) => x.kind === 'video') }));
  if (!seasons.some((s) => s.items.length)) {
    seasons = cols.map((c) => ({ title: String(c.label || ''), items: items(c.items).filter((x) => x.kind === 'video') }));
  }
  // lists come newest first: episodes in order when they are numbered
  for (const s of seasons) {
    if (s.items.every((x) => x.episode !== undefined)) s.items.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || a.episode! - b.episode!);
  }
  return { item: { ...head, image: head.image || seasons[0]?.items[0]?.image }, seasons: seasons.filter((s) => s.items.length) };
}

async function video(siId: string): Promise<Json> {
  // asked as an iOS device: HLS instead of DASH, no DRM for free content
  return fetchJson<Json>(`${K7}${encodeURIComponent(siId)}?country_code=FR&device_type=mobile&browser=safari&os=ios&domain=www.france.tv`, 15000);
}

export async function ftvStream(siId: string): Promise<ResolvedStream> {
  const v = await video(siId);
  const url: string | undefined = v?.video?.url;
  if (!url || v.video.drm) throw new Error(v?.video?.drm ? 'drm' : 'unavailable');
  const token = (v.video.token?.akamai as string | undefined) || TOKEN;
  const signed = await fetchJson<{ url?: string }>(`${token}${token.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`, 15000).catch(() => null);
  return { url: signed?.url || url, label: 'france.tv' };
}

export async function ftvInfo(siId: string): Promise<ReplayItem> {
  const v = await video(siId);
  const m = v?.meta || {};
  return {
    id: `ftv:${siId}`,
    provider: 'francetv',
    kind: 'video',
    title: m.title || siId,
    subtitle: m.additional_title || undefined,
    desc: plain(m.description),
    image: m.image_url,
    durationSec: v?.video?.duration || undefined,
  };
}
