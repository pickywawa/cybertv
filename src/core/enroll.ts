import { CapacitorHttp } from '@capacitor/core';
import { isAndroidApp, isDesktop, isNative } from './platform';
import { CyberNative } from './native';
import { db } from './db';
import type { Profile, Source } from './types';
import { loadSecrets } from './repo';
import { secureGet, tmdbKey } from './secure';
import { createProfile, saveSource, setTmdbToken, updateProfile, type SourceInput } from './profiles';

/**
 * QR-code enrolment.
 * TV: starts a local HTTP server (Android EnrollServer, Vite middleware in dev) and shows its url as a QR code.
 * Phone without the app: the page served by the TV (public/enroll.html) posts a form.
 * Phone with the app: the page opens cyberiptv://enroll?target=<tv url>, the app posts its own settings.
 */
export interface EnrollSource {
  type: 'xtream' | 'm3u';
  label: string;
  url: string;
  backups?: string[];
  username?: string;
  password?: string;
  epgUrls?: string[];
}

export interface EnrollPayload {
  v: 1;
  from: 'form' | 'app';
  sources: EnrollSource[];
  tmdb?: string;
  prefs?: Pick<Profile, 'lang' | 'country' | 'audioLangs' | 'subLangs' | 'subMode' | 'subsOnline'>;
  /** the phone's profile itself (name, emoji, colour), so the TV gets the same one */
  profile?: Pick<Profile, 'name' | 'emoji' | 'color'>;
}

const isUrl = (u: unknown): u is string => {
  if (typeof u !== 'string' || u.length > 2048 || !/^https?:\/\/[^\s]+$/i.test(u.trim())) return false;
  try {
    return !!new URL(u.trim()).hostname;
  } catch {
    return false;
  }
};
/** Xtream servers are often typed without scheme ("host.tv:8080"): add http:// only to things that look like a host */
const withScheme = (u: unknown): unknown =>
  typeof u === 'string' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u.trim()) && /^[a-z0-9.-]+(:\d+)?(\/|$)/i.test(u.trim()) ? `http://${u.trim()}` : u;
const str = (u: unknown, max = 256): string | undefined => (typeof u === 'string' && u.length <= max ? u.trim() : undefined);
const langs = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[a-z]{2}$/.test(x)).slice(0, 2) : undefined;

/** strict parsing of what arrives from the network: anything unexpected is dropped */
export function parsePayload(raw: string): EnrollPayload | null {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || j.v !== 1 || !Array.isArray(j.sources)) return null;
  const sources: EnrollSource[] = [];
  for (const s of j.sources.slice(0, 10)) {
    const type = s?.type === 'm3u' ? 'm3u' : s?.type === 'xtream' ? 'xtream' : null;
    if (!type) continue;
    const url = type === 'xtream' ? withScheme(s.url) : s.url;
    if (!isUrl(url)) continue;
    if (type === 'xtream' && (!str(s.username) || typeof s.password !== 'string' || !s.password)) continue;
    sources.push({
      type,
      label: str(s.label, 80) || '',
      url: (url as string).trim(),
      backups: (Array.isArray(s.backups) ? s.backups : [])
        .map((b: unknown) => (type === 'xtream' ? withScheme(b) : b))
        .filter(isUrl)
        .slice(0, 10),
      username: type === 'xtream' ? str(s.username) : undefined,
      password: type === 'xtream' ? String(s.password).slice(0, 256) : undefined,
      epgUrls: (Array.isArray(s.epgUrls) ? s.epgUrls : []).filter(isUrl).slice(0, 5),
    });
  }
  if (!sources.length) return null;
  const p = j.prefs || {};
  const prefs = j.prefs
    ? {
        lang: p.lang === 'en' ? 'en' : p.lang === 'fr' ? 'fr' : undefined,
        country: typeof p.country === 'string' && /^[A-Z]{2}$/.test(p.country) ? p.country : undefined,
        audioLangs: langs(p.audioLangs),
        subLangs: langs(p.subLangs),
        subMode: ['off', 'auto', 'always'].includes(p.subMode) ? p.subMode : undefined,
        subsOnline: typeof p.subsOnline === 'boolean' ? p.subsOnline : undefined,
      }
    : undefined;
  const pr = j.profile || {};
  const name = str(pr.name, 24);
  const profile = name
    ? { name, emoji: str(pr.emoji, 8) || '🍿', color: typeof pr.color === 'string' && /^#[0-9a-f]{6}$/i.test(pr.color) ? pr.color : '#e50914' }
    : undefined;
  return {
    v: 1,
    from: j.from === 'app' ? 'app' : 'form',
    sources,
    tmdb: str(j.tmdb, 512) || undefined,
    prefs: prefs as EnrollPayload['prefs'],
    profile,
  };
}

// ─────────── settings handed to a TV right after "Install on a TV" ───────────

const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

/** the link the phone opens on the TV through adb (the payload travels in the path, never logged) */
export function importLink(p: EnrollPayload): string {
  return `cyberiptv://import/${b64url(JSON.stringify(p))}`;
}

export function parseImportLink(url: string): EnrollPayload | null {
  const m = url.match(/^cyberiptv:\/\/import\/([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  try {
    return parsePayload(unb64url(m[1]));
  } catch {
    return null;
  }
}

/** the TV takes the phone's profile: the same one when it exists (same name), a new one otherwise */
export async function importAsProfile(p: EnrollPayload): Promise<Profile> {
  const name = p.profile?.name || 'CyberIPTV';
  const existing = (await db.profiles.toArray()).find((x) => x.name.toLowerCase() === name.toLowerCase());
  const prof =
    existing ||
    (await createProfile({ name, emoji: p.profile?.emoji || '🍿', color: p.profile?.color || '#e50914', lang: p.prefs?.lang || 'fr' }));
  // sources already on this profile (same address and user) are not added twice
  const have = await db.sources.where('profileId').equals(prof.id).toArray();
  const fresh = { ...p, sources: p.sources.filter((s) => !have.some((h) => h.url === s.url && (h.username || '') === (s.username || ''))) };
  await applyEnroll(prof.id, fresh, { prefs: true });
  return (await db.profiles.get(prof.id))!;
}

export function toSourceInput(s: EnrollSource): SourceInput {
  return { type: s.type, label: s.label, url: s.url, backups: s.backups, username: s.username, password: s.password, epgUrls: s.epgUrls || [] };
}

// ─────────── TV side ───────────

/** a local server can be opened: Android (EnrollServer), desktop app and dev server (Node) */
export const canEnroll = isAndroidApp || isDesktop || !!import.meta.env.DEV;

let webToken = '';

export async function startEnroll(): Promise<string> {
  if (isAndroidApp) return (await CyberNative.enrollStart()).url;
  const r = await (await fetch('/enroll-api/start')).json();
  webToken = r.token;
  return r.url;
}

export async function pollEnroll(): Promise<EnrollPayload | null> {
  const raw = isAndroidApp
    ? (await CyberNative.enrollPoll()).payload
    : (await (await fetch(`/enroll-api/poll?token=${webToken}`)).json()).payload;
  return raw ? parsePayload(raw) : null;
}

export async function stopEnroll() {
  if (isAndroidApp) await CyberNative.enrollStop().catch(() => {});
}

/** imports received settings into an existing profile */
export async function applyEnroll(profileId: string, p: EnrollPayload, opts: { prefs: boolean }) {
  for (const s of p.sources) await saveSource(profileId, toSourceInput(s));
  if (p.tmdb) await setTmdbToken(profileId, p.tmdb);
  if (opts.prefs && p.prefs) {
    const patch = Object.fromEntries(Object.entries(p.prefs).filter(([, v]) => v !== undefined)) as Partial<Profile>;
    if (Object.keys(patch).length) await updateProfile(profileId, patch);
  }
}

// ─────────── phone side (CyberIPTV app) ───────────

/** "cyberiptv://enroll?target=http://192.168.1.20:41234/e/<token>" → the TV url (LAN only) */
export function enrollTarget(deepLink: string): string | null {
  try {
    const u = new URL(deepLink);
    if (u.protocol !== 'cyberiptv:' || u.hostname !== 'enroll') return null;
    const t = new URL(u.searchParams.get('target') || '');
    // only private-network hosts: never send credentials anywhere else
    const privateHost = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|127\.)/.test(t.hostname);
    if (t.protocol !== 'http:' || !privateHost || !/^\/(e|enroll)\/[a-f0-9]{36}$/.test(t.pathname)) return null;
    return t.origin + t.pathname;
  } catch {
    return null;
  }
}

export async function buildPhonePayload(profile: Profile, sourceIds: string[], withTmdb: boolean, withPrefs: boolean): Promise<EnrollPayload> {
  const secrets = await loadSecrets(profile.id, true);
  const sources = (await db.sources.bulkGet(sourceIds)).filter(Boolean) as Source[];
  const tmdb = withTmdb && profile.hasTmdb ? await secureGet(tmdbKey(profile.id)) : null;
  return {
    v: 1,
    from: 'app',
    sources: sources.map((s) => {
      const servers = s.servers?.length ? s.servers : [s.url];
      return {
        type: s.type, label: s.label, url: servers[0], backups: servers.slice(1),
        username: s.username, password: s.type === 'xtream' ? secrets[s.id] : undefined, epgUrls: s.epgUrls,
      };
    }),
    tmdb: tmdb || undefined,
    prefs: withPrefs
      ? { lang: profile.lang, country: profile.country, audioLangs: profile.audioLangs, subLangs: profile.subLangs, subMode: profile.subMode, subsOnline: profile.subsOnline }
      : undefined,
    profile: withPrefs ? { name: profile.name, emoji: profile.emoji, color: profile.color } : undefined,
  };
}

async function request(method: 'GET' | 'POST', url: string, body?: unknown): Promise<number> {
  if (isNative) {
    const r = await CapacitorHttp.request({ method, url, headers: { 'content-type': 'application/json' }, data: body, connectTimeout: 8000, readTimeout: 8000 });
    return r.status;
  }
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return r.status;
}

export async function pingTv(target: string): Promise<boolean> {
  try {
    return (await request('GET', `${target}/ping`)) === 200;
  } catch {
    return false;
  }
}

export async function sendToTv(target: string, payload: EnrollPayload): Promise<boolean> {
  return (await request('POST', target, payload)) === 200;
}
