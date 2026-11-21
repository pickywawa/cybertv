import { db } from '@/core/db';
import type { Channel, Program, WatchState } from '@/core/types';
import { playChannelRequest, playEpisodeRequest, playMovieRequest } from '@/core/playback';
import { useApp } from '@/state/store';
import { dataWorker } from '@/core/workers';
import { loadXtreamEpisodesIfNeeded } from './episodes';

export function openMovie(id: string) {
  useApp.getState().push({ name: 'movie', id });
}
export function openSeries(id: string) {
  useApp.getState().push({ name: 'series', id });
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
  const m = await db.movies.get(id);
  if (!m) return;
  useApp.getState().play(await playMovieRequest(m, startAt));
}

export async function playEpisode(seriesId: string, episodeId: string, startAt?: number) {
  const [s, e] = await Promise.all([db.series.get(seriesId), db.episodes.get(episodeId)]);
  if (!s || !e) return;
  useApp.getState().play(await playEpisodeRequest(s, e, startAt));
}

export async function resume(w: WatchState) {
  if (w.kind === 'movie') return playMovie(w.itemId, w.positionSec);
  if (w.kind === 'episode' && w.seriesId) {
    await loadXtreamEpisodesIfNeeded(w.seriesId);
    return playEpisode(w.seriesId, w.itemId, w.positionSec);
  }
}

export function prioritizeEnrichment(kind: 'movie' | 'series', items: { id: string; enrichedAt?: number }[]) {
  const ids = items.filter((x) => !x.enrichedAt).map((x) => x.id);
  if (ids.length) void dataWorker().prioritize(kind, ids);
}
