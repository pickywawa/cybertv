import { isGenericEpisodeTitle } from '@/core/util/text';
import { db } from './db';
import type { Channel, Episode, Movie, PlayRequest, Program, Series, Source } from './types';
import { catchupUrl, episodeUrl, liveUrl, movieUrl, type Engine } from './sources/urls';
import { loadSecrets, sourcesOf, watchKey } from './repo';
import { QUALITY_RANK } from './util/text';
import { isNative } from './platform';
import { t } from './i18n';

export const engineKind = (): Engine => (isNative ? 'native' : 'web');

async function ctx(profileId: string) {
  const [sources, secrets] = await Promise.all([sourcesOf(profileId), loadSecrets(profileId)]);
  const enabled = sources.filter((s) => s.enabled);
  return { byId: new Map<string, Source>(enabled.map((s) => [s.id, s])), order: new Map(enabled.map((s, i) => [s.id, i])), secrets };
}

const qlabel = (q: string | null) => q || 'Auto';

/** All variants of the same channel, preferred one first, then by source priority & quality */
export async function channelVariants(ch: Channel): Promise<Channel[]> {
  const { order } = await ctx(ch.profileId);
  const all = (await db.channels.where('groupKey').equals(ch.groupKey).toArray()).filter((c) => c.profileId === ch.profileId && order.has(c.sourceId));
  return all.sort((a, b) => {
    if (a.id === ch.id) return -1;
    if (b.id === ch.id) return 1;
    return order.get(a.sourceId)! - order.get(b.sourceId)! || (QUALITY_RANK[String(b.quality)] ?? 0) - (QUALITY_RANK[String(a.quality)] ?? 0);
  });
}

export async function playChannelRequest(ch: Channel, program?: Program, fromStart = false): Promise<PlayRequest> {
  const { byId, secrets } = await ctx(ch.profileId);
  const variants = await channelVariants(ch);
  const sources = await sourcesOf(ch.profileId);
  const multiSource = new Set(variants.map((v) => v.sourceId)).size > 1;
  const label = (v: Channel) => {
    const s = sources.find((x) => x.id === v.sourceId);
    return multiSource ? `${s?.label || ''} · ${qlabel(v.quality)}` : qlabel(v.quality);
  };
  const catchup = program && fromStart ? { start: program.start, stop: program.stop } : undefined;
  const candidates: PlayRequest['candidates'] = [];
  for (const v of variants) {
    const src = byId.get(v.sourceId);
    if (!src) continue;
    const url = catchup ? catchupUrl(v, src, secrets[src.id], catchup.start, Math.min(catchup.stop, Date.now())) : liveUrl(v, src, secrets[src.id], engineKind());
    if (url) candidates.push({ url, label: label(v), quality: v.quality, sourceId: v.sourceId });
  }
  return {
    kind: 'live',
    itemId: ch.id,
    channelId: ch.id,
    title: catchup ? program!.title : ch.name,
    subtitle: catchup ? `${ch.name} · ${t('tv.replay')}` : program?.title,
    logo: ch.logo,
    image: program?.icon,
    candidates,
    live: !catchup,
    catchup,
  };
}

export async function playMovieRequest(m: Movie, startAt?: number): Promise<PlayRequest> {
  const { byId, order, secrets } = await ctx(m.profileId);
  const variants = (await db.movies.where('groupKey').equals(m.groupKey).toArray())
    .filter((x) => x.profileId === m.profileId && order.has(x.sourceId))
    .sort((a, b) => (a.id === m.id ? -1 : b.id === m.id ? 1 : order.get(a.sourceId)! - order.get(b.sourceId)!));
  const candidates = variants
    .map((v) => {
      const src = byId.get(v.sourceId)!;
      return { url: movieUrl(v.extId, v.ext, src, secrets[src.id], v.url), label: src.label, quality: null, sourceId: src.id };
    })
    .filter((c) => !!c.url);
  return {
    kind: 'movie', itemId: m.id, title: m.title, subtitle: [m.year, m.genres?.slice(0, 2).join(', ')].filter(Boolean).join(' · '),
    image: m.backdrop || m.poster, logo: m.logo, candidates, startAt, durationSec: m.durationSec,
  };
}

export async function playEpisodeRequest(s: Series, ep: Episode, startAt?: number): Promise<PlayRequest> {
  const { byId, order, secrets } = await ctx(s.profileId);
  // same episode on other sources (same series group, same SxxEyy)
  const sibling = (await db.series.where('groupKey').equals(s.groupKey).toArray()).filter((x) => x.id !== s.id && order.has(x.sourceId));
  const others: Episode[] = [];
  for (const sx of sibling) {
    const e = await db.episodes.where('seriesId').equals(sx.id).filter((e) => e.season === ep.season && e.episode === ep.episode).first();
    if (e) others.push(e);
  }
  const all = [ep, ...others.sort((a, b) => order.get(a.sourceId)! - order.get(b.sourceId)!)];
  const candidates = all
    .filter((e) => byId.has(e.sourceId))
    .map((e) => {
      const src = byId.get(e.sourceId)!;
      return { url: episodeUrl(e.extId, e.ext, src, secrets[src.id], e.url), label: src.label, quality: null, sourceId: src.id };
    });
  return {
    kind: 'episode', itemId: ep.id, seriesId: s.id, title: s.title,
    subtitle: `S${ep.season} E${ep.episode}${!isGenericEpisodeTitle(ep.title) ? ' · ' + ep.title : ''}`,
    image: ep.still || s.backdrop || s.poster, logo: s.logo, candidates, startAt, durationSec: ep.durationSec,
  };
}

export async function nextEpisode(seriesId: string, ep: { season: number; episode: number }): Promise<Episode | undefined> {
  const eps = (await db.episodes.where('seriesId').equals(seriesId).toArray()).sort((a, b) => a.season - b.season || a.episode - b.episode);
  const i = eps.findIndex((e) => e.season === ep.season && e.episode === ep.episode);
  return i >= 0 ? eps[i + 1] : undefined;
}

/** catch-up candidates for one channel group from `start` (ms) */
export async function catchupCandidates(channelId: string, start: number, stop: number): Promise<PlayRequest['candidates']> {
  const ch = await db.channels.get(channelId);
  if (!ch) return [];
  const { byId, secrets } = await ctx(ch.profileId);
  const out: PlayRequest['candidates'] = [];
  for (const v of await channelVariants(ch)) {
    const src = byId.get(v.sourceId);
    if (!src) continue;
    const url = catchupUrl(v, src, secrets[src.id], start, Math.max(start + 60000, Math.min(stop, Date.now())));
    if (url) out.push({ url, label: qlabel(v.quality), quality: v.quality, sourceId: v.sourceId });
  }
  return out;
}

export { watchKey };
