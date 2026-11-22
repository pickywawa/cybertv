import { norm } from '../util/text';

/**
 * Spoken commands (French and English) turned into app intents, with no external service:
 * "mets France 2", "accueil", "recherche Dune", "lance le film Dune", "recule de 30 secondes"…
 */
export type VoiceTab = 'home' | 'tv' | 'replay' | 'myvideos' | 'settings' | 'search';
export type PlayerAction = 'pause' | 'resume' | 'back' | 'forward' | 'live' | 'next' | 'prev' | 'stop';

export type VoiceIntent =
  | { type: 'tab'; tab: VoiceTab }
  | { type: 'search'; query: string }
  | { type: 'channel'; query: string; num?: number }
  | { type: 'movie'; query: string }
  | { type: 'series'; query: string }
  /** "mets X": a channel, else a movie or a series */
  | { type: 'play'; query: string }
  | { type: 'player'; action: PlayerAction; seconds?: number }
  | { type: 'unknown'; text: string };

const NUMS: Record<string, number> = {
  zero: 0, un: 1, une: 1, one: 1, deux: 2, two: 2, trois: 3, three: 3, quatre: 4, four: 4, cinq: 5, five: 5, six: 6, sept: 7, seven: 7,
  huit: 8, eight: 8, neuf: 9, nine: 9, dix: 10, ten: 10, onze: 11, douze: 12, treize: 13, quinze: 15, fifteen: 15, vingt: 20, twenty: 20,
  trente: 30, thirty: 30, quarante: 40, forty: 40, cinquante: 50, fifty: 50, soixante: 60, sixty: 60,
};

/** "france deux" → "france 2", "quarante cinq" → "45" */
export function wordsToDigits(s: string): string {
  const parts = s.split(' ');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i];
    const n = NUMS[w];
    if (n === undefined) {
      out.push(w);
      continue;
    }
    // tens followed by a unit ("vingt cinq", "trente et un")
    let v = n;
    if (n >= 20 && n % 10 === 0) {
      const next = parts[i + 1] === 'et' ? parts[i + 2] : parts[i + 1];
      const u = next !== undefined ? NUMS[next] : undefined;
      if (u !== undefined && u > 0 && u < 10) {
        v += u;
        i += parts[i + 1] === 'et' ? 2 : 1;
      }
    }
    out.push(String(v));
  }
  return out.join(' ');
}

/** "30 secondes", "2 minutes", "une minute" → seconds */
function duration(s: string): number | undefined {
  const m = s.match(/(\d+)\s*(secondes?|sec|seconds?|s|minutes?|min|mn)\b/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return /^m/.test(m[2]) ? n * 60 : n;
}

const strip = (s: string, re: RegExp) => s.replace(re, '').trim();
/** articles and courtesy words that only get in the way */
const filler = (s: string) =>
  strip(s.replace(/\b(s il te plait|s il vous plait|stp|svp|please)\b/g, ''), /^(le|la|les|l|un|une|du|de la|des|the|a|an)\s+/);

export function parseVoice(raw: string, ctx: { inPlayer?: boolean } = {}): VoiceIntent {
  let s = wordsToDigits(norm(raw).replace(/\bcanal plus\b/g, 'canal'));
  s = strip(s, /^(ok |dis |hey )?(cyber ?iptv |cyber tv )?/);
  s = filler(s);
  if (!s) return { type: 'unknown', text: raw };

  // ── player controls (only while watching) ──
  if (ctx.inPlayer) {
    if (/^(met |mets |fais |faire )?(pause|stop pause)$/.test(s) || s === 'pause') return { type: 'player', action: 'pause' };
    if (/^(reprends?|reprendre|continue|continuer|lecture|play|resume|relance)$/.test(s)) return { type: 'player', action: 'resume' };
    if (/^(recule|reviens? en arriere|retour arriere|retourne en arriere|rewind|go back|back)\b/.test(s)) return { type: 'player', action: 'back', seconds: duration(s) ?? 30 };
    if (/^(avance|avancer|va plus loin|fast forward|forward|skip)\b/.test(s)) return { type: 'player', action: 'forward', seconds: duration(s) ?? 30 };
    if (/^(reviens? au direct|retour au direct|retourne au direct|au direct|en direct|direct|go live|live)$/.test(s)) return { type: 'player', action: 'live' };
    if (/^(chaine suivante|suivante|suivant|next channel|next|channel up)$/.test(s)) return { type: 'player', action: 'next' };
    if (/^(chaine precedente|precedente|precedent|previous channel|previous|channel down)$/.test(s)) return { type: 'player', action: 'prev' };
    if (/^(quitte|quitter|ferme|fermer|arrete|arreter|stop|sors|sortir|exit|close)$/.test(s)) return { type: 'player', action: 'stop' };
  }

  // ── tabs ──
  const go = strip(s, /^(va |aller |allez |ouvre |ouvrir |affiche |afficher |montre |retour |retourne |go to |go |open |show )?(sur l |a l |sur la |sur le |sur |aux |au |a |l |la |le |les |the )?/);
  if (/^(accueil|page d accueil|home|home page|menu)$/.test(go)) return { type: 'tab', tab: 'home' };
  if (/^(en direct|direct|tv en direct|television|tele|la tele|chaines|les chaines|live|live tv|tv)$/.test(go)) return { type: 'tab', tab: 'tv' };
  if (/^(replay|replays|rattrapage)$/.test(go)) return { type: 'tab', tab: 'replay' };
  if (/^(mes videos|videos|ma liste|my videos|my list)$/.test(go)) return { type: 'tab', tab: 'myvideos' };
  if (/^(parametres|reglages|profil|settings|preferences)$/.test(go)) return { type: 'tab', tab: 'settings' };
  if (/^(recherche|rechercher|search)$/.test(go)) return { type: 'tab', tab: 'search' };

  // ── search ──
  const sm = s.match(/^(recherche|rechercher|cherche|chercher|trouve|trouver|search for|search|find|look for)\s+(.+)$/);
  if (sm) return { type: 'search', query: filler(sm[2]) };

  const verb = /^(mets|met|mettre|lance|lancer|joue|jouer|regarde|regarder|ouvre|ouvrir|passe sur|passe|zappe sur|zappe|va sur|je veux voir|je veux regarder|play|put on|watch|switch to|turn on|open|tune to)\s+/;
  const rest = verb.test(s) ? filler(s.replace(verb, '')) : s;
  const hadVerb = rest !== s;

  // ── explicit kinds ──
  const ch = rest.match(/^(?:chaine|channel)\s+(.+)$/);
  if (ch) {
    const q = ch[1].trim();
    return /^\d+$/.test(q) ? { type: 'channel', query: q, num: parseInt(q, 10) } : { type: 'channel', query: q };
  }
  const mv = rest.match(/^(?:film|movie)\s+(.+)$/);
  if (mv) return { type: 'movie', query: filler(mv[1]) };
  const se = rest.match(/^(?:serie|series|show|tv show)\s+(.+)$/);
  if (se) return { type: 'series', query: filler(se[1]) };

  // "mets France 2", or just "France 2"
  if (rest) return hadVerb || rest.split(' ').length <= 5 ? { type: 'play', query: rest } : { type: 'search', query: rest };
  return { type: 'unknown', text: raw };
}
