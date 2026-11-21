/**
 * Rewrites every URI of an HLS playlist so it goes through the CORS proxy.
 * Shared by the Vite dev proxy (Node) and unit tests; the Android native proxy mirrors this logic in Kotlin.
 */
export function rewriteM3u8(body: string, baseUrl: string, proxify: (absUrl: string) => string): string {
  const resolve = (u: string) => {
    try {
      return new URL(u, baseUrl).toString();
    } catch {
      return u;
    }
  };
  return body
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_m, u: string) => `URI="${proxify(resolve(u))}"`);
      }
      return proxify(resolve(t));
    })
    .join('\n');
}

export function isM3u8(url: string, contentType: string | null): boolean {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('mpegurl')) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}
