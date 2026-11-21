import { db } from '@/core/db';
import { dataWorker } from '@/core/workers';
import { loadSecrets } from '@/core/repo';

const inflight = new Map<string, Promise<void>>();

/** Xtream series episodes are fetched on demand and cached for 12 h */
export function loadXtreamEpisodesIfNeeded(seriesId: string, force = false): Promise<void> {
  const cur = inflight.get(seriesId);
  if (cur) return cur;
  const p = (async () => {
    const s = await db.series.get(seriesId);
    if (!s) return;
    const src = await db.sources.get(s.sourceId);
    if (!src || src.type !== 'xtream') return;
    if (!force && s.episodesLoadedAt && Date.now() - s.episodesLoadedAt < 12 * 3600000) return;
    const secrets = await loadSecrets(s.profileId);
    await dataWorker().loadEpisodes(seriesId, secrets[src.id] || '');
  })().finally(() => inflight.delete(seriesId));
  inflight.set(seriesId, p);
  return p;
}
