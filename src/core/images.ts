import { isNative } from './platform';

/**
 * Image caching:
 * - Android: every remote image (provider logos/posters and TMDB) goes through the native proxy
 *   `/img` endpoint, which keeps a persistent LRU disk cache (400 MB) independent of the WebView cache.
 * - Web: a service worker (public/sw.js) serves images cache-first.
 */
let imgBase: string | null = null;
export function setImageProxy(base: string | null) {
  imgBase = base;
}
export function imgUrl(url: string): string {
  if (!isNative || !imgBase || !/^https?:\/\//.test(url)) return url;
  return imgBase + encodeURIComponent(url);
}

export function registerImageCache() {
  if (isNative || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
