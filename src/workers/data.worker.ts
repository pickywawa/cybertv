/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { setProxyBase } from '@/core/net/http';
import { syncProfile, syncEpg, syncSource, testSource, loadXtreamEpisodes, prefetchPlan, fillMissingEpgIds } from '@/core/sync/sync';
import { takePrefetchHits } from '@/core/net/http';
import { Tmdb } from '@/core/enrich/tmdb';
import { Enricher, enrichSeason, refreshLists } from '@/core/enrich/enrich';
import { db, getMeta, setMeta } from '@/core/db';
import type { TmdbCollection, TmdbPerson } from '@/core/enrich/tmdb';
import type { Source, SyncProgress } from '@/core/types';

type Secrets = Record<string, string | undefined>;
let enricher: Enricher | null = null;
let tmdb: Tmdb | null = null;
let busy = false;

const api = {
  init(proxyBase: string | null) {
    setProxyBase(proxyBase);
  },

  async syncProfile(profileId: string, secrets: Secrets, onProgress: (p: SyncProgress) => void, withEpg = true) {
    if (busy) return false;
    busy = true;
    try {
      await syncProfile(profileId, secrets, onProgress, withEpg);
      return true;
    } finally {
      busy = false;
    }
  },

  async fillEpgIds(profileId: string) {
    return fillMissingEpgIds(profileId);
  },
  async syncEpg(profileId: string, secrets: Secrets, onProgress: (p: SyncProgress) => void) {
    await syncEpg(profileId, secrets, onProgress);
  },

  async syncSource(sourceId: string, password: string | undefined, onProgress: (p: SyncProgress) => void) {
    const s = await db.sources.get(sourceId);
    if (!s) return null;
    return syncSource(s, password, onProgress);
  },

  prefetchPlan(profileId: string, secrets: Secrets) {
    return prefetchPlan(profileId, secrets);
  },

  /** how many requests of the last sync were served from the background pre-download */
  prefetchHits() {
    return takePrefetchHits();
  },

  testSource(src: Pick<Source, 'type' | 'url' | 'username' | 'servers'>, password?: string) {
    return testSource(src, password);
  },

  loadEpisodes(seriesId: string, password: string) {
    return loadXtreamEpisodes(seriesId, password);
  },

  async startEnrichment(profileId: string, token: string | null, lang: string, onUpdate: () => void) {
    enricher?.stop();
    enricher = null;
    tmdb = null;
    if (!token) return;
    tmdb = new Tmdb(token, lang === 'en' ? 'en-US' : 'fr-FR');
    try {
      await refreshLists(tmdb, lang);
      onUpdate();
    } catch {
      /* offline or bad token: retried on next start */
    }
    enricher = new Enricher(tmdb, profileId, onUpdate);
    void enricher.run();
  },

  async refreshLists(lang: string) {
    if (tmdb) await refreshLists(tmdb, lang, true);
  },

  prioritize(kind: 'movie' | 'series', ids: string[]) {
    enricher?.prioritize(kind, ids);
  },

  async enrichSeason(seriesId: string, season: number) {
    if (tmdb) await enrichSeason(tmdb, seriesId, season);
  },

  /** saga parts (cached a week) */
  async tmdbCollection(id: number): Promise<TmdbCollection | null> {
    const key = `tmdb:collection:${id}`;
    const c = await getMeta<{ at: number; v: TmdbCollection }>(key);
    if (c && Date.now() - c.at < 7 * 86400000) return c.v;
    if (!tmdb) return c?.v || null;
    try {
      const v = await tmdb.collection(id);
      await setMeta(key, { at: Date.now(), v });
      return v;
    } catch {
      return c?.v || null;
    }
  },

  /** actor / director page (cached 3 days) */
  async tmdbPerson(id: number): Promise<TmdbPerson | null> {
    const key = `tmdb:person:${id}`;
    const c = await getMeta<{ at: number; v: TmdbPerson }>(key);
    if (c && Date.now() - c.at < 3 * 86400000) return c.v;
    if (!tmdb) return c?.v || null;
    try {
      const v = await tmdb.person(id);
      await setMeta(key, { at: Date.now(), v });
      return v;
    } catch {
      return c?.v || null;
    }
  },

  async validateTmdb(token: string) {
    return new Tmdb(token).validate();
  },
};

export type DataApi = typeof api;
Comlink.expose(api);
