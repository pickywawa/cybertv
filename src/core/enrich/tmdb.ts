import type { Person, TmdbListItem } from '../types';
import { certToAge } from './cert';

export const TMDB_IMG = 'https://image.tmdb.org/t/p/';
export const img = (path: string | null | undefined, size: 'w92' | 'w185' | 'w300' | 'w342' | 'w500' | 'w780' | 'w1280' | 'original') =>
  path ? `${TMDB_IMG}${size}${path}` : undefined;

/** Rewrites a stored TMDB image url to another size (we store w342 posters / w1280 backdrops) */
export function resizeTmdb(url: string | undefined, size: string): string | undefined {
  if (!url) return url;
  // the whole size segment: providers store "w600_and_h900_bestv2" style urls (not valid with another size prefix)
  return url.replace(/(image\.tmdb\.org\/t\/p\/)[^/]+/, `$1${size}`);
}

export interface TmdbDetails {
  tmdbId: number;
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  logo?: string;
  plot?: string;
  rating?: number;
  genres?: string[];
  cast?: string[];
  director?: string;
  trailer?: string;
  durationSec?: number;
  origLang?: string;
  imdbId?: string;
  cert?: string;
  certAge?: number;
  recos?: number[];
  people?: Person[];
  collection?: { id: number; name: string };
}

export interface TmdbCollection {
  id: number;
  name: string;
  overview?: string;
  backdrop?: string;
  parts: { tmdbId: number; title: string; year?: number; poster?: string }[];
}

export interface TmdbPerson {
  id: number;
  name: string;
  bio?: string;
  birthday?: string;
  deathday?: string;
  place?: string;
  photo?: string;
  knownFor?: string;
  credits: { kind: 'movie' | 'tv'; tmdbId: number; title: string; year?: number; character?: string; job?: string; popularity: number }[];
}

type Kind = 'movie' | 'tv';

/** Minimal TMDB v3 client: accepts either a v4 read token (JWT) or a v3 api key */
export class Tmdb {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(private token: string, private lang = 'fr-FR', private minGapMs = 60) {}

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const q = new URLSearchParams();
    q.set('language', this.lang);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    const isV3Key = /^[a-f0-9]{32}$/i.test(this.token.trim());
    if (isV3Key) q.set('api_key', this.token.trim());
    const headers: Record<string, string> = { accept: 'application/json' };
    if (!isV3Key) headers.authorization = `Bearer ${this.token.trim()}`;
    // simple global rate limiting (TMDB soft limit ≈ 40-50 req/s)
    const run = async () => {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`https://api.themoviedb.org/3${path}?${q}`, { headers });
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new Error(`TMDB ${res.status}`);
        return res.json();
      }
      throw new Error('TMDB rate limited');
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p as Promise<T>;
  }

  async validate(): Promise<boolean> {
    try {
      await this.get('/configuration');
      return true;
    } catch {
      return false;
    }
  }

  private toItem = (r: any): TmdbListItem => ({
    tmdbId: r.id,
    title: r.title || r.name,
    year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10) || undefined,
    poster: img(r.poster_path, 'w342'),
    backdrop: img(r.backdrop_path, 'w1280'),
  });

  async list(kind: Kind, list: string, pages = 2): Promise<TmdbListItem[]> {
    const out: TmdbListItem[] = [];
    for (let page = 1; page <= pages; page++) {
      const path = list.startsWith('trending') ? `/trending/${kind}/${list.split(':')[1] || 'week'}` : `/${kind}/${list}`;
      const r = await this.get<any>(path, { page, region: 'FR' });
      out.push(...(r.results || []).map(this.toItem));
    }
    return out;
  }

  async search(kind: Kind, query: string, year?: number): Promise<TmdbListItem | null> {
    const r = await this.get<any>(`/search/${kind}`, {
      query,
      [kind === 'movie' ? 'year' : 'first_air_date_year']: year,
      include_adult: 'false',
    });
    let res = r.results || [];
    if (!res.length && year) {
      const r2 = await this.get<any>(`/search/${kind}`, { query, include_adult: 'false' });
      res = r2.results || [];
    }
    return res.length ? this.toItem(res[0]) : null;
  }

  async details(kind: Kind, id: number): Promise<TmdbDetails> {
    const langShort = this.lang.slice(0, 2);
    const r = await this.get<any>(`/${kind}/${id}`, {
      append_to_response: `images,credits,videos,external_ids,recommendations,${kind === 'movie' ? 'release_dates' : 'content_ratings'}`,
      include_image_language: `${langShort},en,null`,
      include_video_language: `${langShort},en`,
    });
    const logos: any[] = r.images?.logos || [];
    const pickLogo =
      logos.find((l) => l.iso_639_1 === langShort) || logos.find((l) => l.iso_639_1 === 'en') || logos.find((l) => !l.iso_639_1);
    const videos: any[] = r.videos?.results || [];
    const trailer = videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer') || videos.find((v) => v.site === 'YouTube');
    const director = (r.credits?.crew || []).find((c: any) => c.job === 'Director')?.name || (r.created_by || [])[0]?.name;
    const runtime = r.runtime || (r.episode_run_time || [])[0];
    return {
      tmdbId: r.id,
      title: r.title || r.name,
      year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10) || undefined,
      poster: img(r.poster_path, 'w342'),
      backdrop: img(r.backdrop_path, 'w1280'),
      logo: img(pickLogo?.file_path, 'w500'),
      plot: r.overview || undefined,
      rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : undefined,
      genres: (r.genres || []).map((g: any) => g.name),
      cast: (r.credits?.cast || []).slice(0, 10).map((c: any) => c.name),
      director,
      trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : undefined,
      durationSec: runtime ? runtime * 60 : undefined,
      origLang: r.original_language || undefined,
      imdbId: r.external_ids?.imdb_id || r.imdb_id || undefined,
      ...this.certification(kind, r),
      recos: (r.recommendations?.results || []).slice(0, 20).map((x: any) => x.id as number),
      people: (r.credits?.cast || []).slice(0, 15).map((c: any) => ({
        id: c.id, name: c.name, character: c.character || undefined, photo: img(c.profile_path, 'w185'),
      })),
      collection: r.belongs_to_collection ? { id: r.belongs_to_collection.id, name: r.belongs_to_collection.name } : undefined,
    };
  }

  /** age rating for the user's country (FR for French, US otherwise), then FR/US/GB as fallbacks */
  private certification(kind: Kind, r: any): { cert?: string; certAge?: number } {
    const pref = this.lang.split('-')[1] || 'FR';
    const order = [...new Set([pref, 'FR', 'US', 'GB', 'DE'])];
    if (kind === 'movie') {
      const byC = new Map<string, string>();
      for (const c of r.release_dates?.results || []) {
        // theatrical / digital releases carry the certification
        const cert = (c.release_dates || []).map((d: any) => d.certification).find((x: string) => x && x.trim());
        if (cert) byC.set(c.iso_3166_1, cert.trim());
      }
      for (const c of order) if (byC.has(c)) return { cert: byC.get(c), certAge: certToAge(c, byC.get(c)!) };
    } else {
      const byC = new Map<string, string>((r.content_ratings?.results || []).filter((x: any) => x.rating).map((x: any) => [x.iso_3166_1, String(x.rating).trim()]));
      for (const c of order) if (byC.has(c)) return { cert: byC.get(c), certAge: certToAge(c, byC.get(c)!) };
    }
    return {};
  }

  async collection(id: number): Promise<TmdbCollection> {
    const r = await this.get<any>(`/collection/${id}`);
    return {
      id: r.id,
      name: r.name,
      overview: r.overview || undefined,
      backdrop: img(r.backdrop_path, 'w1280'),
      parts: (r.parts || []).map((p: any) => ({
        tmdbId: p.id, title: p.title, year: parseInt((p.release_date || '').slice(0, 4), 10) || undefined, poster: img(p.poster_path, 'w342'),
      })),
    };
  }

  async person(id: number): Promise<TmdbPerson> {
    const r = await this.get<any>(`/person/${id}`, { append_to_response: 'combined_credits' });
    // biographies are often missing in French: fall back to English
    let bio: string | undefined = r.biography || undefined;
    if (!bio && !this.lang.startsWith('en')) {
      try {
        bio = (await new Tmdb(this.token, 'en-US', this.minGapMs).get<any>(`/person/${id}`)).biography || undefined;
      } catch {
        /* no bio */
      }
    }
    const credits: TmdbPerson['credits'] = [];
    for (const c of [...(r.combined_credits?.cast || []), ...(r.combined_credits?.crew || []).filter((x: any) => x.job === 'Director')]) {
      if (c.media_type !== 'movie' && c.media_type !== 'tv') continue;
      credits.push({
        kind: c.media_type,
        tmdbId: c.id,
        title: c.title || c.name,
        year: parseInt((c.release_date || c.first_air_date || '').slice(0, 4), 10) || undefined,
        character: c.character || undefined,
        job: c.job || undefined,
        popularity: c.popularity || 0,
      });
    }
    return {
      id: r.id, name: r.name, bio, birthday: r.birthday || undefined, deathday: r.deathday || undefined,
      place: r.place_of_birth || undefined, photo: img(r.profile_path, 'w500'), knownFor: r.known_for_department || undefined, credits,
    };
  }

  async seasonStills(tvId: number, season: number): Promise<Record<number, { still?: string; plot?: string; title?: string }>> {
    const r = await this.get<any>(`/tv/${tvId}/season/${season}`);
    const out: Record<number, { still?: string; plot?: string; title?: string }> = {};
    for (const e of r.episodes || []) out[e.episode_number] = { still: img(e.still_path, 'w300'), plot: e.overview || undefined, title: e.name };
    return out;
  }
}
