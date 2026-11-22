import { getMeta, setMeta } from '../db';
import type { Channel, PlayRequest } from '../types';
import { withTimeshift } from '../playback';
import { arteCatalog, arteInfo, arteShow, arteStream } from './arte';
import { ftvCatalog, ftvInfo, ftvKids, ftvShow, ftvStream } from './francetv';
import { youtubeRails } from './youtube';
import { t } from '../i18n';
import type { ReplayCatalog, ReplayItem, ReplayProvider, ReplayRail, ReplayShow, ResolvedStream } from './types';

export type { ReplayCatalog, ReplayItem, ReplayProvider, ReplayRail, ReplayShow } from './types';

const TTL = 3 * 3600000;
const metaKey = (lang: string, country = '') => `replay:catalog:v3:${lang}:${country}`;

/** alternate both catalogues so neither buries the other */
function interleave(a: ReplayRail[], b: ReplayRail[]): ReplayRail[] {
  const out: ReplayRail[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

async function fetchCatalog(lang: string, country: string): Promise<ReplayCatalog> {
  const ytTitles = { docs: t('yt.docs'), sport: t('yt.sport'), news: t('yt.news'), radio: t('yt.radio'), humor: t('yt.humor'), media: t('yt.media') };
  const [arte, ftv, kids, yt] = await Promise.allSettled([arteCatalog(lang), ftvCatalog(), ftvKids(), youtubeRails(lang, country, ytTitles)]);
  const k = kids.status === 'fulfilled' ? kids.value : { rails: [], hero: [] };
  const failed: ReplayProvider[] = [];
  const a = arte.status === 'fulfilled' ? arte.value : (failed.push('arte'), { rails: [], hero: [] });
  const f = ftv.status === 'fulfilled' ? ftv.value : (failed.push('francetv'), { rails: [], hero: [] });
  const hero: ReplayItem[] = [];
  for (let i = 0; hero.length < 6 && i < 6; i++) {
    if (a.hero[i]) hero.push(a.hero[i]);
    if (f.hero[i]) hero.push(f.hero[i]);
  }
  return { at: Date.now(), hero: hero.slice(0, 6), rails: interleave(a.rails, f.rails), kids: k.rails, kidsHero: k.hero, youtube: yt.status === 'fulfilled' ? yt.value : [], failed };
}

let inflight: Promise<ReplayCatalog> | null = null;

/** saved copy first (instant), refreshed from the network when older than 3 h or when forced */
export async function replayCatalog(lang: string, opts: { force?: boolean; cachedOnly?: boolean; country?: string } = {}): Promise<ReplayCatalog | null> {
  const country = opts.country || '';
  const saved = await getMeta<ReplayCatalog>(metaKey(lang, country)).catch(() => undefined);
  if (opts.cachedOnly) return saved || null;
  if (saved && !opts.force && Date.now() - saved.at < TTL) return saved;
  inflight ??= fetchCatalog(lang, country).finally(() => (inflight = null));
  const fresh = await inflight;
  // a failed refresh never replaces a good saved catalogue
  if (!fresh.rails.length && saved?.rails.length) return saved;
  void setMeta(metaKey(lang, country), fresh).catch(() => {});
  return fresh;
}

const SHOWS = new Map<string, ReplayShow>();
export async function replayShow(id: string, lang: string): Promise<ReplayShow> {
  const hit = SHOWS.get(id);
  if (hit) return hit;
  const [p, ref] = splitId(id);
  const show = p === 'arte' ? await arteShow(ref, lang) : await ftvShow(ref);
  SHOWS.set(id, show);
  return show;
}

export async function replayInfo(id: string, lang: string): Promise<ReplayItem> {
  const [p, ref] = splitId(id);
  if (p === 'ftvp' || /^RC-/.test(ref)) return (await replayShow(id, lang)).item;
  return p === 'arte' ? arteInfo(ref, lang) : ftvInfo(ref);
}

function splitId(id: string): [string, string] {
  const i = id.indexOf(':');
  return [id.slice(0, i), id.slice(i + 1)];
}

export async function resolveReplay(id: string, lang: string): Promise<ResolvedStream> {
  const [p, ref] = splitId(id);
  if (p === 'arte') return arteStream(ref, lang);
  if (p === 'ftv') return ftvStream(ref);
  throw new Error('not playable');
}

export async function replayPlayRequest(item: ReplayItem, lang: string, startAt?: number): Promise<PlayRequest> {
  const s = await resolveReplay(item.id, lang);
  return {
    kind: 'replay',
    itemId: item.id,
    title: item.title,
    subtitle: [item.subtitle, item.channel].filter(Boolean).join(' · ') || undefined,
    image: item.image,
    candidates: [{ url: s.url, label: s.label, quality: 'FHD', sourceId: 'official' }],
    startAt,
    durationSec: item.durationSec,
  };
}

// ─────────── official live streams of the free public channels ───────────

export interface OfficialLive {
  key: string;
  name: string;
  /** france.tv live video id */
  ftv?: string;
  arte?: boolean;
  /** channel group keys and iptv-org ids that designate this channel in a provider's list */
  keys: string[];
  iptv: string[];
}

export const OFFICIAL_LIVE: OfficialLive[] = [
  { key: 'france2', name: 'France 2', ftv: '006194ea-117d-4bcf-94a9-153d999c59ae', keys: ['ch:france2'], iptv: ['france2.fr'] },
  { key: 'france3', name: 'France 3', ftv: '29bdf749-7082-4426-a4f3-595cc436aa0d', keys: ['ch:france3'], iptv: ['france3.fr'] },
  { key: 'france4', name: 'France 4', ftv: '9a6a7670-dde9-4264-adbc-55b89558594b', keys: ['ch:france4'], iptv: ['france4.fr'] },
  { key: 'france5', name: 'France 5', ftv: '45007886-f3ff-4b3e-9706-1ef1014c5a60', keys: ['ch:france5'], iptv: ['france5.fr'] },
  { key: 'franceinfo', name: 'franceinfo', ftv: '35be22fb-1569-43ff-857c-99bf81defa2e', keys: ['ch:franceinfo', 'ch:franceinfotv', 'ch:franceinfo27'], iptv: ['franceinfo.fr', 'franceinfotv.fr'] },
  // channel 13 of the TNT: LCP and Public Sénat share the same feed
  {
    key: 'lcp', name: 'LCP · Public Sénat', ftv: '733d60e7-914f-40ed-b296-0ddbc4b6d414',
    keys: ['ch:lcp', 'ch:lcpan', 'ch:lcpassembleenationale', 'ch:publicsenat', 'ch:lcppublicsenat', 'ch:lcpps'], iptv: ['lcp.fr', 'lcpan.fr', 'publicsenat.fr'],
  },
  { key: 'arte', name: 'Arte', arte: true, keys: ['ch:arte', 'ch:artefrance', 'ch:artefr'], iptv: ['arte.fr', 'artefrance.fr'] },
];

export function officialFor(ch: Pick<Channel, 'groupKey' | 'iptvId'>): OfficialLive | undefined {
  const iptv = ch.iptvId?.toLowerCase().replace(/@.*$/, '');
  return OFFICIAL_LIVE.find((o) => o.keys.includes(ch.groupKey) || (!!iptv && o.iptv.includes(iptv)));
}

/** signed live urls stay valid for hours: reuse them for a while (zapping back and forth) */
const LIVE_CACHE = new Map<string, { at: number; s: ResolvedStream }>();

export async function resolveOfficialLive(o: OfficialLive, lang: string): Promise<ResolvedStream> {
  const hit = LIVE_CACHE.get(o.key);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.s;
  const s = o.arte ? await arteStream('LIVE', lang) : await ftvStream(o.ftv!);
  const out = { url: s.url, label: o.arte ? 'ARTE' : 'france.tv' };
  LIVE_CACHE.set(o.key, { at: Date.now(), s: out });
  return out;
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tm = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(tm), resolve(v)),
      (e) => (clearTimeout(tm), reject(e)),
    );
  });
}

/** a live channel the user's sources don't carry: the official stream alone */
export async function officialPlayRequest(o: OfficialLive, lang: string): Promise<PlayRequest> {
  const s = await resolveOfficialLive(o, lang);
  return {
    kind: 'live',
    itemId: `official:${o.key}`,
    title: o.name,
    candidates: [withTimeshift({ url: s.url, label: s.label, quality: 'FHD', sourceId: 'official' })],
    live: true,
  };
}
