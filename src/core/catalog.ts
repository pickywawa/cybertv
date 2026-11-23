/**
 * Catalogue-wide queries (whole film / series lists of a profile). Worker-safe (no UI / native
 * imports): they run in the data worker, so the screen thread only receives what it displays —
 * reading 60 000 titles out of IndexedDB froze Android TV boxes for seconds.
 */
import { db, getMeta } from './db';
import type { Movie, Series, TmdbListItem } from './types';
import { listsKey, type TmdbLists } from './enrich/enrich';
import { movieGroupKey, seriesGroupKey } from './util/text';
import { langScore, sortByLang, type LangPrefs } from './util/lang';
import { genreKeys } from './util/genres';

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

// ─────────── screen-sized answers (computed in the data worker) ───────────

/** what a poster grid shows of a title, plus its genre keys (sub-category chips) */
export interface GridItem {
  id: string;
  title: string;
  year?: number;
  poster?: string;
  imdbRating?: number;
  rating?: number;
  genres?: string[];
  enrichedAt?: number;
  enrichV?: number;
  tmdbId?: number;
  /** genre keys from TMDB genres and the provider category name */
  g: string[];
}

/** grid of a whole universe / category: slim rows only (a big catalogue is 60 000+ titles) */
export async function gridItems(profileId: string, kind: 'movie' | 'series', q: GridQuery, hideAdult: boolean, prefs?: LangPrefs): Promise<GridItem[]> {
  const rows: (Movie | Series)[] = kind === 'movie' ? await gridMovies(profileId, q, hideAdult, prefs) : await gridSeries(profileId, q, hideAdult, prefs);
  const cats = new Map((await db.categories.where('[profileId+kind]').between([profileId, ''], [profileId, '\uffff']).toArray()).map((c) => [c.id, c.name]));
  return rows.map((x) => ({
    id: x.id, title: x.title, year: x.year, poster: x.poster, imdbRating: x.imdbRating, rating: x.rating, genres: x.genres?.slice(0, 2),
    enrichedAt: x.enrichedAt, enrichV: x.enrichV, tmdbId: x.tmdbId,
    g: genreKeys(x, x.categoryId ? cats.get(x.categoryId) : undefined),
  }));
}

/** titles sharing a genre (detail page, when TMDB recommends too few available ones) */
export async function similarByGenre(profileId: string, kind: 'movie' | 'series', groupKey: string, genre: string, prefs?: LangPrefs, limit = 24): Promise<(Movie | Series)[]> {
  const all = await catalog<Movie | Series>(profileId, kind);
  const rows: (Movie | Series)[] = [];
  for (const x of all) {
    if (x.groupKey !== groupKey && x.genres?.includes(genre)) rows.push(x);
    if (rows.length >= 200) break;
  }
  return dedupLang(rows, prefs)
    .sort((a, b) => (b.imdbRating || b.rating || 0) - (a.imdbRating || a.rating || 0))
    .slice(0, limit);
}

/** the film / series rails of Home (the rest — continue watching, favourites, Trakt — is small) */
export async function homeCatalog(profileId: string, lang: string, hideAdult: boolean, prefs: LangPrefs) {
  const lists = await tmdbLists(lang);
  const [fresh, newSeries, top0, nowPlaying0, popularMovies0, topRated0, trendingTv0, popularTv0, sample0] = await Promise.all([
    latestMovies(profileId, 40, hideAdult, prefs),
    latestSeries(profileId, 40, hideAdult, prefs),
    matchMovies(profileId, lists?.trendingMovies || []),
    matchMovies(profileId, lists?.nowPlaying || []),
    matchMovies(profileId, lists?.popularMovies || []),
    matchMovies(profileId, lists?.topRatedMovies || []),
    matchSeries(profileId, lists?.trendingTv || []),
    matchSeries(profileId, lists?.popularTv || []),
    moviesSample(profileId, 4000),
  ]);
  // content in the user's audio languages first (secondary language next, then untagged, then the rest)
  const L = <T extends Movie | Series>(rows: T[]) => sortByLang(rows, prefs);
  const top = L(top0.filter((m) => langScore(m, prefs) < 4).length >= 6 ? top0.filter((m) => langScore(m, prefs) < 4) : top0);
  const [nowPlaying, popularMovies, topRated, trendingTv, popularTv] = [L(nowPlaying0), L(popularMovies0), L(topRated0), L(trendingTv0), L(popularTv0)];
  const sample = dedupLang(sample0, prefs);
  // genre rails from enriched movies
  const byGenre = new Map<string, Movie[]>();
  for (const m of sample) for (const g of m.genres || []) (byGenre.get(g) || byGenre.set(g, []).get(g)!).push(m);
  const genres = [...byGenre.entries()]
    .filter(([, l]) => l.length >= 6)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5)
    .map(([g, l]) => [g, l.slice(0, 30)] as [string, Movie[]]);
  const mustSee = topRated.length >= 6 ? topRated : L(sample.filter((m) => (m.rating || 0) >= 7.3).sort((a, b) => (b.rating || 0) - (a.rating || 0))).slice(0, 30);
  const kids = sample.filter((m) => m.universe === 'kids' || (m.genres || []).some((g) => /anim|famil/i.test(g))).slice(0, 30);
  return {
    fresh, newSeries, top: top.slice(0, 10), nowPlaying, popularMovies, mustSee, trendingTv, popularTv, genres, kids,
    hasVod: sample.length > 0 || newSeries.length > 0,
  };
}
