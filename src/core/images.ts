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

/**
 * Logo URL readable by a canvas (CORS): the native /img proxy on Android, the dev proxy in the
 * browser during development. null = can't be analysed (the logo is shown as is).
 */
export function analysableLogoUrl(url: string): string | null {
  if (!/^https?:\/\//.test(url)) return null;
  if (isNative) return imgBase ? imgBase + encodeURIComponent(url) : null;
  if (import.meta.env.DEV) return `${location.origin}/proxy?u=${encodeURIComponent(url)}`;
  return null;
}

export type LogoTone = 'ok' | 'dim' | 'dark';
const TONE_KEY = 'cybertv.logoTone.v2';
let tones: Record<string, LogoTone> | null = null;

function loadTones(): Record<string, LogoTone> {
  if (tones) return tones;
  try {
    tones = JSON.parse(localStorage.getItem(TONE_KEY) || '{}');
  } catch {
    tones = {};
  }
  return tones!;
}

export function knownTone(url: string): LogoTone | undefined {
  return loadTones()[url];
}

let saveTimer = 0;
/**
 * Average brightness of the visible pixels of a logo drawn on a transparent canvas.
 * Logos with their own opaque background are left alone; dark logos on transparency would vanish
 * on the dark theme ("France 2" in navy/black): 'dark' → shown as a white silhouette, 'dim' → brightened.
 */
export function analyseLogo(url: string, img: HTMLImageElement): LogoTone {
  let tone: LogoTone = 'ok';
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 40;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, 40, 40);
    const d = ctx.getImageData(0, 0, 40, 40).data;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 64) continue;
      sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      n++;
    }
    const transparent = 1 - n / (d.length / 4);
    if (n && transparent > 0.08) {
      const lum = sum / n;
      tone = lum < 0.27 ? 'dark' : lum < 0.36 ? 'dim' : 'ok';
    }
  } catch {
    return 'ok'; // tainted canvas: no CORS, leave it
  }
  const t = loadTones();
  t[url] = tone;
  // bounded, persisted lazily
  const keys = Object.keys(t);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete t[k];
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(TONE_KEY, JSON.stringify(t));
    } catch {
      /* ignore */
    }
  }, 1500);
  return tone;
}
