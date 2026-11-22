import { cleanEpisodeTitle, isGenericEpisodeTitle } from '@/core/util/text';
import { db } from './db';
import type { Channel, Episode, Movie, PlayRequest, Program, Series, Source } from './types';
import { catchupUrl, episodeUrl, liveUrl, movieUrl, type Engine } from './sources/urls';
import { loadSecrets, sourcesOf, watchKey } from './repo';
import { LIVE_QUALITY_RANK, QUALITY_RANK, detectQuality } from './util/text';
import { detectLangs, langScore, type LangPrefs } from './util/lang';
import { langPrefs } from './prefs';
import { useApp } from '@/state/store';
import { serversOf, serverLabel } from './sources/servers';
import { normalizeServer } from './sources/xtream';
import { isAndroidApp, isIOSApp } from './platform';
import { timeshiftUrl } from './net/http';
import { t } from './i18n';
import { officialFor, resolveOfficialLive, withTimeout } from './replay';

export const engineKind = (): Engine => (isAndroidApp ? 'native' : 'web');

async function ctx(profileId: string) {
  const [sources, secrets] = await Promise.all([sourcesOf(profileId), loadSecrets(profileId)]);
  const enabled = sources.filter((s) => s.enabled);
  return { byId: new Map<string, Source>(enabled.map((s) => [s.id, s])), order: new Map(enabled.map((s, i) => [s.id, i])), secrets };
}

const qlabel = (q: string | null) => q || 'Auto';

function currentPrefs(): LangPrefs | undefined {
  const p = useApp.getState().profile;
  return p ? langPrefs(p) : undefined;
}

/** "FHD · VF", "4K · MULTI", "VOSTFR" — readable name of one VOD variant */
function versionLabel(rawName: string): string {
  const parts: string[] = [];
  const q = detectQuality(rawName);
  if (q) parts.push(q);
  const up = rawName.toUpperCase();
  if (/\bMULTI\b/.test(up)) parts.push('MULTI');
  else if (/\bVOST(FR)?\b/.test(up)) parts.push('VOSTFR');
  else if (/\bVFQ\b/.test(up)) parts.push('VFQ');
  else if (/\b(VFF|VF|TRUEFRENCH|FRENCH)\b/.test(up)) parts.push('VF');
  else {
    const l = detectLangs(rawName).audio[0];
    if (l) parts.push(l.toUpperCase());
  }
  return parts.join(' · ');
}

/**
 * Failover across a source's servers: every Xtream candidate is followed (after all candidates on
 * the servers in use) by the same stream on each backup server — same panel, same ids/credentials.
 */
function withBackupServers(cands: PlayRequest['candidates'], byId: Map<string, Source>): PlayRequest['candidates'] {
  const primary = cands.map((c) => {
    const src = byId.get(c.sourceId);
    return src?.type === 'xtream' ? { ...c, server: normalizeServer(src.url) } : c;
  });
  const backups: PlayRequest['candidates'] = [];
  for (const c of primary) {
    const src = byId.get(c.sourceId);
    if (!src || src.type !== 'xtream' || !c.server || !c.url.startsWith(c.server)) continue;
    for (const alt of serversOf(src).slice(1)) {
      backups.push({ ...c, url: alt + c.url.slice(c.server.length), server: alt, label: `${c.label} · ${serverLabel(alt)}` });
    }
  }
  return [...primary, ...backups];
}

/** unique, readable labels; identical urls removed */
function finalizeCandidates(list: PlayRequest['candidates'], multiSource: boolean, sourceLabel: (id: string) => string): PlayRequest['candidates'] {
  const seen = new Set<string>();
  const out = list.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  const counts = new Map<string, number>();
  return out.map((c) => {
    let label = [multiSource ? sourceLabel(c.sourceId) : '', c.label].filter(Boolean).join(' · ') || 'Version';
    const n = (counts.get(label) || 0) + 1;
    counts.set(label, n);
    if (n > 1) label = `${label} (${n})`;
    return { ...c, label };
  });
}

/** All variants of the same channel, preferred one first, then by source priority & quality */
export async function channelVariants(ch: Channel): Promise<Channel[]> {
  const { order } = await ctx(ch.profileId);
  const all = (await db.channels.where('groupKey').equals(ch.groupKey).toArray()).filter((c) => c.profileId === ch.profileId && order.has(c.sourceId));
  return all.sort((a, b) => {
    if (a.id === ch.id) return -1;
    if (b.id === ch.id) return 1;
    return order.get(a.sourceId)! - order.get(b.sourceId)! || (LIVE_QUALITY_RANK[String(b.quality)] ?? 0) - (LIVE_QUALITY_RANK[String(a.quality)] ?? 0);
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
    const url = catchup ? catchupUrl(v, src, secrets[src.id], catchup.start, Math.min(catchup.stop, Date.now())) : liveUrl(v, src, secrets[src.id], engineKind(), bufferSec() > 0);
    if (url) candidates.push({ url, label: label(v), quality: v.quality, sourceId: v.sourceId });
  }
  const uniq = withBackupServers(finalizeCandidates(candidates, false, () => ''), byId);
  candidates.length = 0;
  // public channels: the broadcaster's own free stream first (better picture), the provider as backup
  const official = !catchup ? await officialCandidate(ch) : null;
  if (official) candidates.push(official);
  candidates.push(...uniq);
  if (!catchup) candidates.splice(0, candidates.length, ...candidates.map(withTimeshift));
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

/** live buffer length chosen in the settings (seconds); none on iOS (no local recorder) */
export function bufferSec(): number {
  if (isIOSApp) return 0;
  return (useApp.getState().settings.liveBuffer ?? 30) * 60;
}

/** live HLS goes through the local recorder: pause and rewind without provider catch-up */
export function withTimeshift<C extends { url: string }>(c: C): C {
  const u = timeshiftUrl(c.url, bufferSec());
  return u ? { ...c, url: u } : c;
}

async function officialCandidate(ch: Channel): Promise<PlayRequest['candidates'][number] | null> {
  const profile = useApp.getState().profile;
  const o = officialFor(ch);
  if (!o || profile?.officialLive === false) return null;
  try {
    const s = await withTimeout(resolveOfficialLive(o, profile?.lang || 'fr'), 4000);
    return { url: s.url, label: `${t('replay.official')} · ${s.label}`, quality: 'FHD', sourceId: 'official' };
  } catch {
    return null; // abroad, network error: provider streams only
  }
}

export async function playMovieRequest(m: Movie, startAt?: number): Promise<PlayRequest> {
  const { byId, order, secrets } = await ctx(m.profileId);
  const prefs = currentPrefs();
  const variants = (await db.movies.where('groupKey').equals(m.groupKey).toArray())
    .filter((x) => x.profileId === m.profileId && order.has(x.sourceId))
    .sort((a, b) =>
      a.id === m.id ? -1 : b.id === m.id ? 1
        : (prefs ? langScore(a, prefs) - langScore(b, prefs) : 0) || order.get(a.sourceId)! - order.get(b.sourceId)!
          || (QUALITY_RANK[String(detectQuality(b.rawName))] ?? 0) - (QUALITY_RANK[String(detectQuality(a.rawName))] ?? 0));
  const multiSource = new Set(variants.map((v) => v.sourceId)).size > 1;
  const candidates = withBackupServers(finalizeCandidates(
    variants
      .map((v) => {
        const src = byId.get(v.sourceId)!;
        return { url: movieUrl(v.extId, v.ext, src, secrets[src.id], v.url), label: versionLabel(v.rawName), quality: detectQuality(v.rawName), sourceId: src.id };
      })
      .filter((c) => !!c.url),
    multiSource,
    (id) => byId.get(id)?.label || '',
  ), byId);
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
  const candidates = withBackupServers(finalizeCandidates(
    all
      .filter((e) => byId.has(e.sourceId))
      .map((e) => {
        const src = byId.get(e.sourceId)!;
        const raw = [s, ...sibling].find((x) => x.id === e.seriesId)?.rawName || '';
        return { url: episodeUrl(e.extId, e.ext, src, secrets[src.id], e.url), label: versionLabel(raw), quality: detectQuality(raw), sourceId: src.id };
      }),
    new Set(all.map((e) => e.sourceId)).size > 1,
    (id) => byId.get(id)?.label || '',
  ), byId);
  return {
    kind: 'episode', itemId: ep.id, seriesId: s.id, title: s.title,
    subtitle: `S${ep.season} E${ep.episode}${!isGenericEpisodeTitle(ep.title) ? ' · ' + cleanEpisodeTitle(ep.title) : ''}`,
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
  return withBackupServers(finalizeCandidates(out, false, () => ''), byId);
}

export { watchKey };
