import type { Program } from './types';
import { norm } from './util/text';

/**
 * Live scores from ESPN's public scoreboard JSON (no key, no account; unofficial and undocumented,
 * so everything here is best effort and fails silently). Used to show "PSG 2 – 1 OM · 67'" on the
 * channel airing the match.
 */
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';

/** competitions followed per country (soccer first, then a few majors) */
const LEAGUES: Record<string, string[]> = {
  FR: [
    'soccer/fra.1', 'soccer/fra.2', 'soccer/fra.coupe_de_france', 'soccer/uefa.champions', 'soccer/uefa.europa', 'soccer/uefa.europa.conf',
    'soccer/eng.1', 'soccer/esp.1', 'soccer/ita.1', 'soccer/ger.1', 'soccer/fifa.world', 'soccer/uefa.nations', 'basketball/nba',
    // rugby: Top 14, Six Nations, European cups, test matches, World Cup
    'rugby/270559', 'rugby/180659', 'rugby/271937', 'rugby/272073', 'rugby/289234', 'rugby/164205',
  ],
  BE: ['soccer/bel.1', 'soccer/fra.1', 'soccer/uefa.champions', 'soccer/uefa.europa', 'soccer/eng.1'],
  CH: ['soccer/sui.1', 'soccer/fra.1', 'soccer/uefa.champions', 'soccer/uefa.europa'],
  GB: ['soccer/eng.1', 'soccer/eng.2', 'soccer/sco.1', 'soccer/uefa.champions', 'soccer/uefa.europa', 'soccer/eng.fa'],
  US: ['football/nfl', 'basketball/nba', 'hockey/nhl', 'baseball/mlb', 'soccer/usa.1'],
  DE: ['soccer/ger.1', 'soccer/ger.2', 'soccer/uefa.champions', 'soccer/uefa.europa'],
  ES: ['soccer/esp.1', 'soccer/esp.2', 'soccer/uefa.champions', 'soccer/uefa.europa'],
  IT: ['soccer/ita.1', 'soccer/ita.2', 'soccer/uefa.champions', 'soccer/uefa.europa'],
  PT: ['soccer/por.1', 'soccer/uefa.champions', 'soccer/uefa.europa'],
  NL: ['soccer/ned.1', 'soccer/uefa.champions', 'soccer/uefa.europa'],
};

export interface LiveEvent {
  id: string;
  start: number;
  state: 'pre' | 'in' | 'post';
  detail: string; // "67'", "HT", "FT"
  home: Team;
  away: Team;
}

export interface Team {
  name: string;
  short: string;
  score: string;
  keys: string[]; // normalised names used for matching
}

/** French TV names that differ from ESPN's */
const ALIASES: Record<string, string[]> = {
  'paris saint germain': ['psg', 'paris sg', 'paris'],
  marseille: ['om', 'olympique de marseille'],
  lyon: ['ol', 'olympique lyonnais'],
  'as monaco': ['monaco', 'asm'],
  lens: ['rc lens', 'rcl'],
  lille: ['losc'],
  'stade rennais': ['rennes'],
  'bayern munich': ['bayern', 'bayern munchen'],
  'manchester united': ['man united', 'man utd'],
  'manchester city': ['man city'],
  'inter milan': ['inter', 'internazionale'],
  'ac milan': ['milan'],
  'atletico madrid': ['atletico', 'atletico de madrid'],
  // national teams as French TV guides write them
  england: ['angleterre'], 'new zealand': ['nouvelle zelande'], ireland: ['irlande'], 'south africa': ['afrique du sud'],
  scotland: ['ecosse'], wales: ['pays de galles'], italy: ['italie'], argentina: ['argentine'], australia: ['australie'],
  japan: ['japon'], fiji: ['fidji'], spain: ['espagne'], germany: ['allemagne'], belgium: ['belgique'], netherlands: ['pays bas'],
  brazil: ['bresil'], switzerland: ['suisse'], 'united states': ['etats unis', 'usa'], morocco: ['maroc'], algeria: ['algerie'],
  tunisia: ['tunisie'], croatia: ['croatie'], georgia: ['georgie'], romania: ['roumanie'], samoa: ['samoa'], tonga: ['tonga'],
  'bordeaux begles': ['bordeaux begles', 'ubb', 'bordeaux'], 'stade francais paris': ['stade francais'], 'montpellier herault': ['montpellier'],
  'castres olympique': ['castres'], 'racing 92': ['racing'], 'rc toulon': ['toulon'], toulouse: ['stade toulousain', 'toulouse'],
};

const strip = (s: string) =>
  norm(s)
    .replace(/\b(fc|sc|ac|as|cf|ss|afc|olympique|stade|club|calcio|real club|rc)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function teamKeys(t: any): string[] {
  const names = [t.displayName, t.shortDisplayName, t.name, t.location, t.abbreviation].filter(Boolean).map((x: string) => norm(x));
  const extra = names.flatMap((n: string) => ALIASES[n] || []);
  return [...new Set([...names, ...names.map(strip), ...extra])].filter((k) => k.length >= 2);
}

let cache: { at: number; country: string; events: LiveEvent[] } | null = null;

export async function liveEvents(country: string): Promise<LiveEvent[]> {
  if (cache && cache.country === country && Date.now() - cache.at < 45000) return cache.events;
  const leagues = LEAGUES[country] || LEAGUES.FR;
  const results = await Promise.allSettled(leagues.map((l) => fetch(`${BASE}${l}/scoreboard`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json())));
  const events: LiveEvent[] = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const e of r.value?.events || []) {
      const c = e.competitions?.[0];
      const home = c?.competitors?.find((x: any) => x.homeAway === 'home');
      const away = c?.competitors?.find((x: any) => x.homeAway === 'away');
      if (!home || !away) continue;
      events.push({
        id: String(e.id),
        start: Date.parse(e.date),
        state: e.status?.type?.state || 'pre',
        detail: e.status?.type?.shortDetail || e.status?.displayClock || '',
        home: { name: home.team.displayName, short: home.team.abbreviation || home.team.shortDisplayName, score: String(home.score ?? ''), keys: teamKeys(home.team) },
        away: { name: away.team.displayName, short: away.team.abbreviation || away.team.shortDisplayName, score: String(away.score ?? ''), keys: teamKeys(away.team) },
      });
    }
  }
  cache = { at: Date.now(), country, events };
  return events;
}

const hasTeam = (text: string, t: Team) => t.keys.some((k) => (k.length <= 3 ? new RegExp(`\\b${k}\\b`).test(text) : text.includes(k)));

/** the event a programme is about: both teams named in its title, and kick-off inside the slot */
export function matchEvent(p: Program | undefined, events: LiveEvent[]): LiveEvent | undefined {
  if (!p || !events.length) return undefined;
  const text = ` ${norm(`${p.title} ${p.subTitle || ''}`)} `;
  return events.find((e) => e.start >= p.start - 45 * 60000 && e.start <= p.stop && hasTeam(text, e.home) && hasTeam(text, e.away));
}

/** "PSG 2 – 1 OM · 67'" */
export function scoreLabel(e: LiveEvent): string {
  if (e.state === 'pre') return `${e.home.short} – ${e.away.short}`;
  return `${e.home.short} ${e.home.score} – ${e.away.score} ${e.away.short}${e.detail ? ` · ${e.detail}` : ''}`;
}
