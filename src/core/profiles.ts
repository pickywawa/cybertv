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
  url: string;
  username?: string;
  password?: string;
  epgUrls: string[];
}

export async function saveSource(profileId: string, input: SourceInput, existingId?: string): Promise<Source> {
  const existing = existingId ? await db.sources.get(existingId) : undefined;
  const count = await db.sources.where('profileId').equals(profileId).count();
  const url = input.type === 'xtream' ? normalizeServer(input.url) : input.url.trim();
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
    url,
    username: input.type === 'xtream' ? input.username?.trim() : undefined,
    epgUrls: input.epgUrls,
  } as Source;
  // credentials changed: force a full resync
  if (existing && (existing.url !== src.url || existing.username !== src.username || existing.type !== src.type)) src.lastSyncAt = undefined;
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
