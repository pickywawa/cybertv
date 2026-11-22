import { db } from '@/core/db';
import type { Channel, Program, WatchState } from '@/core/types';
import { playChannelRequest, playEpisodeRequest, playMovieRequest } from '@/core/playback';
import { useApp } from '@/state/store';
import { t } from '@/core/i18n';
import { dataWorker } from '@/core/workers';
import { loadXtreamEpisodesIfNeeded } from './episodes';
import { needsEnrich } from '@/core/enrich/enrich';
import { replayInfo, replayPlayRequest, officialPlayRequest, type OfficialLive, type ReplayItem } from '@/core/replay';
import { getProgress } from '@/core/repo';

/**
 * Parental control by age: a title rated above the profile's limit asks for the PIN first
 * (once unlocked, the session stays unlocked like for adult channels).
 */
async function ageGate(kind: 'movie' | 'series', id: string, go: () => void) {
  const st = useApp.getState();
  const par = st.profile?.parental;
  if (!par?.enabled || par.maxAge === undefined || st.unlockedAdult) return go();
  const it = kind === 'movie' ? await db.movies.get(id) : await db.series.get(id);
  if (it?.certAge === undefined || it.certAge <= par.maxAge) return go();
  st.toast(t('age.locked', { n: it.certAge }));
  window.dispatchEvent(new CustomEvent('cyber:pin', { detail: go }));
}

export function openMovie(id: string) {
  void ageGate('movie', id, () => useApp.getState().push({ name: 'movie', id }));
}
export function openSeries(id: string) {
  void ageGate('series', id, () => useApp.getState().push({ name: 'series', id }));
}
export function openChannel(id: string) {
  useApp.getState().push({ name: 'channel', id });
}

export async function playChannel(ch: Channel, opts: { program?: Program; fromStart?: boolean; zapList?: string[] } = {}) {
  const st = useApp.getState();
  if (ch.universe === 'adult' && st.profile?.parental.enabled && !st.unlockedAdult) {
    window.dispatchEvent(new CustomEvent('cyber:pin', { detail: () => void playChannel(ch, opts) }));
    return;
  }
  const r = await playChannelRequest(ch, opts.program, opts.fromStart);
  st.play({ ...r, zapList: opts.zapList });
}

export async function playMovie(id: string, startAt?: number) {
  await ageGate('movie', id, async () => {
    const m = await db.movies.get(id);
    if (!m) return;
    useApp.getState().play(await playMovieRequest(m, startAt));
  });
}

export async function playEpisode(seriesId: string, episodeId: string, startAt?: number) {
  await ageGate('series', seriesId, async () => {
    const [s, e] = await Promise.all([db.series.get(seriesId), db.episodes.get(episodeId)]);
    if (!s || !e) return;
    useApp.getState().play(await playEpisodeRequest(s, e, startAt));
  });
}

/** parental age limit for replay titles (their own rating) */
function replayAgeGate(item: ReplayItem, go: () => void) {
  const st = useApp.getState();
  const par = st.profile?.parental;
  if (!par?.enabled || par.maxAge === undefined || st.unlockedAdult || item.age === undefined || item.age <= par.maxAge) return go();
  st.toast(t('age.locked', { n: item.age }));
  window.dispatchEvent(new CustomEvent('cyber:pin', { detail: go }));
}

export function openReplay(item: ReplayItem) {
  if (item.provider === 'youtube') return useApp.getState().push({ name: 'youtube', id: item.id.replace(/^yt:/, ''), title: item.title });
  replayAgeGate(item, () => useApp.getState().push({ name: 'replay', id: item.id, item }));
}

/** plays a replay video, from where it was left unless `startAt` is given */
export async function playReplay(item: ReplayItem, startAt?: number) {
  if (item.provider === 'youtube') return openReplay(item);
  const st = useApp.getState();
  const lang = st.profile?.lang || 'fr';
  replayAgeGate(item, async () => {
    try {
      let pos = startAt;
      if (pos === undefined && st.profile) {
        const w = await getProgress(st.profile.id, `replay:${item.id}`);
        if (w && !w.completed && w.positionSec > 30) pos = w.positionSec;
      }
      useApp.getState().play(await replayPlayRequest(item, lang, pos));
    } catch (e) {
      const m = String((e as Error)?.message || '');
      st.toast(t(m === 'drm' ? 'replay.drm' : m === 'geo' || /HTTP 4/.test(m) ? 'replay.geo' : 'replay.unavailable'));
    }
  });
}

export async function playOfficial(o: OfficialLive) {
  const st = useApp.getState();
  try {
    st.play(await officialPlayRequest(o, st.profile?.lang || 'fr'));
  } catch {
    st.toast(t('replay.geo'));
  }
}

export async function resume(w: WatchState) {
  if (w.kind === 'replay') {
    const lang = useApp.getState().profile?.lang || 'fr';
    const item = await replayInfo(w.itemId, lang).catch(() => null);
    return playReplay(item || { id: w.itemId, provider: w.itemId.startsWith('arte') ? 'arte' : 'francetv', kind: 'video', title: w.title, subtitle: w.subtitle, image: w.image }, w.positionSec);
  }
  if (w.kind === 'movie') return playMovie(w.itemId, w.positionSec);
  if (w.kind === 'episode' && w.seriesId) {
    await loadXtreamEpisodesIfNeeded(w.seriesId);
    return playEpisode(w.seriesId, w.itemId, w.positionSec);
  }
}

export function prioritizeEnrichment(kind: 'movie' | 'series', items: { id: string; enrichedAt?: number; enrichV?: number; tmdbId?: number }[]) {
  const ids = items.filter(needsEnrich).map((x) => x.id);
  if (ids.length) void dataWorker().prioritize(kind, ids);
}
