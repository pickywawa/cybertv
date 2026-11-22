import { useApp, type TabId } from '@/state/store';
import { db } from '@/core/db';
import { searchWorker } from '@/core/workers';
import { getProgress } from '@/core/repo';
import { norm } from '@/core/util/text';
import { t } from '@/core/i18n';
import type { Channel } from '@/core/types';
import { parseVoice, type PlayerAction, type VoiceIntent } from '@/core/voice/parse';
import { openSeries, playChannel, playMovie } from '../actions';

/** what the bubble shows once a command ran */
export interface VoiceOutcome {
  heard: string;
  done: string | null;
}

let pendingSearch: string | null = null;
/** the Search screen picks it up when it opens (or right away through the event) */
export function takePendingSearch(): string | null {
  const q = pendingSearch;
  pendingSearch = null;
  return q;
}

const compact = (s: string) => norm(s).replace(/\s+/g, '');

async function hits(query: string) {
  const st = useApp.getState();
  if (!st.profile) return [];
  return searchWorker().search(st.profile.id, st.catalogVersion, query);
}

/** "canal plus" / "Canal+": names written with a "+" first (the + is lost when normalising) */
function plusWord(raw: string): string | null {
  const m = norm(raw.replace(/\+/g, ' plus ')).match(/\b([a-z0-9]+) plus\b/);
  return m ? m[1] : null;
}

function pickLive<T extends { kind: string; title: string }>(list: T[], query: string, raw: string): T | undefined {
  const live = list.filter((h) => h.kind === 'live');
  const word = plusWord(raw);
  if (word) {
    const re = new RegExp(`\\b${word}\\s*\\+`, 'i');
    const plus = live.filter((h) => re.test(h.title)).sort((a, b) => a.title.length - b.title.length);
    if (plus.length) return plus[0];
  }
  const want = compact(query);
  return live.find((h) => compact(h.title) === want);
}

async function findChannel(query: string, raw: string, num?: number): Promise<Channel | null> {
  const pid = useApp.getState().profile?.id;
  if (!pid) return null;
  if (num !== undefined) {
    const byNum = await db.channels.where('profileId').equals(pid).filter((c) => c.num === num).first();
    if (byNum) return byNum;
  }
  const live = (await hits(query)).filter((h) => h.kind === 'live');
  if (!live.length) return null;
  const exact = pickLive(live, query, raw);
  return (await db.channels.get((exact || live[0]).id)) || null;
}

function closeOverlays() {
  const st = useApp.getState();
  if (st.player) st.play(null);
  st.resetStack();
}

async function playMovieResume(id: string) {
  const pid = useApp.getState().profile?.id;
  const w = pid ? await getProgress(pid, `movie:${id}`) : undefined;
  await playMovie(id, w && !w.completed && w.positionSec > 30 ? w.positionSec : undefined);
}

/** runs one intent; the label of what was done, or null when nothing matched */
async function run(intent: VoiceIntent, raw: string): Promise<string | null> {
  const st = useApp.getState();
  switch (intent.type) {
    case 'tab': {
      closeOverlays();
      st.setTab(intent.tab as TabId);
      const label: Record<string, string> = { home: 'nav.home', tv: 'nav.tv', replay: 'nav.replay', myvideos: 'nav.myvideos', settings: 'nav.settings', search: 'nav.search' };
      return t(label[intent.tab] as 'nav.home');
    }
    case 'search': {
      closeOverlays();
      pendingSearch = intent.query;
      st.setTab('search');
      window.dispatchEvent(new CustomEvent('cyber:voice-search'));
      return `${t('nav.search')} · ${intent.query}`;
    }
    case 'player': {
      if (!st.player) return null;
      window.dispatchEvent(new CustomEvent<{ action: PlayerAction; seconds?: number }>('cyber:voice-player', { detail: { action: intent.action, seconds: intent.seconds } }));
      return t(`voice.player.${intent.action}` as 'voice.player.pause', { n: intent.seconds ?? 0 });
    }
    case 'channel': {
      const ch = await findChannel(intent.query, raw, intent.num);
      if (!ch) return null;
      st.resetStack();
      await playChannel(ch);
      return ch.name;
    }
    case 'movie':
    case 'series': {
      const h = (await hits(intent.query)).find((x) => x.kind === intent.type);
      if (!h) return null;
      if (h.kind === 'movie') {
        if (st.player) st.play(null);
        await playMovieResume(h.id);
      } else {
        closeOverlays();
        openSeries(h.id);
      }
      return h.title;
    }
    case 'play': {
      // a channel named exactly like this first ("TF1", "France 2"), then the best title
      const all = await hits(intent.query);
      if (!all.length) return null;
      const h = pickLive(all, intent.query, raw) || all[0];
      if (h.kind === 'live') {
        const ch = await db.channels.get(h.id);
        if (!ch) return null;
        st.resetStack();
        await playChannel(ch);
        return ch.name;
      }
      if (h.kind === 'movie') {
        if (st.player) st.play(null);
        await playMovieResume(h.id);
      } else {
        closeOverlays();
        openSeries(h.id);
      }
      return h.title;
    }
    default:
      return null;
  }
}

/**
 * Every transcript the recognizer proposed is tried in turn (the second guess is often the right
 * channel name); nothing found: the first one goes to the search screen.
 */
export async function runVoice(texts: string[]): Promise<VoiceOutcome> {
  const list = texts.map((x) => x.trim()).filter(Boolean);
  if (!list.length) return { heard: '', done: null };
  const inPlayer = !!useApp.getState().player;
  for (const text of list) {
    const intent = parseVoice(text, { inPlayer });
    if (intent.type === 'unknown') continue;
    try {
      const done = await run(intent, text);
      if (done) return { heard: text, done };
    } catch (e) {
      console.warn('[voice]', e);
    }
  }
  const first = parseVoice(list[0], { inPlayer });
  const query = first.type === 'play' || first.type === 'channel' || first.type === 'movie' || first.type === 'series' || first.type === 'search' ? first.query : list[0];
  const done = await run({ type: 'search', query }, list[0]);
  return { heard: list[0], done };
}
