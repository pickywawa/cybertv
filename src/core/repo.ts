import { db, getMeta, setMeta } from './db';
import type { Channel, Episode, Favorite, Movie, Program, Series, Source, Universe, WatchState } from './types';
import { cleanName, LIVE_QUALITY_RANK } from './util/text';
import { secureGet, sourcePassKey } from './secure';
import type { LangPrefs } from './util/lang';
import { dedupLang } from './catalog';

// catalogue-wide queries live in ./catalog (worker-safe); re-exported for existing callers
export {
  dedupLang, dedup, tmdbLists, matchMovies, matchSeries, latestMovies, latestSeries, moviesSample, gridMovies, gridSeries, invalidateCatalogIndex, type GridQuery,
} from './catalog';


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
    if (pa < pb || (pa === pb && (LIVE_QUALITY_RANK[String(c.quality)] ?? 0) > (LIVE_QUALITY_RANK[String(cur.quality)] ?? 0))) best.set(c.groupKey, c);
  }
  // names stored before the cleaner removed provider junk ("TF1 //")
  return [...best.values()].map((c) => (/[/\\|]\s*$/.test(c.name) ? { ...c, name: cleanName(c.name) } : c)).sort((a, b) => a.num - b.num);
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
  // 6 h back is enough for what is on air (a 12 h window doubled the rows read every minute)
  const rows = await db.programs.where('start').between(at - 6 * 3600000, at + 6 * 3600000).toArray();
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

/** programmes of the given guide ids over a period: indexed reads per channel, one read transaction */
export async function programsForMany(epgIds: string[], from: number, to: number): Promise<Map<string, Program[]>> {
  const map = new Map<string, Program[]>();
  await db.transaction('r', db.programs, async () => {
    await Promise.all(
      epgIds.map(async (id) => {
        const rows = await db.programs.where('[epgId+start]').between([id, from - 6 * 3600000], [id, to]).toArray();
        const list = rows.filter((p) => p.stop > from);
        if (list.length) map.set(id, list);
      }),
    );
  });
  return map;
}

export async function programsInRange(from: number, to: number): Promise<Map<string, Program[]>> {
  const rows = await db.programs.where('start').between(from - 6 * 3600000, to).filter((p) => p.stop > from).toArray();
  const map = new Map<string, Program[]>();
  for (const p of rows) (map.get(p.epgId) || map.set(p.epgId, []).get(p.epgId)!).push(p);
  for (const l of map.values()) l.sort((a, b) => a.start - b.start);
  return map;
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
    if (w.kind === 'movie' || w.kind === 'replay') {
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

/** the catalogue copies (data worker) are rebuilt on their next use */
async function catalogChanged(profileId: string | undefined) {
  if (profileId) await setMeta(`catalog:version:${profileId}`, Date.now());
}

export async function deleteProfileData(profileId: string) {
  await catalogChanged(profileId);
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
  await catalogChanged((await db.sources.get(sourceId))?.profileId);
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
