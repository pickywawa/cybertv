import { isNative } from './platform';

/**
 * On Android, provider images (often without cache headers) go through the native proxy
 * `/img` endpoint which keeps an LRU disk cache. TMDB images are CDN-cached already.
 */
let imgBase: string | null = null;
export function setImageProxy(base: string | null) {
  imgBase = base;
}
export function imgUrl(url: string): string {
  if (!isNative || !imgBase || !/^https?:\/\//.test(url) || url.includes('image.tmdb.org')) return url;
  return imgBase + encodeURIComponent(url);
}
