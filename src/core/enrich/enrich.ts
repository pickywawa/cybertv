import { db, getMeta, setMeta } from '../db';
import type { Movie, Series, TmdbListItem } from '../types';
import { isGenericEpisodeTitle, norm } from '../util/text';
import { Tmdb, type TmdbDetails } from './tmdb';

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
    await db.movies.update(m.id, { enrichedAt: -1 });
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
    const { durationSec: _d, director: _dir, trailer, ...p } = patchFrom(d, s.poster);
    const same = await db.series.where('groupKey').equals(s.groupKey).primaryKeys();
    await db.transaction('rw', db.series, async () => {
      for (const k of new Set([s.id, ...same]))
        await db.series.update(k, Object.fromEntries(Object.entries({ ...p, trailer }).filter(([, v]) => v !== undefined)) as Partial<Series>);
    });
  } catch {
    await db.series.update(s.id, { enrichedAt: -1 });
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
          if (m && !m.enrichedAt) await enrichMovie(this.tmdb, m);
        } else {
          const s = await db.series.get(job.id);
          if (s && !s.enrichedAt) await enrichSeries(this.tmdb, s);
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
