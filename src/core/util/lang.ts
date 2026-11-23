import { norm } from './text';

/** ISO 639-1 languages offered in the profile + their display flag */
export const LANGUAGES: { code: string; name: string; flag: string }[] = [
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'it', name: 'Italiano', flag: '🇮🇹' },
  { code: 'pt', name: 'Português', flag: '🇵🇹' },
  { code: 'nl', name: 'Nederlands', flag: '🇳🇱' },
  { code: 'ar', name: 'العربية', flag: '🇸🇦' },
  { code: 'tr', name: 'Türkçe', flag: '🇹🇷' },
  { code: 'pl', name: 'Polski', flag: '🇵🇱' },
  { code: 'ru', name: 'Русский', flag: '🇷🇺' },
  { code: 'ja', name: '日本語', flag: '🇯🇵' },
  { code: 'ko', name: '한국어', flag: '🇰🇷' },
  { code: 'zh', name: '中文', flag: '🇨🇳' },
  { code: 'hi', name: 'हिन्दी', flag: '🇮🇳' },
];

export const COUNTRIES: { code: string; name: string; flag: string; lang: string }[] = [
  { code: 'FR', name: 'France', flag: '🇫🇷', lang: 'fr' },
  { code: 'BE', name: 'Belgique', flag: '🇧🇪', lang: 'fr' },
  { code: 'CH', name: 'Suisse', flag: '🇨🇭', lang: 'fr' },
  { code: 'CA', name: 'Canada', flag: '🇨🇦', lang: 'fr' },
  { code: 'LU', name: 'Luxembourg', flag: '🇱🇺', lang: 'fr' },
  { code: 'MA', name: 'Maroc', flag: '🇲🇦', lang: 'ar' },
  { code: 'DZ', name: 'Algérie', flag: '🇩🇿', lang: 'ar' },
  { code: 'TN', name: 'Tunisie', flag: '🇹🇳', lang: 'ar' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧', lang: 'en' },
  { code: 'US', name: 'United States', flag: '🇺🇸', lang: 'en' },
  { code: 'DE', name: 'Deutschland', flag: '🇩🇪', lang: 'de' },
  { code: 'ES', name: 'España', flag: '🇪🇸', lang: 'es' },
  { code: 'IT', name: 'Italia', flag: '🇮🇹', lang: 'it' },
  { code: 'PT', name: 'Portugal', flag: '🇵🇹', lang: 'pt' },
  { code: 'NL', name: 'Nederland', flag: '🇳🇱', lang: 'nl' },
  { code: 'TR', name: 'Türkiye', flag: '🇹🇷', lang: 'tr' },
  { code: 'PL', name: 'Polska', flag: '🇵🇱', lang: 'pl' },
];

export function flagOf(lang: string): string {
  return LANGUAGES.find((l) => l.code === lang)?.flag || '🏳️';
}
export function langName(lang: string): string {
  return LANGUAGES.find((l) => l.code === lang)?.name || lang.toUpperCase();
}

/** ISO 639-2/3 & English names (from containers / players / M3U tvg-language) → 639-1 */
const ALIASES: Record<string, string> = {
  fre: 'fr', fra: 'fr', french: 'fr', francais: 'fr',
  eng: 'en', english: 'en', anglais: 'en',
  spa: 'es', spanish: 'es', espanol: 'es', castellano: 'es',
  ger: 'de', deu: 'de', german: 'de', deutsch: 'de', allemand: 'de',
  ita: 'it', italian: 'it', italiano: 'it',
  por: 'pt', portuguese: 'pt', portugues: 'pt',
  dut: 'nl', nld: 'nl', dutch: 'nl', nederlands: 'nl',
  ara: 'ar', arabic: 'ar', arabe: 'ar',
  tur: 'tr', turkish: 'tr', turk: 'tr',
  pol: 'pl', polish: 'pl', rus: 'ru', russian: 'ru',
  jpn: 'ja', japanese: 'ja', kor: 'ko', korean: 'ko', chi: 'zh', zho: 'zh', chinese: 'zh', hin: 'hi', hindi: 'hi',
};

/** normalise any language tag ("fre", "fr-FR", "French") to ISO 639-1, or undefined */
export function toLang(tag?: string | null): string | undefined {
  if (!tag) return undefined;
  const t = norm(tag).split(/[\s_-]/)[0];
  if (!t || t === 'und' || t === 'mul' || t === 'zxx') return undefined;
  if (t.length === 2 && LANGUAGES.some((l) => l.code === t)) return t;
  return ALIASES[t];
}

/** country prefixes used by providers ("FR:", "|UK|", "[DE]") and EPG id suffixes ("tf1.fr") → language */
const COUNTRY_LANG: Record<string, string> = {
  fr: 'fr', fra: 'fr', be: 'fr', ch: 'fr', qc: 'fr', lu: 'fr',
  uk: 'en', gb: 'en', us: 'en', usa: 'en', en: 'en', au: 'en', ie: 'en', nz: 'en',
  de: 'de', ger: 'de', at: 'de',
  es: 'es', esp: 'es', mx: 'es', lat: 'es', latino: 'es', ar: 'ar', arb: 'ar', ma: 'ar', dz: 'ar', tn: 'ar', eg: 'ar', sa: 'ar', ae: 'ar',
  it: 'it', ita: 'it', pt: 'pt', br: 'pt', nl: 'nl', tr: 'tr', pl: 'pl', ru: 'ru', in: 'hi', jp: 'ja', kr: 'ko', cn: 'zh',
};

const WORD_LANG: [RegExp, string][] = [
  [/\b(france|french|francais|francaise|vff|vfq|truefrench|vf)\b/, 'fr'],
  [/\b(english|anglais|united kingdom|usa|american)\b/, 'en'],
  [/\b(espana|spain|spanish|espanol|latino|castellano)\b/, 'es'],
  [/\b(germany|deutschland|german|deutsch|allemand)\b/, 'de'],
  [/\b(italia|italy|italian|italiano)\b/, 'it'],
  [/\b(portugal|portuguese|brasil|brazil)\b/, 'pt'],
  [/\b(arabic|arabe|arab|maghreb|morocco|maroc|algerie|tunisie)\b/, 'ar'],
  [/\b(turkey|turkiye|turkish|turk)\b/, 'tr'],
  [/\b(nederland|netherlands|dutch)\b/, 'nl'],
  [/\b(poland|polska|polish)\b/, 'pl'],
];

export interface LangInfo {
  /** audio languages (most likely first) */
  audio: string[];
  /** subtitle languages */
  subs: string[];
  /** MULTI tag: provider's local dub + original version */
  multi?: boolean;
}

/**
 * Best-effort language detection from provider names/categories/attributes.
 * The first argument with a hit wins (item name before category name).
 */
export function detectLangs(...texts: (string | undefined)[]): LangInfo {
  for (const raw of texts) {
    if (!raw) continue;
    const info = detectOne(raw);
    if (info.audio.length || info.subs.length) return info;
  }
  return { audio: [], subs: [] };
}

function detectOne(raw: string): LangInfo {
  const audio = new Set<string>();
  const subs = new Set<string>();
  const up = raw.toUpperCase();
  let multi = false;
  if (/\bVOST(FR)?\b|\bSUBFR\b|\bST ?FR\b/.test(up)) subs.add('fr');
  else if (/\bVOSTEN\b|\bENG ?SUBS?\b/.test(up)) subs.add('en');
  if (/\bMULTI\b/.test(up)) {
    multi = true;
    audio.add('fr');
  }
  if (/\b(VFF|VFQ|VFI|VF2?|TRUEFRENCH|FRENCH)\b/.test(up)) audio.add('fr');
  // country prefix: "FR:", "FR |", "|FR|", "[FR]", "FR-", "(FR)"
  const pre = raw.match(/^\s*[\[(|]?\s*([A-Z]{2,3}|LATINO)\s*[\])|:\-–]/);
  if (pre && !subs.size) {
    const l = COUNTRY_LANG[pre[1].toLowerCase()];
    if (l) audio.add(l);
  }
  // trailing tag: "Dune (2021) [EN]", "Film - EN"
  const post = raw.match(/[\[(|\-–]\s*(FR|EN|ES|DE|IT|PT|AR|NL|TR|PL)\s*[\])|]?\s*$/);
  if (post && !subs.size) {
    const l = COUNTRY_LANG[post[1].toLowerCase()];
    if (l) audio.add(l);
  }
  if (!audio.size && !subs.size) {
    const n = ' ' + norm(raw) + ' ';
    for (const [re, l] of WORD_LANG) if (re.test(n)) {
      audio.add(l);
      break;
    }
  }
  return { audio: [...audio], subs: [...subs], multi };
}

/** "tf1.fr" / "bbcone.uk" / "TF1.fr@SD" → audio language of the country suffix */
export function langFromEpgId(epgId?: string): string | undefined {
  const m = epgId?.toLowerCase().match(/\.([a-z]{2,3})(?:@[\w-]+)?$/);
  return m ? COUNTRY_LANG[m[1]] : undefined;
}

/** "tf1.fr" → "FR" */
export function countryFromEpgId(epgId?: string): string | undefined {
  const m = epgId?.toLowerCase().match(/\.([a-z]{2})(?:@[\w-]+)?$/);
  if (!m) return undefined;
  return m[1] === 'uk' ? 'GB' : m[1].toUpperCase();
}

export interface LangPrefs {
  audio: string[];
  subs: string[];
}

export interface HasLangs {
  langs?: string[];
  subs?: string[];
  origLang?: string;
}

/**
 * 0 = primary audio language, 1 = secondary, 2 = subtitled in a preferred language,
 * 3 = unknown, 4 = another language. Lower is better.
 */
export function langScore(it: HasLangs, p: LangPrefs): number {
  const audio = it.langs?.length ? it.langs : [];
  if (p.audio[0] && audio.includes(p.audio[0])) return 0;
  if (p.audio[1] && audio.includes(p.audio[1])) return 1;
  if (it.subs?.some((s) => p.subs.includes(s))) return 2;
  if (!audio.length) {
    // untagged: an original version in a preferred language is still a match
    if (it.origLang && it.origLang === p.audio[0]) return 0.5;
    if (it.origLang && it.origLang === p.audio[1]) return 1.5;
    return 3;
  }
  return 4;
}

/** stable sort by language preference (keeps the incoming order inside each bucket) */
export function sortByLang<T extends HasLangs>(rows: T[], p: LangPrefs): T[] {
  return rows
    .map((r, i) => ({ r, i, s: langScore(r, p) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.r);
}

const PREFIX_COUNTRY: Record<string, string> = {
  FR: 'FR', FRA: 'FR', BE: 'BE', CH: 'CH', CA: 'CA', QC: 'CA', LU: 'LU', UK: 'GB', GB: 'GB', US: 'US', USA: 'US',
  DE: 'DE', ES: 'ES', IT: 'IT', PT: 'PT', NL: 'NL', TR: 'TR', PL: 'PL', MA: 'MA', DZ: 'DZ', TN: 'TN',
};
const WORD_COUNTRY: [RegExp, string][] = [
  [/\b(france|francaise?s?|tnt)\b/, 'FR'], [/\b(belgique|belgium)\b/, 'BE'], [/\b(suisse|switzerland)\b/, 'CH'],
  [/\b(quebec|canada)\b/, 'CA'], [/\b(united kingdom|uk|britain)\b/, 'GB'], [/\b(usa|united states)\b/, 'US'],
  [/\b(germany|deutschland|allemagne)\b/, 'DE'], [/\b(espana|spain|espagne)\b/, 'ES'], [/\b(italia|italy|italie)\b/, 'IT'],
  [/\b(portugal)\b/, 'PT'], [/\b(maroc|morocco)\b/, 'MA'], [/\b(algerie|algeria)\b/, 'DZ'], [/\b(tunisie|tunisia)\b/, 'TN'],
];

/** country of a live channel: name prefix, then EPG id suffix, then category words */
export function channelCountry(rawName: string, catName?: string, epgId?: string, tvgCountry?: string): string | undefined {
  if (tvgCountry) {
    const c = tvgCountry.split(/[;,]/)[0].trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c)) return c === 'UK' ? 'GB' : c;
  }
  for (const t of [rawName, catName]) {
    const pre = t?.match(/^\s*[\[(|]?\s*([A-Z]{2,3})\s*[\])|:\-–]/);
    if (pre && PREFIX_COUNTRY[pre[1]]) return PREFIX_COUNTRY[pre[1]];
  }
  const fromEpg = countryFromEpgId(epgId);
  if (fromEpg) return fromEpg;
  if (catName) {
    const n = ' ' + norm(catName) + ' ';
    for (const [re, c] of WORD_COUNTRY) if (re.test(n)) return c;
  }
  return undefined;
}

export const COUNTRY_DEFAULT_LANG: Record<string, string> = Object.fromEntries(COUNTRIES.map((c) => [c.code, c.lang]));

/** audio languages of a live channel */
export function channelLangs(rawName: string, catName?: string, epgId?: string, tvgLanguage?: string, country?: string): string[] {
  const fromAttr = (tvgLanguage || '').split(/[;,]/).map((x) => toLang(x.trim())).filter(Boolean) as string[];
  if (fromAttr.length) return [...new Set(fromAttr)];
  const d = detectLangs(rawName, catName);
  if (d.audio.length) return d.audio;
  const e = langFromEpgId(epgId);
  if (e) return [e];
  if (country && COUNTRY_DEFAULT_LANG[country]) return [COUNTRY_DEFAULT_LANG[country]];
  return [];
}

// ─────────── provider categories by language (download only the user's languages) ───────────

/** country / language tags seen in provider category names → language */
const CAT_TAG: Record<string, string> = {
  ...COUNTRY_LANG,
  al: 'sq', bg: 'bg', hu: 'hu', ro: 'ro', dk: 'da', da: 'da', no: 'no', fi: 'fi', is: 'is', se: 'sv', sw: 'sv', gr: 'el', cz: 'cs', sk: 'sk',
  ua: 'uk', il: 'he', ir: 'fa', pk: 'ur', exyu: 'sr', yu: 'sr', hr: 'hr', rs: 'sr', ba: 'bs', mk: 'mk', si: 'sl', lt: 'lt', lv: 'lv', ee: 'et',
  th: 'th', vn: 'vi', ph: 'tl', id: 'id', my: 'ms', ku: 'ku', kurd: 'ku', am: 'hy', ge: 'ka', az: 'az', alb: 'sq', ru: 'ru', rus: 'ru',
};
const SCRIPT_LANG: [RegExp, string][] = [
  [/[؀-ۿ]/, 'ar'],
  [/[Ѐ-ӿ]/, 'ru'],
  [/[Ͱ-Ͽ]/, 'el'],
  [/[֐-׿]/, 'he'],
  [/[ऀ-ॿ]/, 'hi'],
  [/[฀-๿]/, 'th'],
  [/[぀-ヿ]/, 'ja'],
  [/[가-힯]/, 'ko'],
  [/[一-鿿]/, 'zh'],
];
const CAT_WORDS: [RegExp, string][] = [
  ...WORD_LANG,
  [/\b(albania|bulgaria|hungaria|hungary|romania|danmark|dansk|denmark|norway|norge|finland|suomi|iceland|sweden|sverige|greece|czech|slovak|ukraine|israel|iran|persian|pakistan|punjabi|india|hindi|bollywood|tamil|telugu|kurdish|armenia|georgia|russia|russian|somalia|afghan)\b/, '?'],
];

/**
 * Languages a provider category is in ("COMEDIE [FR]" → fr, "KOMEDIE [NL]" → nl, "أفلام عربية" → ar).
 * Empty when nothing says it (kept: "NETFLIX [MULTISUB]", "TOP 500 IMDB"…).
 */
export function categoryLangs(name: string): string[] {
  const out = new Set<string>();
  const up = name.toUpperCase();
  if (/\bMULTI(SUB|LANG|AUDIO)?\b/.test(up)) out.add('multi');
  for (const m of name.matchAll(/[[(|]\s*([A-Za-z]{2,5})\s*[\])|]/g)) {
    const l = CAT_TAG[m[1].toLowerCase()];
    if (l) out.add(l);
  }
  const pre = name.match(/^\s*([A-Za-z]{2,5})\s*[:|\-–]\s/);
  if (pre && CAT_TAG[pre[1].toLowerCase()]) out.add(CAT_TAG[pre[1].toLowerCase()]);
  for (const [re, l] of SCRIPT_LANG) if (re.test(name)) out.add(l);
  if (!out.size) {
    const n = ' ' + norm(name) + ' ';
    for (const [re, l] of CAT_WORDS) {
      const m = n.match(re);
      if (!m) continue;
      out.add(l === '?' ? `x-${m[1]}` : l);
      break;
    }
  }
  return [...out];
}

/** a category is downloaded when it is in one of `langs`, multi-language, or says nothing */
export function keepCategory(name: string, langs: string[]): boolean {
  const l = categoryLangs(name);
  if (!l.length || l.includes('multi')) return true;
  return l.some((x) => langs.includes(x));
}
