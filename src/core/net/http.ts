/**
 * All provider traffic goes through a CORS proxy:
 *  - web dev:  Vite middleware  /proxy?u=
 *  - Android:  native local proxy http://127.0.0.1:<port>/proxy?u=  (started by the CyberNative plugin)
 *  - web prod: direct (best effort)
 * Workers receive the base via `setProxyBase`.
 */
// dev server and desktop app (Electron) serve the app and the proxy from the same origin
const sameOriginProxy =
  typeof location !== 'undefined' && (import.meta.env?.DEV || (typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent)));
let proxyBase: string | null = sameOriginProxy ? `${location.origin}/proxy?u=` : null;

export function setProxyBase(base: string | null) {
  proxyBase = base;
}
export function getProxyBase() {
  return proxyBase;
}

/**
 * Live HLS through the local timeshift recorder (pause / rewind up to `maxSec`): the desktop app,
 * the dev server and the Android proxy have one; null elsewhere (iOS, plain web).
 */
/** ends the local live recording (player closed, catch-up or VOD instead) */
export function stopTimeshift(): void {
  const base = proxyBase?.startsWith('http') ? proxyBase.replace(/\/proxy\?u=$/, '') : '';
  if (base) void fetch(`${base}/tsh/stop`).catch(() => {});
}

export function timeshiftUrl(url: string, maxSec: number): string | null {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!proxyBase || maxSec <= 0 || !/\.m3u8$/i.test(path)) return null;
  const base = proxyBase.startsWith('http') ? proxyBase.replace(/\/proxy\?u=$/, '') : '';
  if (!base) return null;
  return `${base}/tsh/start/live.m3u8?max=${Math.round(maxSec)}&u=${encodeURIComponent(url)}`;
}

/** Hosts known to send CORS headers: never proxied */
const CORS_OK = /^(https:\/\/(api\.themoviedb\.org|image\.tmdb\.org|iptv-org\.github\.io|raw\.githubusercontent\.com))/;

export function proxify(url: string): string {
  if (!proxyBase || !/^https?:\/\//i.test(url) || CORS_OK.test(url)) return url;
  if (typeof location !== 'undefined' && url.startsWith(location.origin + '/')) return url;
  if (url.startsWith(proxyBase)) return url;
  return proxyBase + encodeURIComponent(url);
}

export class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} — ${url.replace(/(password|username)=[^&]+/g, '$1=***')}`);
  }
}

export async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), init.timeoutMs ?? 30000);
  if (init.signal) init.signal.addEventListener('abort', () => ac.abort());
  try {
    const res = await fetch(proxify(url), { ...init, signal: ac.signal });
    if (!res.ok) throw new HttpError(res.status, url);
    return res;
  } finally {
    clearTimeout(t);
  }
}

// ─────────── background pre-download (Android PrefetchWorker) ───────────
let prefetchSince: number | null = null;
let prefetchHits = 0;

/**
 * While set, catalogue/EPG requests first ask the native proxy for a copy downloaded in the
 * background (WorkManager) that is newer than `since` (ms); otherwise they go to the network.
 */
export function setPrefetchSince(since: number | null) {
  prefetchSince = since;
}
export function takePrefetchHits(): number {
  const n = prefetchHits;
  prefetchHits = 0;
  return n;
}

async function prefetched(url: string): Promise<Response | null> {
  if (prefetchSince === null || !proxyBase || !proxyBase.startsWith('http://127.0.0.1')) return null;
  try {
    const res = await fetch(`${proxyBase.replace('/proxy?u=', '/cached?u=')}${encodeURIComponent(url)}&since=${prefetchSince}`);
    if (res.status !== 200 || !res.body) return null;
    prefetchHits++;
    return res;
  } catch {
    return null;
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 45000): Promise<T> {
  const local = await prefetched(url);
  if (local) {
    // a pre-downloaded copy that doesn't parse (cut download, error page) is ignored
    try {
      return JSON.parse(await local.text()) as T;
    } catch {
      /* fall back to the network */
    }
  }
  const res = await fetchWithTimeout(url, { timeoutMs });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Réponse JSON invalide');
  }
}

/** Returns a decoded text stream, transparently gunzipping `.gz` payloads */
export async function fetchTextStream(url: string, timeoutMs = 120000): Promise<ReadableStream<string>> {
  const res = (await prefetched(url)) || (await fetchWithTimeout(url, { timeoutMs }));
  if (!res.body) throw new Error('Corps de réponse vide');
  const [probe, body] = res.body.tee();
  const reader = probe.getReader();
  const first = await reader.read();
  reader.cancel().catch(() => {});
  const bytes = first.value;
  const gz = !!bytes && bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  let stream: ReadableStream<Uint8Array> = body;
  if (gz) stream = stream.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
  return stream.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>);
}

/** Split a text stream into lines without buffering the whole payload */
export async function* lines(stream: ReadableStream<string>): AsyncGenerator<string> {
  const reader = stream.getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}
