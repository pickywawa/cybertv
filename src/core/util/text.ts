import type { Quality, Universe } from '../types';

/** lowercase, strip accents & punctuation, collapse spaces */
export function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const QUALITY_RE = /\b(UHD|4K|2160P?|FHD|1080P?|FULL ?HD|HD|720P?|SD|576P?|480P?|HEVC|H265|H\.265)\b/gi;

export function detectQuality(name: string): Quality {
  const n = name.toUpperCase();
  if (/\b(HEVC|H265|H\.265)\b/.test(n)) return 'HEVC';
  if (/\b(UHD|4K|2160P?)\b/.test(n)) return '4K';
  if (/\b(FHD|1080P?|FULL ?HD)\b/.test(n)) return 'FHD';
  if (/\b(HD|720P?)\b/.test(n)) return 'HD';
  if (/\b(SD|576P?|480P?)\b/.test(n)) return 'SD';
  return null;
}

export const QUALITY_RANK: Record<string, number> = { '4K': 5, HEVC: 4, FHD: 3, HD: 2, SD: 1, null: 2.5 };

/** Strip provider noise: country prefixes, quality tags, brackets, separators */
export function cleanName(raw: string): string {
  let s = raw;
  s = s.replace(/^\s*(\|[A-Z]{2,3}\||\[[A-Z]{2,3}\]|[A-Z]{2,3}\s*[:|\-–]\s+|[A-Z]{2,3}\s*\|\s*)/i, '');
  s = s.replace(/^\s*(FR|EN|UK|US|DE|ES|IT|BE|CH|CA|AR|MULTI|VF|VOSTFR)\s*[:|\-–]\s*/i, '');
  s = s.replace(QUALITY_RE, '');
  s = s.replace(/\b(MULTI|VFF|VFQ|VF|VOSTFR|VOST|TRUEFRENCH|FRENCH|HDR10?\+?|HDR|DV|DOLBY VISION|BACKUP|RAW|\+1)\b/gi, '');
  s = s.replace(/[\[(]\s*[)\]]/g, '');
  s = s.replace(/\s*[|•·]\s*$/g, '').replace(/^\s*[|•·:\-–]\s*/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s || raw.trim();
}

/** "Dune (2021) 4K" -> { title: "Dune", year: 2021 } */
export function parseTitleYear(raw: string): { title: string; year?: number } {
  let s = cleanName(raw);
  let year: number | undefined;
  const m = s.match(/[(\[]\s*((?:19|20)\d{2})\s*[)\]]/) || s.match(/\s-\s*((?:19|20)\d{2})\s*$/) || s.match(/\s((?:19|20)\d{2})\s*$/);
  if (m) {
    year = parseInt(m[1], 10);
    s = s.replace(m[0], ' ');
  }
  s = s.replace(/\s{2,}/g, ' ').replace(/[\s\-–:]+$/, '').trim();
  return { title: s || raw.trim(), year };
}

export function channelGroupKey(rawName: string): string {
  return 'ch:' + norm(cleanName(rawName)).replace(/\s+/g, '');
}

export function movieGroupKey(title: string, year: number | undefined, tmdbId?: number): string {
  return tmdbId ? `mv:t${tmdbId}` : `mv:${norm(title).replace(/\s+/g, '')}:${year ?? ''}`;
}

export function seriesGroupKey(title: string, tmdbId?: number): string {
  return tmdbId ? `sr:t${tmdbId}` : `sr:${norm(title).replace(/\s+/g, '')}`;
}

/** "Lupin S02 E05" -> { show: "Lupin", season: 2, episode: 5 } */
export function parseEpisode(raw: string): { show: string; season: number; episode: number } | null {
  const m = raw.match(/^(.*?)[\s._\-–|]*S(\d{1,2})\s*[._\-]?\s*E(\d{1,4})\b/i) || raw.match(/^(.*?)[\s._\-–|]*(\d{1,2})x(\d{1,3})\b/i);
  if (!m) return null;
  return { show: cleanName(m[1]).replace(/[\s\-–:]+$/, ''), season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };
}

const UNIVERSE_RULES: [Universe, RegExp][] = [
  ['adult', /\b(adult|adulte|xxx|18\+|\+18|porn|hot|erotic)\b/],
  ['sport', /\b(sport|sports|foot|football|golf|rugby|tennis|f1|formula|moto ?gp|nba|nfl|bein|eurosport|equi|equidia|dazn|arena|ufc|boxe|cyclisme|ligue 1|premier league)\b/],
  ['kids', /\b(jeunesse|kids|kid|enfant|enfants|junior|cartoon|toon|toons|disney|gulli|nickelodeon|nick|boomerang|tiji|piwi|teletoon|animation|anime)\b/],
  ['news', /\b(info|infos|news|actu|actualite|bfm|cnews|lci|franceinfo|euronews|cnn|bbc news|world news|24)\b/],
  ['cinema', /\b(cine|cinema|film|films|movie|movies|cinemax|tcm|paramount channel|action|frisson|classic)\b/],
  ['series', /\b(serie|series|polar|sitcom|drama)\b/],
  ['docs', /\b(decouverte|documentaire|documentaires|docu|doc|docs|nature|histoire|history|planete|voyage|national geographic|nat geo|discovery|science|ushuaia|animaux|animal)\b/],
  ['music', /\b(music|musique|mtv|hits|jazz|radio|clip|clips|mezzo|trace)\b/],
  ['ent', /\b(divertissement|entertainment|variete|varietes|jeux|humour|comedy|telerealite)\b/],
  ['general', /\b(generaliste|generalistes|tnt|nationale|nationales|general)\b/],
];

export function detectUniverse(...texts: (string | undefined)[]): Universe {
  for (const t of texts) {
    if (!t) continue;
    const n = ' ' + norm(t) + ' ';
    for (const [u, re] of UNIVERSE_RULES) if (re.test(n)) return u;
  }
  return 'other';
}

export function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 45% 32%)`;
}

export function initials(s: string): string {
  const w = cleanName(s).split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase();
}

export const uid = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

/** provider episode titles that carry no information ("Episode 3", "S01E03") */
export const isGenericEpisodeTitle = (t?: string) => !t || /^((É|E)pisode\s*\d+|S\d+\s*[._-]?\s*E\d+)$/i.test(t.trim());
