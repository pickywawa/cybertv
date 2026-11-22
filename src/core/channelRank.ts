import type { Channel, Program } from './types';
import { cleanName, norm } from './util/text';
import type { LangPrefs } from './util/lang';

/**
 * Reference channel rankings per country (most watched first), based on yearly audience shares
 * (Médiamétrie for France, BARB, AGF, Barlovento, Auditel…). No free API exposes live audiences,
 * so this static base is combined with what is on air right now (EPG) — see `rankChannels`.
 * Keys are normalised names (lowercase, no accents/spaces/punctuation: "Canal+" → "canal").
 */
const RANKS: Record<string, string[]> = {
  FR: [
    'tf1', 'france2', 'm6', 'france3', 'france5', 'canal', 'arte', 'tmc', 'bfmtv', 'w9', 'tfx', 'cnews', 'lci', 'franceinfo',
    '6ter', 'rmcstory', 'rmcdecouverte', 'tf1seriesfilms', 'cherie25', 'gulli', 'lequipe', 'lcp', 't18', 'novo19',
    'canalsport', 'canalfoot', 'canalcinema', 'canalcinemas', 'canalseries', 'beinsports1', 'beinsports', 'rmcsport1', 'eurosport1',
    'dazn1', 'ligue1', 'ligue1', 'parispremiere', 'teva', 'tv5monde', 'france4', 'franceo', 'm6music', 'bfmbusiness', 'euronews',
    'planete', 'ushuaiatv', 'nationalgeographic', 'discovery', 'histoiretv', 'disneychannel', 'canalj', 'tiji', 'cartoonnetwork',
    'nickelodeon', 'boomerang', 'mangas', 'ab1', 'rtl9', 'serieclub', 'tcmcinema', 'paramountnetwork', 'ocs', 'cineplus',
  ],
  BE: ['latrois', 'laune', 'rtltvi', 'tipik', 'clubrtl', 'plugrtl', 'abxplore', 'tf1', 'france2', 'ldc', 'vtm', 'een', 'canvas'],
  CH: ['rts1', 'rtsun', 'rts2', 'rtsdeux', 'tf1', 'france2', 'm6', 'srf1', 'srfzwei', 'rsila1'],
  CA: ['tva', 'icitele', 'noovo', 'teleQuebec', 'rds', 'lcn', 'rdi', 'cbc', 'ctv', 'global', 'tsn', 'sportsnet'],
  GB: [
    'bbcone', 'bbc1', 'itv1', 'itv', 'channel4', 'bbctwo', 'bbc2', 'channel5', 'skynews', 'bbcnews', 'skysportsmainevent',
    'skysportspremierleague', 'tntsports1', 'itv2', 'e4', 'more4', 'film4', 'dave', 'skyone', 'skyshowcase', 'skyatlantic', 'skycinemapremiere',
  ],
  US: ['cbs', 'nbc', 'abc', 'fox', 'foxnews', 'espn', 'cnn', 'msnbc', 'hgtv', 'tnt', 'tbs', 'usanetwork', 'amc', 'fx', 'discovery', 'hbo', 'pbs', 'cw'],
  DE: ['zdf', 'daserste', 'ard', 'rtl', 'sat1', 'vox', 'prosieben', 'kabeleins', 'rtlzwei', 'zdfneo', 'ntv', 'welt', 'tagesschau24', 'sport1', 'skysportbundesliga'],
  ES: ['antena3', 'la1', 'telecinco', 'lasexta', 'cuatro', 'la2', 'fdf', 'neox', 'nova', 'tv3', 'movistarlaliga', 'movistarplus', 'teledeporte'],
  IT: ['rai1', 'canale5', 'rai3', 'rai2', 'italia1', 'rete4', 'la7', 'tv8', 'nove', 'rainews24', 'skysport24', 'skytg24', 'dazn'],
  PT: ['tvi', 'sic', 'rtp1', 'cmtv', 'rtp2', 'sicnoticias', 'sporttv1'],
  NL: ['npo1', 'rtl4', 'sbs6', 'npo2', 'rtl5', 'net5', 'veronica', 'npo3', 'rtl7', 'ziggosport'],
  MA: ['almaghribia', '2m', 'alaoula', 'arryadia', 'medi1tv', 'tamazight', 'bein', 'aljazeera'],
  DZ: ['entv', 'canalalgerie', 'echorouk', 'ennahar', 'eldjazairia'],
  TN: ['wataniya1', 'elhiwar', 'nessma', 'attessia', 'carthage'],
  TR: ['trt1', 'atv', 'showtv', 'startv', 'kanald', 'foxtr', 'tv8'],
  PL: ['tvp1', 'polsat', 'tvn', 'tvp2', 'tvn24', 'tvpinfo'],
};

const key = (name: string) => norm(cleanName(name)).replace(/\s+/g, '').replace(/(hd|fhd|uhd|4k|sd)$/, '');

const INDEX: Map<string, Map<string, number>> = new Map(
  Object.entries(RANKS).map(([c, list]) => [c, new Map(list.map((k, i) => [k.toLowerCase(), i] as [string, number]).reverse())]),
);

/** 0-based popularity rank of a channel in a country, or undefined */
export function channelRank(ch: Pick<Channel, 'name' | 'epgId'>, country: string): number | undefined {
  const idx = INDEX.get(country);
  if (!idx) return undefined;
  const k = key(ch.name);
  const direct = idx.get(k);
  if (direct !== undefined) return direct;
  // regional variants ("France 3 Paris", "BBC One London") rank below the national feed
  for (const base of ['france3', 'bbcone', 'itv1', 'rai3']) if (k.startsWith(base) && idx.has(base)) return idx.get(base)! + 12;
  // "tf1.fr" style EPG ids
  const e = ch.epgId?.split('.')[0]?.replace(/[^a-z0-9]/g, '');
  if (e && idx.get(e) !== undefined) return idx.get(e);
  return undefined;
}

const SPORT_CAT = /sport|football|soccer|rugby|tennis|basket|cyclisme|cycling|formula|f1|moto|handball|golf|boxe|boxing|mma|ufc|athle/i;
const LIVE_EVENT = /( - | vs\.? | v | contre |match|finale|final\b|ligue|liga|league|coupe|cup\b|grand prix|gp |champions|derby|direct|live|en direct|multiplex)/i;
const BIG_EVENT = /(finale|final\b|coupe du monde|world cup|euro 20\d\d|jeux olympiques|olympic|ligue des champions|champions league|six nations|tour de france|roland|wimbledon|super bowl|clasico|classique|grand prix)/i;
const NEWS = /^(le )?(jt|journal|20h|13h|19\/20|le 20h|le 13h|news at|tagesschau|telediario|tg1)/i;
const MOVIE_CAT = /film|cin[ée]ma|movie|t[ée]l[ée]film/i;

/** bonus for what is on air: live sport, big events, prime-time films, main news */
export function programBoost(p: Program | undefined, at = Date.now()): number {
  if (!p) return 0;
  let b = 0;
  const cat = p.category || '';
  const text = `${p.title} ${p.subTitle || ''}`;
  const sport = SPORT_CAT.test(cat) || SPORT_CAT.test(p.title);
  // small on purpose: TF1, France 2… stay on top, a live match only passes channels of similar audience
  if (sport && LIVE_EVENT.test(text)) b += 6;
  if (BIG_EVENT.test(text)) b += 6;
  if (NEWS.test(p.title)) b += 2;
  const h = new Date(at).getHours();
  if (MOVIE_CAT.test(cat) && h >= 20 && h <= 22) b += 2;
  // a programme that just started is more attractive than one ending in 5 minutes
  const left = p.stop - at;
  if (left > 0 && left < 8 * 60000) b -= 2;
  return b;
}

export interface RankCtx {
  country: string;
  prefs: LangPrefs;
  /** program on air (or tonight's main program) per epgId */
  programs?: Map<string, Program | undefined>;
  at?: number;
}

export function channelScore(c: Channel, ctx: RankCtx): number {
  let s = 0;
  const r = channelRank(c, ctx.country);
  if (r !== undefined) s += Math.max(10, 100 - r * 2.2);
  const langs = c.langs || [];
  if (ctx.prefs.audio[0] && langs.includes(ctx.prefs.audio[0])) s += 50;
  else if (ctx.prefs.audio[1] && langs.includes(ctx.prefs.audio[1])) s += 35;
  else if (!langs.length) s += 10;
  else s -= 30;
  if (c.country && c.country === ctx.country) s += 25;
  if (c.epgId && ctx.programs) s += programBoost(ctx.programs.get(c.epgId), ctx.at);
  else if (!c.epgId) s -= 5;
  return s;
}

/** "Best" channels first: national ranking × user languages × what's on now */
export function rankChannels(list: Channel[], ctx: RankCtx): Channel[] {
  return list
    .map((c) => ({ c, s: channelScore(c, ctx) }))
    .sort((a, b) => b.s - a.s || a.c.num - b.c.num)
    .map((x) => x.c);
}

export function matchesLangs(c: Pick<Channel, 'langs'>, prefs: LangPrefs): boolean {
  return !c.langs?.length || c.langs.some((l) => prefs.audio.includes(l));
}
