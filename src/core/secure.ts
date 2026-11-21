import { isNative } from './platform';
import { CyberNative } from './native';

/**
 * Secrets (Xtream passwords, TMDB token) — Android Keystore-backed on device,
 * localStorage fallback in the browser (dev only).
 */
const PREFIX = 'cybertv.secure.';

export async function secureGet(key: string): Promise<string | null> {
  if (isNative) return (await CyberNative.secureGet({ key })).value;
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export async function secureSet(key: string, value: string | null | undefined): Promise<void> {
  if (!value) return secureRemove(key);
  if (isNative) return CyberNative.secureSet({ key, value });
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    /* ignore */
  }
}

export async function secureRemove(key: string): Promise<void> {
  if (isNative) return CyberNative.secureRemove({ key });
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

export const sourcePassKey = (sourceId: string) => `src:${sourceId}:pass`;
export const tmdbKey = (profileId: string) => `tmdb:${profileId}`;
/** OpenSubtitles: API key + optional account (raises the daily download quota) */
export const osKey = (profileId: string) => `os:${profileId}:key`;
export const osUserKey = (profileId: string) => `os:${profileId}:user`;
export const osPassKey = (profileId: string) => `os:${profileId}:pass`;
