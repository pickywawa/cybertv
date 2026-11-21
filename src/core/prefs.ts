import type { Profile } from './types';
import type { LangPrefs } from './util/lang';

/** Profile language/country preferences with defaults (app language, device region) */
export function langPrefs(p: Pick<Profile, 'lang' | 'audioLangs' | 'subLangs'>): LangPrefs {
  const audio = (p.audioLangs?.length ? p.audioLangs : [p.lang]).filter(Boolean);
  const subs = (p.subLangs?.length ? p.subLangs : [p.lang]).filter(Boolean);
  return { audio, subs };
}

export function profileCountry(p: Pick<Profile, 'lang' | 'country'>): string {
  if (p.country) return p.country;
  const region = (typeof navigator !== 'undefined' ? navigator.language : '').split('-')[1]?.toUpperCase();
  if (region && navigator.language.toLowerCase().startsWith(p.lang)) return region;
  return p.lang === 'fr' ? 'FR' : 'GB';
}

export function subMode(p: Pick<Profile, 'subMode'>): 'off' | 'auto' | 'always' {
  return p.subMode || 'auto';
}
