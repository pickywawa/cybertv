import { db, getMeta, setMeta } from '../db';
import type { Category, Channel, Episode, Movie, Program, Series, Source, SyncProgress, Universe } from '../types';
import { XtreamClient, asArray, num, normalizeServer } from '../sources/xtream';
import { M3uParser, classifyEntry, type M3uEntry } from '../sources/m3u';
import { fetchTextStream, lines } from '../net/http';
import {
  channelGroupKey, cleanName, detectQuality, detectUniverse, movieGroupKey, norm, parseEpisode, parseTitleYear, seriesGroupKey,
} from '../util/text';
import { parseXmltv, type XmltvChannel } from '../epg/xmltv';
import { channelCountry, channelLangs, detectLangs } from '../util/lang';
import { serversOf, serverLabel } from '../sources/servers';

export type Progress = (p: SyncProgress) => void;

const BATCH = 2000;
const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

async function bulkPutBatched<T>(table: { bulkPut(items: T[]): Promise<unknown> }, rows: T[]) {
  for (let i = 0; i < rows.length; i += BATCH) await table.bulkPut(rows.slice(i, i + BATCH));
}

/** Remove rows of a source that disappeared from the provider */
async function pruneStale(table: any, sourceId: string, keep: Set<string>) {
  const ids: string[] = await table.where('sourceId').equals(sourceId).primaryKeys();
  const stale = ids.filter((id) => !keep.has(id));
  for (let i = 0; i < stale.length; i += BATCH) await table.bulkDelete(stale.slice(i, i + BATCH));
}

const ENRICH_FIELDS = ['poster', 'backdrop', 'logo', 'plot', 'rating', 'genres', 'cast', 'director', 'trailer', 'tmdbId', 'durationSec', 'year', 'enrichedAt', 'origLang'] as const;

/** keep TMDB enrichment & first-seen date when a row is re-synced */
async function mergeExisting<T extends Movie | Series>(table: any, sourceId: string, rows: T[], firstSync: boolean) {
  const existing: Map<string, T> = new Map();
  await table.where('sourceId').equals(sourceId).each((r: T) => existing.set(r.id, r));
  const now = Date.now();
  for (const r of rows) {
    const old = existing.get(r.id);
    if (!old) {
      if (!r.addedAt) r.addedAt = firstSync ? 0 : now;
      continue;
    }
    if (!r.addedAt) r.addedAt = old.addedAt;
    if (old.enrichedAt) {
      for (const f of ENRICH_FIELDS) {
        const v = (old as any)[f];
        if (v !== undefined && v !== null && v !== '') (r as any)[f] = v;
      }
    }
    if ((old as Series).episodesLoadedAt) (r as Series).episodesLoadedAt = (old as Series).episodesLoadedAt;
    // languages learned from the real stream tracks beat provider tags
    if ((old as Movie).tracksAt) {
      (r as Movie).langs = (old as Movie).langs;
      (r as Movie).subs = (old as Movie).subs;
      (r as Movie).tracksAt = (old as Movie).tracksAt;
    }
  }
}

function catUniverse(cats: Map<string, Category>, id?: string): Universe | undefined {
  const u = id ? cats.get(id)?.universe : undefined;
  return u && u !== 'other' ? u : undefined;
}

// ───────────────────────────── Xtream ─────────────────────────────

async function syncXtream(src: Source, password: string, progress: Progress) {
  const x = new XtreamClient({ server: src.url, username: src.username!, password });
  const acc = await x.account();
  if (!acc.auth) throw new Error('Authentification Xtream refusée');
  const { auth: _a, ...account } = acc;
  src.account = account;
  const firstSync = !src.lastSyncAt;

  // LIVE
  progress({ sourceId: src.id, step: 'live' });
  const [lcats, lstreams] = await Promise.all([x.liveCategories(), x.liveStreams()]);
  const cats = new Map<string, Category>();
  const catRows: Category[] = [];
  const rawCat = new Map<string, string>();
  for (const c of [...asArray<any>(lcats)]) rawCat.set(`${src.id}:lc:${c.category_id}`, c.category_name || '');
  asArray<any>(lcats).forEach((c, i) => {
    const row: Category = {
      id: `${src.id}:lc:${c.category_id}`, sourceId: src.id, profileId: src.profileId, kind: 'live',
      name: cleanName(c.category_name || ''), universe: detectUniverse(c.category_name), order: i,
    };
    cats.set(row.id, row);
    catRows.push(row);
  });
  const channels: Channel[] = asArray<any>(lstreams)
    .filter((s) => !s.stream_type || s.stream_type === 'live' || s.stream_type === 'created_live')
    .map((s, i) => {
      const categoryId = `${src.id}:lc:${s.category_id}`;
      const archive = s.tv_archive === 1 || s.tv_archive === '1';
      const epgId = s.epg_channel_id ? String(s.epg_channel_id).toLowerCase() : undefined;
      const country = channelCountry(s.name || '', rawCat.get(categoryId), epgId);
      return {
        id: `${src.id}:l:${s.stream_id}`, sourceId: src.id, profileId: src.profileId, extId: String(s.stream_id),
        rawName: s.name || '', name: cleanName(s.name || ''), logo: s.stream_icon || undefined, categoryId,
        universe: catUniverse(cats, categoryId) || detectUniverse(s.name) || 'other',
        epgId,
        catchupDays: archive ? num(s.tv_archive_duration) || 1 : 0, catchupMode: archive ? 'xc' : null,
        quality: detectQuality(s.name || ''), groupKey: channelGroupKey(s.name || ''), num: num(s.num) ?? i + 1,
        country, langs: channelLangs(s.name || '', rawCat.get(categoryId), epgId, undefined, country),
      } satisfies Channel;
    });
  await bulkPutBatched(db.categories, catRows);
  await bulkPutBatched(db.channels, channels);
  await pruneStale(db.channels, src.id, new Set(channels.map((c) => c.id)));
  progress({ sourceId: src.id, step: 'live', count: channels.length });

  // VOD
  progress({ sourceId: src.id, step: 'vod' });
  const [vcats, vstreams] = await Promise.all([x.vodCategories().catch(() => []), x.vodStreams().catch(() => [])]);
  const vcatRows: Category[] = asArray<any>(vcats).map((c, i) => ({
    id: `${src.id}:vc:${c.category_id}`, sourceId: src.id, profileId: src.profileId, kind: 'vod',
    name: cleanName(c.category_name || ''), universe: detectUniverse(c.category_name), order: i,
  }));
  const vcatMap = new Map(vcatRows.map((c) => [c.id, c]));
  const vcatRaw = new Map(asArray<any>(vcats).map((c) => [`${src.id}:vc:${c.category_id}`, String(c.category_name || '')]));
  const movies: Movie[] = asArray<any>(vstreams).map((s) => {
    const { title, year: y } = parseTitleYear(s.name || '');
    const year = num(s.year) || y;
    const tmdbId = num(s.tmdb) || num(s.tmdb_id);
    const categoryId = `${src.id}:vc:${s.category_id}`;
    const li = detectLangs(s.name, vcatRaw.get(categoryId));
    return {
      id: `${src.id}:m:${s.stream_id}`, sourceId: src.id, profileId: src.profileId, extId: String(s.stream_id),
      rawName: s.name || '', title, year, poster: s.stream_icon || undefined,
      rating: num(s.rating) || (num(s.rating_5based) ? num(s.rating_5based)! * 2 : undefined),
      tmdbId, addedAt: (num(s.added) || 0) * 1000, ext: s.container_extension || 'mp4', categoryId,
      universe: catUniverse(vcatMap, categoryId) || 'cinema', groupKey: movieGroupKey(title, year, tmdbId), enrichedAt: 0,
      langs: li.audio, subs: li.subs,
    } satisfies Movie;
  });
  await mergeExisting(db.movies, src.id, movies, firstSync);
  await bulkPutBatched(db.categories, vcatRows);
  await bulkPutBatched(db.movies, movies);
  await pruneStale(db.movies, src.id, new Set(movies.map((m) => m.id)));
  progress({ sourceId: src.id, step: 'vod', count: movies.length });

  // SERIES
  progress({ sourceId: src.id, step: 'series' });
  const [scats, slist] = await Promise.all([x.seriesCategories().catch(() => []), x.series().catch(() => [])]);
  const scatRows: Category[] = asArray<any>(scats).map((c, i) => ({
    id: `${src.id}:sc:${c.category_id}`, sourceId: src.id, profileId: src.profileId, kind: 'series',
    name: cleanName(c.category_name || ''), universe: detectUniverse(c.category_name), order: i,
  }));
  const scatMap = new Map(scatRows.map((c) => [c.id, c]));
  const scatRaw = new Map(asArray<any>(scats).map((c) => [`${src.id}:sc:${c.category_id}`, String(c.category_name || '')]));
  const series: Series[] = asArray<any>(slist).map((s) => {
    const { title, year: y } = parseTitleYear(s.name || '');
    const tmdbId = num(s.tmdb) || num(s.tmdb_id);
    const categoryId = `${src.id}:sc:${s.category_id}`;
    const bd = asArray<string>(s.backdrop_path)[0];
    const li = detectLangs(s.name, scatRaw.get(categoryId));
    return {
      id: `${src.id}:s:${s.series_id}`, sourceId: src.id, profileId: src.profileId, extId: String(s.series_id),
      rawName: s.name || '', title, year: y || num(String(s.releaseDate || s.release_date || '').slice(0, 4)),
      poster: s.cover || undefined, backdrop: bd || undefined, plot: s.plot || undefined,
      rating: num(s.rating) || undefined, genres: s.genre ? String(s.genre).split(/[,/]/).map((g: string) => g.trim()).filter(Boolean) : undefined,
      cast: s.cast ? String(s.cast).split(',').map((c: string) => c.trim()).filter(Boolean).slice(0, 10) : undefined,
      tmdbId, addedAt: (num(s.last_modified) || 0) * 1000, categoryId,
      universe: catUniverse(scatMap, categoryId) || 'series', groupKey: seriesGroupKey(title, tmdbId), enrichedAt: 0,
      langs: li.audio, subs: li.subs,
    } satisfies Series;
  });
  await mergeExisting(db.series, src.id, series, firstSync);
  await bulkPutBatched(db.categories, scatRows);
  await bulkPutBatched(db.series, series);
  await pruneStale(db.series, src.id, new Set(series.map((m) => m.id)));
  await pruneStale(db.categories, src.id, new Set([...catRows, ...vcatRows, ...scatRows].map((c) => c.id)));
  src.counts = { live: channels.length, vod: movies.length, series: series.length };
  progress({ sourceId: src.id, step: 'series', count: series.length });
}

/** Lazily loads Xtream episodes of one series (M3U episodes are loaded at sync time) */
export async function loadXtreamEpisodes(seriesId: string, password: string): Promise<Episode[]> {
  const s = await db.series.get(seriesId);
  if (!s) return [];
  const src = await db.sources.get(s.sourceId);
  if (!src || src.type !== 'xtream') return db.episodes.where('seriesId').equals(seriesId).toArray();
  const x = new XtreamClient({ server: src.url, username: src.username!, password });
  const info = await x.seriesInfo(s.extId);
  const eps: Episode[] = [];
  const byS = info?.episodes || {};
  for (const [season, list] of Object.entries(byS)) {
    for (const e of asArray<any>(list)) {
      eps.push({
        id: `${src.id}:e:${e.id}`, seriesId, sourceId: src.id, extId: String(e.id),
        season: num(e.season) ?? (parseInt(season, 10) || 1), episode: num(e.episode_num) ?? eps.length + 1,
        title: cleanName(e.title || '').replace(new RegExp(`^${s.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–:]?\\s*`, 'i'), '') || `Épisode ${e.episode_num}`,
        plot: e.info?.plot || undefined, still: e.info?.movie_image || undefined,
        durationSec: num(e.info?.duration_secs), ext: e.container_extension || 'mp4',
      });
    }
  }
  await db.transaction('rw', db.episodes, db.series, async () => {
    const old = await db.episodes.where('seriesId').equals(seriesId).primaryKeys();
    await db.episodes.bulkDelete(old);
    await db.episodes.bulkPut(eps);
    const patch: Partial<Series> = { episodesLoadedAt: Date.now() };
    const i = info?.info || {};
    if (!s.plot && i.plot) patch.plot = i.plot;
    if (!s.tmdbId && num(i.tmdb)) patch.tmdbId = num(i.tmdb);
    await db.series.update(seriesId, patch);
  });
  return eps;
}

// ───────────────────────────── M3U ─────────────────────────────

async function syncM3u(src: Source, progress: Progress) {
  const firstSync = !src.lastSyncAt;
  progress({ sourceId: src.id, step: 'live', message: 'Téléchargement de la playlist' });
  const stream = await fetchTextStream(src.url, 300000);

  const cats = new Map<string, Category>();
  const channels: Channel[] = [];
  const movies: Movie[] = [];
  const seriesMap = new Map<string, Series>();
  const episodes: Episode[] = [];
  let order = 0;

  const catFor = (kind: Category['kind'], name: string) => {
    const key = `${src.id}:${kind[0]}c:${fnv(name)}`;
    let c = cats.get(key);
    if (!c) {
      c = { id: key, sourceId: src.id, profileId: src.profileId, kind, name: cleanName(name || 'Autres'), universe: detectUniverse(name), order: order++ };
      cats.set(key, c);
    }
    return c;
  };

  const onEntry = (e: M3uEntry) => {
    const kind = classifyEntry(e);
    const group = e.attrs['group-title'] || '';
    const logo = e.attrs['tvg-logo'] || undefined;
    if (kind === 'live') {
      const c = catFor('live', group);
      const cu = (e.attrs['catchup'] || e.attrs['catchup-type'] || '').toLowerCase();
      const days = num(e.attrs['catchup-days']) || num(e.attrs['timeshift']) || num(e.attrs['tvg-rec']) || 0;
      let mode: Channel['catchupMode'] = null;
      if (['xc', 'default', 'append', 'shift', 'flussonic'].includes(cu)) mode = cu as Channel['catchupMode'];
      else if (cu === 'fs' || cu === 'flussonic-hls' || cu === 'flussonic-ts') mode = 'flussonic';
      else if (days > 0 && /\/\d+\.(ts|m3u8)$/.test(e.url)) mode = 'xc';
      const extId = e.url.match(/\/(\d+)(?:\.\w+)?$/)?.[1] || fnv(e.url);
      const epgId = (e.attrs['tvg-id'] || '').toLowerCase() || undefined;
      const country = channelCountry(e.name, group, epgId, e.attrs['tvg-country']);
      channels.push({
        id: `${src.id}:l:${fnv(e.url)}`, sourceId: src.id, profileId: src.profileId, extId,
        rawName: e.name, name: cleanName(e.name), logo, categoryId: c.id,
        universe: (c.universe !== 'other' ? c.universe : detectUniverse(e.name)) || 'other',
        epgId,
        country, langs: channelLangs(e.name, group, epgId, e.attrs['tvg-language'], country),
        catchupDays: mode ? days || 7 : 0, catchupMode: mode, catchupSource: e.attrs['catchup-source'] || undefined,
        quality: detectQuality(e.name), groupKey: channelGroupKey(e.name), num: num(e.attrs['tvg-chno']) ?? channels.length + 1, url: e.url,
      });
    } else if (kind === 'movie') {
      const c = catFor('vod', group);
      const { title, year } = parseTitleYear(e.name);
      const li = detectLangs(e.name, group, e.attrs['tvg-language']);
      movies.push({
        id: `${src.id}:m:${fnv(e.url)}`, sourceId: src.id, profileId: src.profileId, extId: fnv(e.url), rawName: e.name,
        title, year, poster: logo, addedAt: 0, ext: e.url.split('?')[0].split('.').pop() || 'mp4', categoryId: c.id,
        universe: c.universe !== 'other' ? c.universe : 'cinema', groupKey: movieGroupKey(title, year), enrichedAt: 0, url: e.url,
        langs: li.audio, subs: li.subs,
      });
    } else {
      const c = catFor('series', group);
      const ep = parseEpisode(e.name) || { show: cleanName(e.name), season: 1, episode: episodes.length + 1 };
      const { title, year } = parseTitleYear(ep.show);
      const sid = `${src.id}:s:${fnv(norm(title))}`;
      if (!seriesMap.has(sid)) {
        seriesMap.set(sid, {
          id: sid, sourceId: src.id, profileId: src.profileId, extId: fnv(norm(title)), rawName: ep.show, title, year,
          poster: logo, addedAt: 0, categoryId: c.id, universe: c.universe !== 'other' ? c.universe : 'series',
          groupKey: seriesGroupKey(title), enrichedAt: 0, episodesLoadedAt: Date.now(),
          ...(() => {
            const li = detectLangs(e.name, group, e.attrs['tvg-language']);
            return { langs: li.audio, subs: li.subs };
          })(),
        });
      }
      episodes.push({
        id: `${src.id}:e:${fnv(e.url)}`, seriesId: sid, sourceId: src.id, extId: fnv(e.url), season: ep.season, episode: ep.episode,
        title: `Épisode ${ep.episode}`, still: logo, ext: e.url.split('?')[0].split('.').pop() || 'mp4', url: e.url,
      });
    }
  };

  const parser = new M3uParser(onEntry);
  let n = 0;
  for await (const line of lines(stream)) {
    parser.push(line);
    if (++n % 50000 === 0) progress({ sourceId: src.id, step: 'live', message: `${parser.count} entrées lues` });
  }
  if (!parser.count) throw new Error('Playlist vide ou invalide');
  await setMeta(`epg:auto:${src.id}`, parser.header.epgUrls);

  const series = [...seriesMap.values()];
  await mergeExisting(db.movies, src.id, movies, firstSync);
  await mergeExisting(db.series, src.id, series, firstSync);
  const catRows = [...cats.values()];
  await bulkPutBatched(db.categories, catRows);
  await bulkPutBatched(db.channels, channels);
  await bulkPutBatched(db.movies, movies);
  await bulkPutBatched(db.series, series);
  await bulkPutBatched(db.episodes, episodes);
  await pruneStale(db.categories, src.id, new Set(catRows.map((c) => c.id)));
  await pruneStale(db.channels, src.id, new Set(channels.map((c) => c.id)));
  await pruneStale(db.movies, src.id, new Set(movies.map((c) => c.id)));
  await pruneStale(db.series, src.id, new Set(series.map((c) => c.id)));
  await pruneStale(db.episodes, src.id, new Set(episodes.map((c) => c.id)));
  src.counts = { live: channels.length, vod: movies.length, series: series.length };
  progress({ sourceId: src.id, step: 'live', count: channels.length });
  progress({ sourceId: src.id, step: 'vod', count: movies.length });
  progress({ sourceId: src.id, step: 'series', count: series.length });
}

// ───────────────────────────── EPG ─────────────────────────────

export async function epgUrlsForProfile(profileId: string, secrets: Record<string, string | undefined>): Promise<string[]> {
  const sources = (await db.sources.where('profileId').equals(profileId).toArray()).filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
  const urls: string[] = [];
  for (const s of sources) {
    urls.push(...(s.epgUrls || []));
    if (s.type === 'xtream') urls.push(new XtreamClient({ server: s.url, username: s.username!, password: secrets[s.id] || '' }).xmltvUrl());
    else urls.push(...((await getMeta<string[]>(`epg:auto:${s.id}`)) || []));
  }
  // free national guide as a last resort (only fills channels no other guide covers)
  const prof = await db.profiles.get(profileId);
  const country = prof?.country || (prof?.lang === 'fr' ? 'FR' : undefined);
  if (country && DEFAULT_EPG[country]) urls.push(DEFAULT_EPG[country]);
  return [...new Set(urls.filter(Boolean))];
}

/** public XMLTV guides (ids like "TF1.fr", matching iptv-org's "tf1.fr@SD") */
const DEFAULT_EPG: Record<string, string> = {
  FR: 'https://xmltvfr.fr/xmltv/xmltv_tnt.xml.gz',
};

/** "tf1.fr@sd" → "tf1.fr" (iptv-org feed suffix) */
const epgBase = (id: string) => id.split('@')[0];

export async function syncEpg(profileId: string, secrets: Record<string, string | undefined>, progress: Progress) {
  const urls = await epgUrlsForProfile(profileId, secrets);
  if (!urls.length) return;
  const channels = await db.channels.where('profileId').equals(profileId).toArray();
  const byEpg = new Set(channels.map((c) => c.epgId).filter(Boolean) as string[]);
  const byBase = new Map<string, Channel[]>();
  for (const c of channels) if (c.epgId && c.epgId.includes('@')) {
    const b = epgBase(c.epgId);
    (byBase.get(b) || byBase.set(b, []).get(b)!).push(c);
  }
  const byName = new Map<string, Channel[]>();
  for (const c of channels) {
    const k = norm(c.name);
    (byName.get(k) || byName.set(k, []).get(k)!).push(c);
  }
  const maxCatchup = Math.max(1, ...channels.map((c) => c.catchupDays || 0));
  const from = Date.now() - Math.min(maxCatchup, 7) * 86400000 - 3600000;
  const to = Date.now() + 3 * 86400000;
  const covered = new Set<string>();

  for (const url of urls) {
    progress({ step: 'epg', message: url.replace(/(password|username)=[^&]+/g, '$1=***') });
    try {
      const stream = await fetchTextStream(url, 300000);
      const docMapped = new Set<string>();
      const channelPatches: { id: string; epgId: string }[] = [];
      let first = true;
      const res = await parseXmltv(stream, {
        from,
        to,
        onChannels: (xch: XmltvChannel[]) => {
          const map = new Map<string, string>();
          const docIds = new Set(xch.map((x) => x.id.toLowerCase()));
          for (const x of xch) {
            const xid = x.id.toLowerCase();
            if (covered.has(xid)) continue;
            if (byEpg.has(xid)) {
              map.set(x.id, xid);
              continue;
            }
            // same channel id without the feed suffix
            const base = byBase.get(xid);
            if (base?.length) {
              for (const h of base) channelPatches.push({ id: h.id, epgId: xid });
              map.set(x.id, xid);
              continue;
            }
            for (const n of x.names) {
              const hits = byName.get(norm(cleanName(n)));
              if (hits?.length) {
                // name match unless the channel's own id is served by this guide
                for (const h of hits) if (!h.epgId || (!docIds.has(h.epgId) && !covered.has(h.epgId))) channelPatches.push({ id: h.id, epgId: xid });
                map.set(x.id, xid);
                break;
              }
            }
          }
          for (const v of map.values()) docMapped.add(v);
          return map;
        },
        onPrograms: async (batch: Program[]) => {
          if (first) {
            first = false;
            // replace previous data of the channels this document covers
            for (const id of docMapped) await db.programs.where('[epgId+start]').between([id, -Infinity], [id, Infinity]).delete();
          }
          await db.programs.bulkAdd(batch);
          progress({ step: 'epg', count: batch.length });
        },
      });
      for (const p of channelPatches) await db.channels.update(p.id, { epgId: p.epgId });
      for (const p of channelPatches) byEpg.add(p.epgId);
      for (const id of docMapped) covered.add(id);
      progress({ step: 'epg', message: `${res.programs} programmes` });
    } catch (e) {
      progress({ step: 'epg', message: `EPG ignoré : ${(e as Error).message}` });
    }
  }
  await db.programs.where('start').below(Date.now() - 8 * 86400000).delete();
  await setMeta(`epg:last:${profileId}`, Date.now());
}

// ───────────────────────────── Orchestration ─────────────────────────────

/**
 * Syncs a source on the server in use; when it fails, tries the backup servers in order.
 * The first one that works becomes the server in use (persisted, so the next start uses it too).
 */
export async function syncSource(src: Source, password: string | undefined, progress: Progress): Promise<Source> {
  progress({ sourceId: src.id, step: 'start' });
  const servers = serversOf(src);
  const errors: string[] = [];
  let ok = false;
  for (const [i, server] of servers.entries()) {
    src.url = server;
    if (i > 0) progress({ sourceId: src.id, step: 'start', message: `Serveur de secours : ${serverLabel(server)}` });
    try {
      if (src.type === 'xtream') await syncXtream(src, password || '', progress);
      else await syncM3u(src, progress);
      ok = true;
      break;
    } catch (e) {
      errors.push(`${serverLabel(server)} : ${(e as Error).message.replace(/ — .*$/, '')}`);
    }
  }
  if (ok) {
    src.status = errors.length ? 'degraded' : 'ok';
    // keep a trace of the failover for the source card
    src.lastError = errors.length ? `Bascule sur ${serverLabel(src.url)} (${errors.join(' · ')})` : undefined;
    src.lastSyncAt = Date.now();
  } else {
    // nothing works: stay on the first server for the next attempt
    src.url = servers[0];
    src.status = 'down';
    src.lastError = errors.join(' · ');
    progress({ sourceId: src.id, step: 'error', message: src.lastError });
  }
  await db.sources.put(src);
  return src;
}

export async function syncProfile(profileId: string, secrets: Record<string, string | undefined>, progress: Progress, withEpg = true) {
  const sources = (await db.sources.where('profileId').equals(profileId).toArray()).filter((s) => s.enabled).sort((a, b) => a.priority - b.priority);
  for (const s of sources) await syncSource(s, secrets[s.id], progress);
  if (withEpg) await syncEpg(profileId, secrets, progress);
  await db.profiles.update(profileId, { lastSyncAt: Date.now() });
  await setMeta(`catalog:version:${profileId}`, Date.now());
  progress({ step: 'done' });
}

export interface ServerTest {
  server: string;
  ok: boolean;
  message: string;
}

async function testOne(
  src: Pick<Source, 'type' | 'url' | 'username'>,
  password?: string,
): Promise<{ ok: boolean; message: string; account?: Source['account'] }> {
  try {
    if (src.type === 'xtream') {
      const acc = await new XtreamClient({ server: normalizeServer(src.url), username: src.username || '', password: password || '' }).account();
      if (!acc.auth) return { ok: false, message: 'auth' };
      const { auth: _a, ...account } = acc;
      return { ok: true, message: 'ok', account };
    }
    const stream = await fetchTextStream(src.url, 30000);
    const reader = stream.getReader();
    let head = '';
    while (head.length < 4096) {
      const { value, done } = await reader.read();
      if (done) break;
      head += value;
    }
    reader.cancel().catch(() => {});
    if (!/#EXTM3U|#EXTINF/i.test(head)) return { ok: false, message: 'notm3u' };
    return { ok: true, message: 'ok' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * "Tester" button: tries the servers in order and stops at the first one that answers.
 * `server` is the one to use (the UI switches to it), `tried` lists every attempt.
 */
export async function testSource(
  src: Pick<Source, 'type' | 'url' | 'username' | 'servers'>,
  password?: string,
): Promise<{ ok: boolean; message: string; account?: Source['account']; server?: string; tried: ServerTest[] }> {
  const tried: ServerTest[] = [];
  for (const server of serversOf(src)) {
    const r = await testOne({ ...src, url: server }, password);
    tried.push({ server, ok: r.ok, message: r.message });
    if (r.ok) return { ...r, server, tried };
  }
  const last = tried[tried.length - 1];
  return { ok: false, message: last?.message || 'no server', tried };
}
