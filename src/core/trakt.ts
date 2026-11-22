import { request } from './net/request';
import { getMeta, setMeta } from './db';
import { secureGet, secureRemove, secureSet } from './secure';
import type { TmdbListItem } from './types';

/**
 * Trakt (trakt.tv): the user's own API app (Client ID + Secret, free at trakt.tv/oauth/applications),
 * linked to the account with the device flow (a code typed on trakt.tv/activate — works on a TV).
 * Gives "For you" recommendations, the watchlist and personal lists (matched against the catalogue),
 * and scrobbles what is watched in the app.
 */
const API = 'https://api.trakt.tv';
const OOB = 'urn:ietf:wg:oauth:2.0:oob';

const idKey = (p: string) => `trakt:${p}:id`;
const secretKey = (p: string) => `trakt:${p}:secret`;
const tokenKey = (p: string) => `trakt:${p}:token`;
const listsMeta = (p: string) => `trakt:lists:${p}`;

interface Token {
  access: string;
  refresh: string;
  exp: number;
}

export interface TraktLists {
  at: number;
  user?: string;
  forYouMovies: TmdbListItem[];
  forYouShows: TmdbListItem[];
  watchlistMovies: TmdbListItem[];
  watchlistShows: TmdbListItem[];
  lists: { name: string; movies: TmdbListItem[]; shows: TmdbListItem[] }[];
}

async function creds(profileId: string) {
  const [id, secret, tok] = await Promise.all([secureGet(idKey(profileId)), secureGet(secretKey(profileId)), secureGet(tokenKey(profileId))]);
  let token: Token | null = null;
  try {
    token = tok ? (JSON.parse(tok) as Token) : null;
  } catch {
    token = null;
  }
  return { id, secret, token };
}

export async function traktStatus(profileId: string): Promise<{ hasApp: boolean; linked: boolean; user?: string }> {
  const c = await creds(profileId);
  const lists = await getMeta<TraktLists>(listsMeta(profileId));
  return { hasApp: !!(c.id && c.secret), linked: !!c.token, user: lists?.user };
}

const headers = (clientId: string, access?: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  'trakt-api-version': '2',
  'trakt-api-key': clientId,
  ...(access ? { Authorization: `Bearer ${access}` } : {}),
});

// ─────────── linking (device flow) ───────────

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export async function traktSaveApp(profileId: string, clientId: string, secret: string) {
  await secureSet(idKey(profileId), clientId.trim());
  await secureSet(secretKey(profileId), secret.trim());
}

export async function traktStartLink(profileId: string): Promise<DeviceCode> {
  const { id } = await creds(profileId);
  if (!id) throw new Error('app');
  const r = await request<DeviceCode>({ url: `${API}/oauth/device/code`, method: 'POST', headers: headers(id), body: { client_id: id } });
  if (r.status !== 200 || !r.data?.user_code) throw new Error(r.status === 403 || r.status === 401 ? 'app' : `HTTP ${r.status}`);
  return r.data;
}

/** 'ok' once the code was entered, 'wait' while pending, 'expired' / 'denied' / 'app' otherwise */
export async function traktPollLink(profileId: string, deviceCode: string): Promise<'ok' | 'wait' | 'slow' | 'expired' | 'denied' | 'app'> {
  const { id, secret } = await creds(profileId);
  if (!id || !secret) return 'app';
  const r = await request<{ access_token: string; refresh_token: string; expires_in: number; created_at: number }>({
    url: `${API}/oauth/device/token`, method: 'POST', headers: headers(id), body: { code: deviceCode, client_id: id, client_secret: secret },
  });
  if (r.status === 200 && r.data?.access_token) {
    await saveToken(profileId, r.data);
    void traktLists(profileId, true).catch(() => {});
    return 'ok';
  }
  if (r.status === 400) return 'wait';
  if (r.status === 429) return 'slow';
  if (r.status === 418) return 'denied';
  if (r.status === 404 || r.status === 410) return 'expired';
  return 'app';
}

async function saveToken(profileId: string, d: { access_token: string; refresh_token: string; expires_in: number; created_at?: number }) {
  const t: Token = { access: d.access_token, refresh: d.refresh_token, exp: ((d.created_at || Date.now() / 1000) + d.expires_in) * 1000 };
  await secureSet(tokenKey(profileId), JSON.stringify(t));
}

export async function traktUnlink(profileId: string, forgetApp = false) {
  await secureRemove(tokenKey(profileId));
  await setMeta(listsMeta(profileId), null);
  if (forgetApp) {
    await secureRemove(idKey(profileId));
    await secureRemove(secretKey(profileId));
  }
}

/** a valid access token (refreshed a day before it expires) */
async function session(profileId: string): Promise<{ id: string; access: string } | null> {
  const { id, secret, token } = await creds(profileId);
  if (!id || !secret || !token) return null;
  if (token.exp - Date.now() > 86400000) return { id, access: token.access };
  const r = await request<{ access_token: string; refresh_token: string; expires_in: number; created_at: number }>({
    url: `${API}/oauth/token`, method: 'POST', headers: headers(id),
    body: { refresh_token: token.refresh, client_id: id, client_secret: secret, redirect_uri: OOB, grant_type: 'refresh_token' },
  });
  if (r.status !== 200 || !r.data?.access_token) return token.exp > Date.now() ? { id, access: token.access } : null;
  await saveToken(profileId, r.data);
  return { id, access: r.data.access_token };
}

async function get<T>(s: { id: string; access: string }, path: string): Promise<T | null> {
  const r = await request<T>({ url: `${API}${path}`, headers: headers(s.id, s.access), timeoutMs: 20000 });
  return r.status === 200 ? r.data : null;
}

// ─────────── lists ───────────

type TraktMedia = { title?: string; year?: number; ids?: { tmdb?: number } };
const toItem = (m?: TraktMedia): TmdbListItem | null => (m?.ids?.tmdb && m.title ? { tmdbId: m.ids.tmdb, title: m.title, year: m.year } : null);
const items = (rows: TraktMedia[] | null | undefined) => (rows || []).map(toItem).filter((x): x is TmdbListItem => !!x);
const wrapped = (rows: { movie?: TraktMedia; show?: TraktMedia }[] | null, k: 'movie' | 'show') => items((rows || []).map((r) => r[k]!).filter(Boolean));

async function fetchLists(profileId: string): Promise<TraktLists | null> {
  const s = await session(profileId);
  if (!s) return null;
  const [me, recM, recS, wlM, wlS, mine] = await Promise.all([
    get<{ username?: string; user?: { username?: string } }>(s, '/users/settings'),
    get<TraktMedia[]>(s, '/recommendations/movies?limit=60&ignore_collected=true'),
    get<TraktMedia[]>(s, '/recommendations/shows?limit=60&ignore_collected=true'),
    get<{ movie?: TraktMedia }[]>(s, '/sync/watchlist/movies'),
    get<{ show?: TraktMedia }[]>(s, '/sync/watchlist/shows'),
    get<{ name: string; ids: { trakt: number } }[]>(s, '/users/me/lists'),
  ]);
  const lists: TraktLists['lists'] = [];
  for (const l of (mine || []).slice(0, 6)) {
    const rows = await get<{ movie?: TraktMedia; show?: TraktMedia }[]>(s, `/users/me/lists/${l.ids.trakt}/items/movie,show`);
    lists.push({ name: l.name, movies: wrapped(rows, 'movie'), shows: wrapped(rows, 'show') });
  }
  return {
    at: Date.now(),
    user: me?.user?.username || me?.username,
    forYouMovies: items(recM),
    forYouShows: items(recS),
    watchlistMovies: wrapped(wlM, 'movie'),
    watchlistShows: wrapped(wlS, 'show'),
    lists,
  };
}

let inflight: Promise<TraktLists | null> | null = null;

/** saved lists at once; refreshed in the background when older than an hour */
export async function traktLists(profileId: string, force = false): Promise<TraktLists | null> {
  const saved = await getMeta<TraktLists>(listsMeta(profileId));
  if (saved && !force && Date.now() - saved.at < 3600000) return saved;
  inflight ??= fetchLists(profileId)
    .then(async (l) => {
      if (l) await setMeta(listsMeta(profileId), l);
      return l;
    })
    .catch(() => null)
    .finally(() => (inflight = null));
  if (saved && !force) {
    void inflight;
    return saved;
  }
  return (await inflight) || saved || null;
}

// ─────────── scrobbling ───────────

export interface ScrobbleTarget {
  movie?: { tmdb: number };
  episode?: { showTmdb: number; season: number; number: number };
}

function body(t: ScrobbleTarget, progress: number) {
  const p = Math.round(Math.min(100, Math.max(0, progress)) * 100) / 100;
  if (t.movie) return { movie: { ids: { tmdb: t.movie.tmdb } }, progress: p };
  return { show: { ids: { tmdb: t.episode!.showTmdb } }, episode: { season: t.episode!.season, number: t.episode!.number }, progress: p };
}

/** start / pause / stop: Trakt marks the title watched when stopped past 80 % */
export async function traktScrobble(profileId: string, action: 'start' | 'pause' | 'stop', t: ScrobbleTarget, progress: number): Promise<void> {
  const s = await session(profileId).catch(() => null);
  if (!s) return;
  await request({ url: `${API}/scrobble/${action}`, method: 'POST', headers: headers(s.id, s.access), body: body(t, progress) }).catch(() => {});
}
