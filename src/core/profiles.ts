import { db } from './db';
import type { Lang, Profile, Source } from './types';
import { uid } from './util/text';
import { normalizeServer } from './sources/xtream';
import { secureRemove, secureSet, sourcePassKey, tmdbKey } from './secure';
import { deleteProfileData, deleteSourceData, invalidateSecrets } from './repo';

export const EMOJIS = ['🍿', '🎬', '📺', '🦊', '🐼', '🦁', '🐸', '🐙', '🚀', '⚽', '🎮', '🎧', '🌟', '👾', '🧸', '🦄'];
export const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#9333ea', '#0891b2', '#db2777', '#4b5563'];

export async function createProfile(p: { name: string; emoji: string; color: string; lang: Lang }): Promise<Profile> {
  const profile: Profile = {
    id: uid(), name: p.name.trim() || 'Profil', emoji: p.emoji, color: p.color, lang: p.lang, theme: 'night',
    parental: { enabled: false }, hasTmdb: false, createdAt: Date.now(),
  };
  await db.profiles.put(profile);
  return profile;
}

export async function updateProfile(id: string, patch: Partial<Profile>) {
  await db.profiles.update(id, patch);
}

export async function deleteProfile(id: string) {
  const sources = await db.sources.where('profileId').equals(id).toArray();
  for (const s of sources) await secureRemove(sourcePassKey(s.id));
  await secureRemove(tmdbKey(id));
  await deleteProfileData(id);
  invalidateSecrets();
}

export interface SourceInput {
  type: Source['type'];
  label: string;
  /** main server / playlist */
  url: string;
  /** backup servers / playlists, tried in order when the one in use fails */
  backups?: string[];
  /** server to use right away (e.g. the one the "Test" button switched to) */
  active?: string;
  username?: string;
  password?: string;
  epgUrls: string[];
}

export async function saveSource(profileId: string, input: SourceInput, existingId?: string): Promise<Source> {
  const existing = existingId ? await db.sources.get(existingId) : undefined;
  const count = await db.sources.where('profileId').equals(profileId).count();
  const norm = (u: string) => (input.type === 'xtream' ? normalizeServer(u) : u.trim());
  const servers = [...new Set([input.url, ...(input.backups || [])].filter((u) => u.trim()).map(norm))];
  // server in use: the tested one, else the current one if still listed, else the main one
  const active = [input.active && norm(input.active), existing?.url].find((u) => u && servers.includes(u)) || servers[0];
  const url = servers[0];
  let label = input.label.trim();
  if (!label) {
    try {
      label = new URL(url).hostname;
    } catch {
      label = input.type.toUpperCase();
    }
  }
  const src: Source = {
    ...(existing || { status: 'unknown', priority: count, enabled: true }),
    id: existing?.id || uid(),
    profileId,
    type: input.type,
    label,
    url: active,
    servers,
    username: input.type === 'xtream' ? input.username?.trim() : undefined,
    epgUrls: input.epgUrls,
  } as Source;
  // credentials / main server changed: force a full resync (switching between listed servers doesn't)
  const prevMain = existing ? (existing.servers?.[0] ?? existing.url) : undefined;
  if (existing && (prevMain !== url || existing.username !== src.username || existing.type !== src.type)) src.lastSyncAt = undefined;
  await db.sources.put(src);
  if (input.type === 'xtream' && input.password) await secureSet(sourcePassKey(src.id), input.password);
  invalidateSecrets();
  return src;
}

export async function removeSource(id: string) {
  await secureRemove(sourcePassKey(id));
  await deleteSourceData(id);
  invalidateSecrets();
}

export async function moveSource(profileId: string, id: string, dir: -1 | 1) {
  const list = (await db.sources.where('profileId').equals(profileId).toArray()).sort((a, b) => a.priority - b.priority);
  const i = list.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  await db.transaction('rw', db.sources, async () => {
    for (let k = 0; k < list.length; k++) await db.sources.update(list[k].id, { priority: k });
  });
}

export async function setTmdbToken(profileId: string, token: string | null) {
  if (token) await secureSet(tmdbKey(profileId), token.trim());
  else await secureRemove(tmdbKey(profileId));
  await db.profiles.update(profileId, { hasTmdb: !!token });
}

/** a backup server just worked during playback: make it the server in use (kept at next start) */
export async function rememberServer(sourceId: string, server: string) {
  const src = await db.sources.get(sourceId);
  if (!src || src.type !== 'xtream' || normalizeServer(src.url) === server) return false;
  if (!(src.servers || []).map(normalizeServer).includes(server)) return false;
  await db.sources.update(sourceId, { url: server, status: 'degraded', lastError: `Bascule sur ${new URL(server).host} (lecture)` });
  return true;
}
