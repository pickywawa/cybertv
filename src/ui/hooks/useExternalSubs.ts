import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineTracks } from '@/core/player/engine';
import type { PlayRequest, Profile } from '@/core/types';
import { db, getMeta, setMeta } from '@/core/db';
import { langPrefs, subMode } from '@/core/prefs';
import { toLang } from '@/core/util/lang';
import { movieHash } from '@/core/subs/hash';
import { downloadSub, hasOsKey, OsError, rankSubs, searchSubs, type SubQuery, type SubResult } from '@/core/subs/opensubtitles';
import type { Cue } from '@/core/subs/parse';

export type ExtStatus = 'off' | 'idle' | 'searching' | 'none' | 'quota' | 'error' | 'ready';

export interface ExternalSubs {
  /** OpenSubtitles usable for this item (VOD + key + profile option) */
  enabled: boolean;
  status: ExtStatus;
  results: SubResult[];
  active: SubResult | null;
  cues: Cue[];
  /** seconds added to the cue times (negative = subtitles earlier) */
  offset: number;
  search(): Promise<void>;
  select(r: SubResult | null): Promise<void>;
  shift(delta: number): void;
}

async function itemQuery(req: PlayRequest, langs: string[]): Promise<{ q: SubQuery; hint: string; audio: string[] } | null> {
  if (req.kind === 'movie') {
    const m = await db.movies.get(req.itemId);
    if (!m) return null;
    return {
      q: { kind: 'movie', tmdbId: m.tmdbId, query: m.title, year: m.year, langs },
      hint: m.rawName,
      audio: m.langs?.length ? m.langs : m.origLang ? [m.origLang] : [],
    };
  }
  if (req.kind === 'episode' && req.seriesId) {
    const [e, s] = await Promise.all([db.episodes.get(req.itemId), db.series.get(req.seriesId)]);
    if (!e || !s) return null;
    return {
      q: { kind: 'episode', parentTmdbId: s.tmdbId, query: s.title, season: e.season, episode: e.episode, langs },
      hint: s.rawName,
      audio: s.langs?.length ? s.langs : s.origLang ? [s.origLang] : [],
    };
  }
  return null;
}

/**
 * External subtitles for VOD:
 * - automatic when the profile wants subtitles (always, or the audio isn't one of its languages)
 *   and the stream has no embedded track in a preferred subtitle language;
 * - the file hash is sent along so subtitles timed on this exact file come first (no drift);
 * - otherwise the user can pick another release and nudge the timing (kept per video).
 */
export function useExternalSubs(p: { req: PlayRequest; profile: Profile; tracks: EngineTracks; streamUrl?: string; vod: boolean; playing: boolean }): ExternalSubs {
  const { req, profile, tracks, streamUrl, vod, playing } = p;
  const [keyOk, setKeyOk] = useState(false);
  const [status, setStatus] = useState<ExtStatus>('idle');
  const [results, setResults] = useState<SubResult[]>([]);
  const [active, setActive] = useState<SubResult | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [offset, setOffset] = useState(0);
  const autoDone = useRef('');
  const itemKey = `${req.kind}:${req.itemId}`;
  const enabled = vod && keyOk && profile.subsOnline !== false;

  useEffect(() => void hasOsKey(profile.id).then(setKeyOk), [profile.id]);
  // new item: reset, restore its offset
  useEffect(() => {
    setStatus('idle');
    setResults([]);
    setActive(null);
    setCues([]);
    void getMeta<number>(`subOffset:${itemKey}`).then((o) => setOffset(o || 0));
  }, [itemKey]);

  const search = useCallback(async (): Promise<SubResult[]> => {
    const prefs = langPrefs(profile);
    const info = await itemQuery(req, prefs.subs);
    if (!info) return [];
    setStatus('searching');
    try {
      const hash = streamUrl ? await movieHash(streamUrl) : null;
      let list = await searchSubs(profile.id, { ...info.q, moviehash: hash?.hash });
      // a hash-only miss can hide everything: retry without it
      if (!list.length && hash) list = await searchSubs(profile.id, info.q);
      const ranked = rankSubs(list, prefs.subs, info.hint);
      setResults(ranked);
      setStatus(ranked.length ? 'ready' : 'none');
      return ranked;
    } catch (e) {
      setStatus(e instanceof OsError && e.code === 'quota' ? 'quota' : 'error');
      return [];
    }
  }, [profile, req, streamUrl]);

  const select = useCallback(
    async (r: SubResult | null) => {
      if (!r) {
        setActive(null);
        setCues([]);
        return;
      }
      try {
        const c = await downloadSub(profile.id, r.fileId);
        setCues(c);
        setActive(r);
        setStatus('ready');
      } catch (e) {
        setStatus(e instanceof OsError && e.code === 'quota' ? 'quota' : 'error');
      }
    },
    [profile.id],
  );

  const shift = useCallback(
    (delta: number) => {
      setOffset((o) => {
        const n = Math.round((o + delta) * 10) / 10;
        void setMeta(`subOffset:${itemKey}`, n);
        return n;
      });
    },
    [itemKey],
  );

  // automatic pick, once per item, when the stream's tracks are known
  useEffect(() => {
    if (!enabled || autoDone.current === itemKey) return;
    // decide once the stream runs (plain MP4s in the browser expose no track list at all)
    if (!playing && !tracks.audio.length && !tracks.text.length) return;
    autoDone.current = itemKey;
    const prefs = langPrefs(profile);
    const mode = subMode(profile);
    if (mode === 'off') return;
    // the stream already has subtitles in a preferred language
    if (tracks.text.some((x) => prefs.subs.includes(toLang(x.language || x.label) || ''))) return;
    void (async () => {
      const info = await itemQuery(req, prefs.subs);
      const sel = tracks.audio.find((a) => a.selected);
      const audioLang = toLang(sel?.language || sel?.label) || info?.audio[0];
      const foreign = !!audioLang && !prefs.audio.includes(audioLang);
      if (mode === 'auto' && !foreign) return;
      const ranked = await search();
      if (ranked[0]) await select(ranked[0]);
    })();
  }, [enabled, tracks, playing, itemKey, profile, req, search, select]);

  return {
    enabled,
    status: enabled ? status : 'off',
    results,
    active,
    cues,
    offset,
    search: async () => void (await search()),
    select,
    shift,
  };
}
