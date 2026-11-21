import { db, getMeta, setMeta } from '../db';
import type { Movie, Series, TmdbListItem } from '../types';
import { isGenericEpisodeTitle, norm } from '../util/text';
import { Tmdb, type TmdbDetails } from './tmdb';
import { fetchTextStream, lines } from '../net/http';

/** bump to re-enrich already enriched titles in the background (v2: age, saga, IMDb id, recos, cast photos) */
export const ENRICH_V = 2;

export interface TmdbLists {
  fetchedAt: number;
  trendingMovies: TmdbListItem[];
  popularMovies: TmdbListItem[];
  nowPlaying: TmdbListItem[];
  topRatedMovies: TmdbListItem[];
  trendingTv: TmdbListItem[];
  popularTv: TmdbListItem[];
  topRatedTv: TmdbListItem[];
}

export const listsKey = (lang: string) => `tmdb:lists:${lang}`;

export async function refreshLists(tmdb: Tmdb, lang: string, force = false): Promise<TmdbLists> {
  const cur = await getMeta<TmdbLists>(listsKey(lang));
  if (cur && !force && Date.now() - cur.fetchedAt < 12 * 3600000) return cur;
  const [trendingMovies, popularMovies, nowPlaying, topRatedMovies, trendingTv, popularTv, topRatedTv] = await Promise.all([
    tmdb.list('movie', 'trending:week', 3),
    tmdb.list('movie', 'popular', 3),
    tmdb.list('movie', 'now_playing', 2),
    tmdb.list('movie', 'top_rated', 3),
    tmdb.list('tv', 'trending:week', 3),
    tmdb.list('tv', 'popular', 3),
    tmdb.list('tv', 'top_rated', 3),
  ]);
  const lists: TmdbLists = { fetchedAt: Date.now(), trendingMovies, popularMovies, nowPlaying, topRatedMovies, trendingTv, popularTv, topRatedTv };
  await setMeta(listsKey(lang), lists);
  return lists;
}

function similar(a: string, b: string): boolean {
  const x = norm(a).replace(/\s+/g, '');
  const y = norm(b).replace(/\s+/g, '');
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

function patchFrom(d: TmdbDetails, keepPoster?: string) {
  return {
    tmdbId: d.tmdbId,
    // provider posters are often low-res/ugly: prefer TMDB, keep provider as fallback
    poster: d.poster || keepPoster,
    backdrop: d.backdrop,
    logo: d.logo,
    plot: d.plot,
    rating: d.rating,
    genres: d.genres,
    cast: d.cast,
    director: d.director,
    trailer: d.trailer,
    durationSec: d.durationSec,
    year: d.year,
    origLang: d.origLang,
    imdbId: d.imdbId,
    cert: d.cert,
    certAge: d.certAge,
    recos: d.recos,
    people: d.people,
    collection: d.collection,
    enrichV: ENRICH_V,
    enrichedAt: Date.now(),
  };
}

export async function enrichMovie(tmdb: Tmdb, m: Movie): Promise<void> {
  try {
    let id = m.tmdbId;
    if (!id) {
      const hit = await tmdb.search('movie', m.title, m.year);
      if (hit && (similar(hit.title, m.title) || (m.year && hit.year === m.year))) id = hit.tmdbId;
    }
    if (!id) {
      await db.movies.update(m.id, { enrichedAt: -1 });
      return;
    }
    const d = await tmdb.details('movie', id);
    const p = patchFrom(d, m.poster);
    const same = await db.movies.where('groupKey').equals(m.groupKey).primaryKeys();
    await db.transaction('rw', db.movies, async () => {
      for (const k of new Set([m.id, ...same])) await db.movies.update(k, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as Partial<Movie>);
    });
  } catch {
    // a failed upgrade keeps the existing enrichment
    if (!m.enrichedAt) await db.movies.update(m.id, { enrichedAt: -1 });
  }
}

export async function enrichSeries(tmdb: Tmdb, s: Series): Promise<void> {
  try {
    let id = s.tmdbId;
    if (!id) {
      const hit = await tmdb.search('tv', s.title, s.year);
      if (hit && (similar(hit.title, s.title) || (s.year && hit.year === s.year))) id = hit.tmdbId;
    }
    if (!id) {
      await db.series.update(s.id, { enrichedAt: -1 });
      return;
    }
    const d = await tmdb.details('tv', id);
    const { durationSec: _d, director: _dir, collection: _col, trailer, ...p } = patchFrom(d, s.poster);
    const same = await db.series.where('groupKey').equals(s.groupKey).primaryKeys();
    await db.transaction('rw', db.series, async () => {
      for (const k of new Set([s.id, ...same]))
        await db.series.update(k, Object.fromEntries(Object.entries({ ...p, trailer }).filter(([, v]) => v !== undefined)) as Partial<Series>);
    });
  } catch {
    if (!s.enrichedAt) await db.series.update(s.id, { enrichedAt: -1 });
  }
}

/** Fill episode stills/plots from TMDB for one season */
export async function enrichSeason(tmdb: Tmdb, seriesId: string, season: number) {
  const s = await db.series.get(seriesId);
  if (!s?.tmdbId) return;
  try {
    const map = await tmdb.seasonStills(s.tmdbId, season);
    const eps = await db.episodes.where('seriesId').equals(seriesId).filter((e) => e.season === season).toArray();
    await db.transaction('rw', db.episodes, async () => {
      for (const e of eps) {
        const t = map[e.episode];
        if (!t) continue;
        await db.episodes.update(e.id, {
          still: t.still || e.still,
          plot: e.plot || t.plot,
          title: isGenericEpisodeTitle(e.title) && t.title ? t.title : e.title,
        });
      }
    });
  } catch {
    /* best effort */
  }
}

/** Background enrichment loop with a priority lane fed by the UI (visible items first) */
export class Enricher {
  private priority: { kind: 'movie' | 'series'; id: string }[] = [];
  private running = false;
  private stopFlag = false;
  private wake: (() => void) | null = null;

  constructor(private tmdb: Tmdb, private profileId: string, private onUpdate: () => void) {}

  prioritize(kind: 'movie' | 'series', ids: string[]) {
    for (const id of ids.slice().reverse()) this.priority.unshift({ kind, id });
    if (this.priority.length > 400) this.priority.length = 400;
    this.wake?.();
  }

  stop() {
    this.stopFlag = true;
    this.wake?.();
  }

  private async upgradeBatch(kind: 'movie' | 'series'): Promise<boolean> {
    const key = `enrich:upgrade:${ENRICH_V}:${kind}:${this.profileId}`;
    const cursor = (await getMeta<number>(key)) ?? 0;
    if (cursor < 0) return false;
    const table = kind === 'movie' ? db.movies : db.series;
    const batch = await (table as any).where('enrichedAt').above(0).offset(cursor).limit(25).toArray();
    if (!batch.length) {
      await setMeta(key, -1);
      return false;
    }
    for (const it of batch) {
      if (this.stopFlag || this.priority.length) break;
      if (it.profileId !== this.profileId || !needsEnrich(it)) continue;
      if (kind === 'movie') await enrichMovie(this.tmdb, it);
      else await enrichSeries(this.tmdb, it);
    }
    await setMeta(key, cursor + batch.length);
    return true;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    let sinceNotify = 0;
    const notify = () => {
      sinceNotify = 0;
      this.onUpdate();
    };
    while (!this.stopFlag) {
      const job = this.priority.shift();
      if (job) {
        if (job.kind === 'movie') {
          const m = await db.movies.get(job.id);
          if (m && needsEnrich(m)) await enrichMovie(this.tmdb, m);
        } else {
          const s = await db.series.get(job.id);
          if (s && needsEnrich(s)) await enrichSeries(this.tmdb, s);
        }
        if (++sinceNotify >= 4 || !this.priority.length) notify();
        continue;
      }
      // background: everything not enriched yet
      const m = await db.movies.where('enrichedAt').equals(0).filter((x) => x.profileId === this.profileId).first();
      if (m) {
        await enrichMovie(this.tmdb, m);
        if (++sinceNotify >= 20) notify();
        continue;
      }
      const s = await db.series.where('enrichedAt').equals(0).filter((x) => x.profileId === this.profileId).first();
      if (s) {
        await enrichSeries(this.tmdb, s);
        if (++sinceNotify >= 10) notify();
        continue;
      }
      // titles enriched by an older version: upgrade them, 25 at a time (cursor kept in meta)
      if (await this.upgradeBatch('movie')) {
        if (++sinceNotify >= 20) notify();
        continue;
      }
      if (await this.upgradeBatch('series')) {
        if (++sinceNotify >= 10) notify();
        continue;
      }
      // IMDb ratings for the titles that got an IMDb id (official daily dataset, at most once a day)
      if (await refreshImdbRatings(this.profileId)) notify();
      if (sinceNotify) notify();
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 60000);
      });
      this.wake = null;
    }
    this.running = false;
  }
}

/** not enriched yet, or enriched by an older version (only when TMDB matched it) */
export function needsEnrich(x: { enrichedAt?: number; enrichV?: number; tmdbId?: number }): boolean {
  return !x.enrichedAt || (x.enrichedAt > 0 && !!x.tmdbId && (x.enrichV || 1) < ENRICH_V);
}

const IMDB_RATINGS = 'https://datasets.imdbws.com/title.ratings.tsv.gz';

/**
 * IMDb ratings from IMDb's official daily dataset (free for personal, non-commercial use).
 * One ~9 MB download streamed line by line; only the titles of the catalogue are kept.
 * Runs hourly while many titles lack a rating, twice a day for a few, weekly otherwise.
 */
export async function refreshImdbRatings(profileId: string): Promise<boolean> {
  const key = `imdb:ratings:${profileId}`;
  const last = (await getMeta<number>(key)) || 0;
  if (Date.now() - last < 3600000) return false;
  const want = new Map<string, { movies: string[]; series: string[] }>();
  let missing = 0;
  await db.movies.where('profileId').equals(profileId).each((m) => {
    if (!m.imdbId) return;
    (want.get(m.imdbId) || want.set(m.imdbId, { movies: [], series: [] }).get(m.imdbId)!).movies.push(m.id);
    if (m.imdbRating === undefined) missing++;
  });
  await db.series.where('profileId').equals(profileId).each((x) => {
    if (!x.imdbId) return;
    (want.get(x.imdbId) || want.set(x.imdbId, { movies: [], series: [] }).get(x.imdbId)!).series.push(x.id);
    if (x.imdbRating === undefined) missing++;
  });
  // many new titles: hourly; a few: twice a day; none: weekly refresh of the ratings
  const gap = missing >= 10 ? 3600000 : missing > 0 ? 12 * 3600000 : 7 * 24 * 3600000;
  // nothing to rate yet: don't download (and don't reset the timer either)
  if (!want.size || Date.now() - last < gap) return false;
  const found: { id: string; rating: number; votes: number }[] = [];
  try {
    for await (const line of lines(await fetchTextStream(IMDB_RATINGS, 300000))) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const id = line.slice(0, tab);
      if (!want.has(id)) continue;
      const [, r, v] = line.split('\t');
      found.push({ id, rating: parseFloat(r), votes: parseInt(v, 10) });
    }
  } catch {
    return false; // offline: retried on the next idle pass
  }
  await db.transaction('rw', db.movies, db.series, async () => {
    for (const f of found) {
      const w = want.get(f.id)!;
      for (const id of w.movies) await db.movies.update(id, { imdbRating: f.rating, imdbVotes: f.votes });
      for (const id of w.series) await db.series.update(id, { imdbRating: f.rating, imdbVotes: f.votes });
    }
  });
  await setMeta(key, Date.now());
  return found.length > 0;
}
