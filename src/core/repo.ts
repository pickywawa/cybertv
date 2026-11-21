import { db, getMeta, setMeta } from './db';
import type { Channel, Episode, Favorite, Movie, Program, Series, Source, TmdbListItem, Universe, WatchState } from './types';
import { listsKey, type TmdbLists } from './enrich/enrich';
import { movieGroupKey, seriesGroupKey, QUALITY_RANK } from './util/text';
import { secureGet, sourcePassKey } from './secure';
import { sortByLang, type LangPrefs } from './util/lang';

/** language-aware dedup: best variant for the user's languages represents the group, languages merged */
export function dedupLang<T extends { groupKey: string; langs?: string[]; subs?: string[] }>(rows: T[], prefs?: LangPrefs): T[] {
  if (!prefs) return dedup(rows);
  const merged = new Map<string, { langs: Set<string>; subs: Set<string> }>();
  for (const r of rows) {
    const m = merged.get(r.groupKey) || merged.set(r.groupKey, { langs: new Set(), subs: new Set() }).get(r.groupKey)!;
    for (const l of r.langs || []) m.langs.add(l);
    for (const l of r.subs || []) m.subs.add(l);
  }
  const best = new Map<string, T>();
  for (const r of sortByLang(rows, prefs)) if (!best.has(r.groupKey)) best.set(r.groupKey, r);
  // keep the incoming order (first appearance of each group), then sort by language bucket
  const out: T[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.groupKey)) continue;
    seen.add(r.groupKey);
    const b = best.get(r.groupKey)!;
    const m = merged.get(r.groupKey)!;
    out.push({ ...b, langs: [...m.langs], subs: [...m.subs] });
  }
  return sortByLang(out, prefs);
}

export function dedup<T extends { groupKey: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.groupKey)) continue;
    seen.add(r.groupKey);
    out.push(r);
  }
  return out;
}

// ─────────── sources & secrets ───────────

let secretsCache: { profileId: string; map: Record<string, string | undefined> } | null = null;

export async function loadSecrets(profileId: string, force = false): Promise<Record<string, string | undefined>> {
  if (!force && secretsCache?.profileId === profileId) return secretsCache.map;
  const sources = await db.sources.where('profileId').equals(profileId).toArray();
  const map: Record<string, string | undefined> = {};
  for (const s of sources) if (s.type === 'xtream') map[s.id] = (await secureGet(sourcePassKey(s.id))) || undefined;
  secretsCache = { profileId, map };
  return map;
}
export function invalidateSecrets() {
  secretsCache = null;
}

export async function sourcesOf(profileId: string): Promise<Source[]> {
  return (await db.sources.where('profileId').equals(profileId).toArray()).sort((a, b) => a.priority - b.priority);
}

export async function sourcePriority(profileId: string): Promise<Map<string, number>> {
  const s = await sourcesOf(profileId);
  return new Map(s.filter((x) => x.enabled).map((x, i) => [x.id, i]));
}

// ─────────── live ───────────

/** One representative per channel group: best source priority, then best quality */
export function pickRepresentatives(channels: Channel[], prio: Map<string, number>): Channel[] {
  const best = new Map<string, Channel>();
  for (const c of channels) {
    if (!prio.has(c.sourceId)) continue;
    const cur = best.get(c.groupKey);
    if (!cur) {
      best.set(c.groupKey, c);
      continue;
    }
    const pa = prio.get(c.sourceId)!;
    const pb = prio.get(cur.sourceId)!;
    if (pa < pb || (pa === pb && (QUALITY_RANK[String(c.quality)] ?? 0) > (QUALITY_RANK[String(cur.quality)] ?? 0))) best.set(c.groupKey, c);
  }
  return [...best.values()].sort((a, b) => a.num - b.num);
}

export async function liveChannels(profileId: string, opts: { hideAdult: boolean }): Promise<Channel[]> {
  const [all, prio, hidden] = await Promise.all([
    db.channels.where('profileId').equals(profileId).toArray(),
    sourcePriority(profileId),
    hiddenCategories(profileId),
  ]);
  return pickRepresentatives(
    all.filter((c) => !(opts.hideAdult && c.universe === 'adult') && !(c.categoryId && hidden.has(c.categoryId))),
    prio,
  );
}

export async function hiddenCategories(profileId: string): Promise<Set<string>> {
  return new Set((await getMeta<string[]>(`hiddenCats:${profileId}`)) || []);
}

export interface NowNext {
  now?: Program;
  next?: Program;
}

/** current + next program for every epgId, one indexed range query */
export async function nowNext(at = Date.now()): Promise<Map<string, NowNext>> {
  const rows = await db.programs.where('start').between(at - 12 * 3600000, at + 6 * 3600000).toArray();
  rows.sort((a, b) => a.start - b.start);
  const map = new Map<string, NowNext>();
  for (const p of rows) {
    const e = map.get(p.epgId) || {};
    if (p.start <= at && p.stop > at) e.now = p;
    else if (p.start > at && !e.next) e.next = p;
    map.set(p.epgId, e);
  }
  return map;
}

/** the main evening program of each channel (starting around `startMin` today) */
export async function tonight(startMin: number): Promise<Map<string, Program>> {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const from = d.getTime() + (startMin - 25) * 60000;
  const to = d.getTime() + (startMin + 50) * 60000;
  const rows = await db.programs.where('start').between(from, to).toArray();
  const target = d.getTime() + startMin * 60000;
  const map = new Map<string, Program>();
  for (const p of rows) {
    if (p.stop - p.start < 20 * 60000) continue;
    const cur = map.get(p.epgId);
    if (!cur || Math.abs(p.start - target) < Math.abs(cur.start - target)) map.set(p.epgId, p);
  }
  return map;
}

export async function programsFor(epgId: string, from: number, to: number): Promise<Program[]> {
  return db.programs.where('[epgId+start]').between([epgId, from - 6 * 3600000], [epgId, to]).filter((p) => p.stop > from).toArray();
}

export async function programsInRange(from: number, to: number): Promise<Map<string, Program[]>> {
  const rows = await db.programs.where('start').between(from - 6 * 3600000, to).filter((p) => p.stop > from).toArray();
  const map = new Map<string, Program[]>();
  for (const p of rows) (map.get(p.epgId) || map.set(p.epgId, []).get(p.epgId)!).push(p);
  for (const l of map.values()) l.sort((a, b) => a.start - b.start);
  return map;
}

// ─────────── VOD ───────────

export async function tmdbLists(lang: string): Promise<TmdbLists | undefined> {
  return getMeta<TmdbLists>(listsKey(lang));
}

/** Movies of the catalog matching a TMDB list, in list order */
export async function matchMovies(profileId: string, list: TmdbListItem[]): Promise<Movie[]> {
  if (!list.length) return [];
  const ids = list.map((i) => i.tmdbId);
  const keys = list.flatMap((i) => [movieGroupKey(i.title, i.year), movieGroupKey(i.title, undefined)]);
  const [byId, byKey] = await Promise.all([
    db.movies.where('tmdbId').anyOf(ids).filter((m) => m.profileId === profileId).toArray(),
    db.movies.where('groupKey').anyOf(keys).filter((m) => m.profileId === profileId).toArray(),
  ]);
  const idMap = new Map<number, Movie>();
  for (const m of [...byId, ...byKey]) if (m.tmdbId && !idMap.has(m.tmdbId)) idMap.set(m.tmdbId, m);
  const keyMap = new Map<string, Movie>();
  for (const m of byKey) keyMap.set(m.groupKey, m);
  const out: Movie[] = [];
  const seen = new Set<string>();
  for (const i of list) {
    const m = idMap.get(i.tmdbId) || keyMap.get(movieGroupKey(i.title, i.year)) || keyMap.get(movieGroupKey(i.title, undefined));
    if (m && !seen.has(m.groupKey)) {
      seen.add(m.groupKey);
      out.push({ ...m, poster: m.poster || i.poster, backdrop: m.backdrop || i.backdrop });
    }
  }
  return out;
}

export async function matchSeries(profileId: string, list: TmdbListItem[]): Promise<Series[]> {
  if (!list.length) return [];
  const ids = list.map((i) => i.tmdbId);
  const keys = list.map((i) => seriesGroupKey(i.title));
  const [byId, byKey] = await Promise.all([
    db.series.where('tmdbId').anyOf(ids).filter((m) => m.profileId === profileId).toArray(),
    db.series.where('groupKey').anyOf(keys).filter((m) => m.profileId === profileId).toArray(),
  ]);
  const idMap = new Map<number, Series>();
  for (const m of [...byId, ...byKey]) if (m.tmdbId && !idMap.has(m.tmdbId)) idMap.set(m.tmdbId, m);
  const keyMap = new Map(byKey.map((m) => [m.groupKey, m]));
  const out: Series[] = [];
  const seen = new Set<string>();
  for (const i of list) {
    const m = idMap.get(i.tmdbId) || keyMap.get(seriesGroupKey(i.title));
    if (m && !seen.has(m.groupKey)) {
      seen.add(m.groupKey);
      out.push({ ...m, poster: m.poster || i.poster, backdrop: m.backdrop || i.backdrop });
    }
  }
  return out;
}

export async function latestMovies(profileId: string, limit = 40, hideAdult = true, prefs?: LangPrefs): Promise<Movie[]> {
  const rows = await db.movies.where('[profileId+addedAt]').between([profileId, -Infinity], [profileId, Infinity]).reverse().limit(limit * 4).toArray();
  return dedupLang(rows.filter((m) => !(hideAdult && m.universe === 'adult')), prefs).slice(0, limit);
}

export async function latestSeries(profileId: string, limit = 40, hideAdult = true, prefs?: LangPrefs): Promise<Series[]> {
  const rows = await db.series.where('[profileId+addedAt]').between([profileId, -Infinity], [profileId, Infinity]).reverse().limit(limit * 4).toArray();
  return dedupLang(rows.filter((m) => !(hideAdult && m.universe === 'adult')), prefs).slice(0, limit);
}

// ─────────── catalogue index ───────────
/**
 * Light in-memory copy of a profile's movies / series (no plot, cast…), shared by the grids and
 * the home genre rails: one IndexedDB scan instead of one per screen. Rebuilt after a sync, and at
 * most every 45 s while TMDB enrichment keeps updating posters.
 */
const INDEX_TTL = 45000;
type Lite<T> = T;
const index = new Map<string, { at: number; version: number; rows: unknown[] }>();

const liteMovie = (m: Movie): Movie => {
  const { plot: _p, cast: _c, director: _d, trailer: _t, ...rest } = m;
  return rest as Movie;
};
const liteSeries = (s: Series): Series => {
  const { plot: _p, cast: _c, trailer: _t, ...rest } = s;
  return rest as Series;
};

async function catalog<T extends Movie | Series>(profileId: string, kind: 'movie' | 'series'): Promise<Lite<T>[]> {
  const key = `${kind}:${profileId}`;
  const version = (await getMeta<number>(`catalog:version:${profileId}`)) || 0;
  const cur = index.get(key);
  if (cur && cur.version === version && Date.now() - cur.at < INDEX_TTL) return cur.rows as T[];
  const rows =
    kind === 'movie'
      ? (await db.movies.where('profileId').equals(profileId).toArray()).map(liteMovie)
      : (await db.series.where('profileId').equals(profileId).toArray()).map(liteSeries);
  index.set(key, { at: Date.now(), version, rows });
  return rows as T[];
}

/** forget the index (sources removed, profile deleted…) */
export function invalidateCatalogIndex() {
  index.clear();
}

export async function moviesSample(profileId: string, limit = 3000): Promise<Movie[]> {
  return (await catalog<Movie>(profileId, 'movie')).slice(0, limit);
}

export interface GridQuery {
  universe?: string;
  genre?: string;
  categoryId?: string;
  sort?: 'added' | 'rating' | 'title' | 'year';
}

export async function gridMovies(profileId: string, q: GridQuery, hideAdult: boolean, prefs?: LangPrefs): Promise<Movie[]> {
  let rows = q.categoryId
    ? (await db.movies.where('categoryId').equals(q.categoryId).toArray()).map(liteMovie)
    : await catalog<Movie>(profileId, 'movie');
  rows = rows.filter(
    (m) =>
      !(hideAdult && m.universe === 'adult') &&
      (!q.universe || m.universe === q.universe || (q.universe === 'kids' && (m.genres || []).some((g) => /anim|famil|kids/i.test(g)))) &&
      (!q.genre || (m.genres || []).includes(q.genre)),
  );
  const sorted = sortRows(dedupLang(rows, prefs), q.sort);
  return prefs ? sortByLang(sorted, prefs) : sorted;
}

export async function gridSeries(profileId: string, q: GridQuery, hideAdult: boolean, prefs?: LangPrefs): Promise<Series[]> {
  let rows = q.categoryId
    ? (await db.series.where('categoryId').equals(q.categoryId).toArray()).map(liteSeries)
    : await catalog<Series>(profileId, 'series');
  rows = rows.filter(
    (m) =>
      !(hideAdult && m.universe === 'adult') &&
      (!q.universe || m.universe === q.universe || (q.universe === 'kids' && (m.genres || []).some((g) => /anim|famil|kids/i.test(g)))) &&
      (!q.genre || (m.genres || []).includes(q.genre)),
  );
  const sorted = sortRows(dedupLang(rows, prefs), q.sort);
  return prefs ? sortByLang(sorted, prefs) : sorted;
}

function sortRows<T extends { addedAt: number; rating?: number; title: string; year?: number }>(rows: T[], sort: GridQuery['sort'] = 'added'): T[] {
  const c = new Intl.Collator('fr');
  switch (sort) {
    case 'rating':
      return rows.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    case 'title':
      return rows.sort((a, b) => c.compare(a.title, b.title));
    case 'year':
      return rows.sort((a, b) => (b.year || 0) - (a.year || 0));
    default:
      return rows.sort((a, b) => b.addedAt - a.addedAt);
  }
}

export async function episodesOf(seriesId: string): Promise<Episode[]> {
  const eps = await db.episodes.where('seriesId').equals(seriesId).toArray();
  return eps.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

// ─────────── user data ───────────

export const watchKey = (kind: string, id: string) => `${kind}:${id}`;

/**
 * "Finished" even if the viewer quit during the end credits:
 * remaining time ≤ max(5 %, min(10 min, 10 %)) → 9 min on a 90 min film, ~2 min on a 22 min episode.
 */
export function isFinished(positionSec: number, durationSec: number): boolean {
  if (!durationSec) return false;
  const remaining = durationSec - positionSec;
  return remaining <= Math.max(0.05 * durationSec, Math.min(600, 0.1 * durationSec));
}

/**
 * Movies and series in progress, most recent first:
 * - finished movies are dropped,
 * - one entry per series: the episode in progress, or the next episode when the last one was finished,
 *   nothing when the series is over.
 */
export async function continueWatching(profileId: string): Promise<WatchState[]> {
  const rows = await db.watch.where('[profileId+updatedAt]').between([profileId, -Infinity], [profileId, Infinity]).reverse().limit(120).toArray();
  const hidden = (await getMeta<Record<string, number>>(`contHidden:${profileId}`)) || {};
  const seenSeries = new Set<string>();
  const out: WatchState[] = [];
  for (const w of rows) {
    if (w.kind === 'live') continue;
    // removed by the user from the rail (until watched again)
    const hk = w.seriesId || w.key;
    if (hidden[hk] && hidden[hk] >= w.updatedAt) {
      if (w.seriesId) seenSeries.add(w.seriesId);
      continue;
    }
    const done = w.completed || isFinished(w.positionSec, w.durationSec);
    if (w.kind === 'movie') {
      if (done || w.positionSec < 30) continue;
      out.push(w);
      continue;
    }
    if (w.kind !== 'episode' || !w.seriesId) continue;
    if (seenSeries.has(w.seriesId)) continue; // only the latest episode watched decides
    seenSeries.add(w.seriesId);
    if (!done) {
      if (w.positionSec >= 30) out.push(w);
      continue;
    }
    const ep = await db.episodes.get(w.itemId);
    if (!ep) continue;
    const eps = (await db.episodes.where('seriesId').equals(w.seriesId).toArray()).sort((a, b) => a.season - b.season || a.episode - b.episode);
    const next = eps[eps.findIndex((e) => e.id === ep.id) + 1];
    if (!next) continue; // series finished
    out.push({
      ...w,
      key: `episode:${next.id}`,
      itemId: next.id,
      subtitle: `S${next.season} E${next.episode}${next.title && !/^((É|E)pisode\s*\d+)$/i.test(next.title) ? ' · ' + next.title : ''}`,
      image: next.still || w.image,
      positionSec: 0,
      durationSec: next.durationSec || 0,
      completed: false,
    });
  }
  return out;
}

export async function hideFromContinue(w: WatchState) {
  const key = `contHidden:${w.profileId}`;
  const cur = (await getMeta<Record<string, number>>(key)) || {};
  cur[w.seriesId || w.key] = Date.now();
  await setMeta(key, cur);
}

export async function history(profileId: string): Promise<WatchState[]> {
  return db.watch.where('[profileId+updatedAt]').between([profileId, -Infinity], [profileId, Infinity]).reverse().limit(100).toArray();
}

export async function saveProgress(w: Omit<WatchState, 'updatedAt' | 'completed'> & { completed?: boolean }) {
  const completed = w.completed ?? isFinished(w.positionSec, w.durationSec);
  await db.watch.put({ ...w, completed, updatedAt: Date.now() });
}

export async function getProgress(profileId: string, key: string): Promise<WatchState | undefined> {
  return db.watch.get([profileId, key]);
}

export async function toggleFavorite(profileId: string, kind: Favorite['kind'], groupKey: string, itemId: string): Promise<boolean> {
  const key = `${kind}:${groupKey}`;
  const cur = await db.favorites.get([profileId, key]);
  if (cur) {
    await db.favorites.delete([profileId, key]);
    return false;
  }
  const count = await db.favorites.where('profileId').equals(profileId).count();
  await db.favorites.put({ profileId, key, kind, itemId, order: count, addedAt: Date.now() });
  return true;
}

export async function favoritesOf(profileId: string, kind?: Favorite['kind']): Promise<Favorite[]> {
  const rows = await db.favorites.where('profileId').equals(profileId).toArray();
  return rows.filter((f) => !kind || f.kind === kind).sort((a, b) => a.order - b.order);
}

export async function deleteProfileData(profileId: string) {
  invalidateCatalogIndex();
  const sources = await db.sources.where('profileId').equals(profileId).primaryKeys();
  await db.transaction('rw', [db.sources, db.categories, db.channels, db.movies, db.series, db.episodes, db.watch, db.favorites, db.profiles], async () => {
    for (const sid of sources) {
      await db.categories.where('sourceId').equals(sid).delete();
      await db.channels.where('sourceId').equals(sid).delete();
      await db.movies.where('sourceId').equals(sid).delete();
      await db.series.where('sourceId').equals(sid).delete();
      await db.episodes.where('sourceId').equals(sid).delete();
    }
    await db.sources.where('profileId').equals(profileId).delete();
    await db.watch.where('profileId').equals(profileId).delete();
    await db.favorites.where('profileId').equals(profileId).delete();
    await db.profiles.delete(profileId);
  });
}

export async function deleteSourceData(sourceId: string) {
  invalidateCatalogIndex();
  await db.transaction('rw', [db.sources, db.categories, db.channels, db.movies, db.series, db.episodes], async () => {
    await db.categories.where('sourceId').equals(sourceId).delete();
    await db.channels.where('sourceId').equals(sourceId).delete();
    await db.movies.where('sourceId').equals(sourceId).delete();
    await db.series.where('sourceId').equals(sourceId).delete();
    await db.episodes.where('sourceId').equals(sourceId).delete();
    await db.sources.delete(sourceId);
  });
}

export type { Universe };

/** catalogue titles matching TMDB ids, in the given order (best language variant per title) */
export async function availableByTmdb<K extends 'movie' | 'series'>(
  profileId: string,
  kind: K,
  tmdbIds: number[],
  prefs?: LangPrefs,
): Promise<(K extends 'movie' ? Movie : Series)[]> {
  if (!tmdbIds.length) return [];
  const table = kind === 'movie' ? db.movies : db.series;
  const rows = (await (table as typeof db.movies).where('tmdbId').anyOf(tmdbIds).toArray()).filter((x) => x.profileId === profileId);
  const best = dedupLang(rows as Movie[], prefs);
  const byId = new Map(best.map((x) => [x.tmdbId!, x]));
  return tmdbIds.map((id) => byId.get(id)).filter(Boolean) as never;
}
