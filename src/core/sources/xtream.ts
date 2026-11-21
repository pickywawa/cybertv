import { fetchJson } from '../net/http';
import type { XtreamAccount } from '../types';

export interface XtreamCreds {
  server: string;
  username: string;
  password: string;
}

export function normalizeServer(s: string): string {
  let u = s.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/(player_api|get)\.php.*$/i, '');
  return u;
}

/** Parses "http://host:port/get.php?username=x&password=y&type=m3u_plus" into Xtream creds */
export function credsFromM3uUrl(url: string): XtreamCreds | null {
  try {
    const u = new URL(url);
    if (!/get\.php$/i.test(u.pathname)) return null;
    const username = u.searchParams.get('username');
    const password = u.searchParams.get('password');
    if (!username || !password) return null;
    return { server: u.origin, username, password };
  } catch {
    return null;
  }
}

export class XtreamClient {
  constructor(private c: XtreamCreds) {}

  /** every URL the catalogue sync reads (handed to the background pre-download) */
  syncUrls(): string[] {
    return [undefined, 'get_live_categories', 'get_live_streams', 'get_vod_categories', 'get_vod_streams', 'get_series_categories', 'get_series'].map((a) => this.api(a));
  }

  private api(action?: string, extra: Record<string, string> = {}) {
    const q = new URLSearchParams({ username: this.c.username, password: this.c.password, ...extra });
    if (action) q.set('action', action);
    return `${normalizeServer(this.c.server)}/player_api.php?${q}`;
  }

  async account(): Promise<XtreamAccount & { auth: boolean }> {
    const r = await fetchJson<any>(this.api(), 20000);
    const ui = r?.user_info || {};
    return {
      auth: ui.auth === 1 || ui.auth === '1',
      status: ui.status,
      expiresAt: ui.exp_date ? Number(ui.exp_date) * 1000 : undefined,
      maxConn: ui.max_connections ? Number(ui.max_connections) : undefined,
      activeCons: ui.active_cons ? Number(ui.active_cons) : undefined,
      formats: Array.isArray(ui.allowed_output_formats) ? ui.allowed_output_formats : undefined,
      timezone: r?.server_info?.timezone,
    };
  }

  liveCategories() { return fetchJson<any[]>(this.api('get_live_categories')); }
  liveStreams() { return fetchJson<any[]>(this.api('get_live_streams'), 120000); }
  vodCategories() { return fetchJson<any[]>(this.api('get_vod_categories')); }
  vodStreams() { return fetchJson<any[]>(this.api('get_vod_streams'), 180000); }
  seriesCategories() { return fetchJson<any[]>(this.api('get_series_categories')); }
  series() { return fetchJson<any[]>(this.api('get_series'), 180000); }
  vodInfo(id: string) { return fetchJson<any>(this.api('get_vod_info', { vod_id: id })); }
  seriesInfo(id: string) { return fetchJson<any>(this.api('get_series_info', { series_id: id })); }
  shortEpg(streamId: string, limit = 10) {
    return fetchJson<any>(this.api('get_short_epg', { stream_id: streamId, limit: String(limit) }));
  }
  xmltvUrl() {
    const q = new URLSearchParams({ username: this.c.username, password: this.c.password });
    return `${normalizeServer(this.c.server)}/xmltv.php?${q}`;
  }
}

export const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === 'object' ? (Object.values(v) as T[]) : []);
export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : undefined;
};
