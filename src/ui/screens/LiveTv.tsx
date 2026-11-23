import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/state/store';
import { t, fmtTime } from '@/core/i18n';
import { favoritesOf, liveChannels, nowNext, tonight, toggleFavorite, type NowNext } from '@/core/repo';
import { db, getMeta, setMeta } from '@/core/db';
import type { Channel, Program, Universe } from '@/core/types';
import { canCatchup } from '@/core/sources/urls';
import { channelVariants } from '@/core/playback';
import { useAsync, useNow, useMediaQuery } from '../hooks';
import { LandCard } from '../components/Cards';
import { VirtualGrid } from '../components/VirtualGrid';
import { Menu, Sheet } from '../components/Overlay';
import { IcCalendar, IcHeart, IcHeartFill, IcPlay, IcRestart, IcHd, IcInfo } from '../icons';
import { openChannel, playChannel } from '../actions';
import { setGuideList } from '../guideList';
import { isTvMode } from '@/core/platform';
import { langPrefs, profileCountry } from '@/core/prefs';
import { matchesLangs, rankChannels } from '@/core/channelRank';
import { flagOf, langName } from '@/core/util/lang';
import { liveEvents, matchEvent, scoreLabel, type LiveEvent } from '@/core/sports';

/**
 * Last list shown per category (first 60 channels with what was on air), saved so a cold start
 * shows the channels at once, before the full catalogue and the guide are read.
 */
interface LiveSnap {
  at: number;
  list: Channel[];
  progs: Record<string, NowNext>;
}
const SNAPS = new Map<string, LiveSnap>();
const snapKey = (pid: string, cat: string, mode: string) => `snapshot:live:${pid}:${cat}:${mode}`;
let lastSave = 0;

/** read at startup, before the heavy catalogue queries, so the tab never waits for them */
export async function preloadLiveSnaps(profileId: string) {
  const rows = await db.meta.where('key').startsWith(`snapshot:live:${profileId}:`).toArray();
  for (const r of rows) if (!SNAPS.has(r.key)) SNAPS.set(r.key, r.value as LiveSnap);
}

const ORDER: Universe[] = ['sport', 'cinema', 'kids', 'news', 'series', 'docs', 'ent', 'music', 'other', 'adult'];
type Cat = 'fav' | 'all' | Universe;

export function LiveTv() {
  const profile = useApp((s) => s.profile)!;
  const settings = useApp((s) => s.settings);
  const unlocked = useApp((s) => s.unlockedAdult);
  const push = useApp((s) => s.push);
  const [mode, setMode] = useState<'now' | 'tonight'>('now');
  const [cat, setCat] = useState<Cat>(() => { const c = sessionStorage.getItem('tv.cat') as Cat | null; return c && c !== 'general' ? c : 'all'; });
  const [menuFor, setMenuFor] = useState<Channel | null>(null);
  const now = useNow(30000);
  const minute = Math.floor(now / 60000);
  const narrow = useMediaQuery('(max-width: 760px)') && !isTvMode();

  // with two audio languages in the profile, the user can narrow the list to one of them
  const [onlyLang, setOnlyLang] = useState<string | null>(() => sessionStorage.getItem('tv.lang'));
  useEffect(() => sessionStorage.setItem('tv.cat', cat), [cat]);
  useEffect(() => {
    if (onlyLang) sessionStorage.setItem('tv.lang', onlyLang);
    else sessionStorage.removeItem('tv.lang');
  }, [onlyLang]);
  const prefs = useMemo(() => langPrefs(profile), [profile]);
  const country = profileCountry(profile);

  const hideAdult = settings.hideAdult && !(profile.parental.enabled && unlocked);
  const channels = useAsync(() => liveChannels(profile.id, { hideAdult }), [profile.id, hideAdult], { key: `live:${profile.id}:${hideAdult}` });
  const favs = useAsync(() => favoritesOf(profile.id, 'live'), [profile.id, menuFor], { key: `favs:live:${profile.id}` });
  const epg = useAsync(() => nowNext(), [minute], { epg: true, key: 'nownext' });
  // live scores (ESPN public scoreboard), refreshed every minute with the programme data
  const scores = useAsync(() => liveEvents(profileCountry(profile)).catch(() => [] as LiveEvent[]), [minute, profile.country], { key: `scores:${profile.country}` });
  const evening = useAsync(() => (mode === 'tonight' ? tonight(settings.tonightStartMin) : Promise.resolve(new Map<string, Program>())), [mode, settings.tonightStartMin], { epg: true });

  const favKeys = useMemo(() => new Set((favs || []).map((f) => f.key.replace(/^live:/, ''))), [favs]);
  // only channels in the user's audio languages (untagged ones included); everything if that leaves too few
  const langChannels = useMemo(() => {
    if (!channels) return undefined;
    const mine = channels.filter((c) => matchesLangs(c, prefs));
    const pick = mine.length >= 5 ? mine : channels;
    // languages of the profile actually present in the catalogue → a choice only when there are two
    const present = prefs.audio.filter((l) => pick.some((c) => c.langs?.includes(l)));
    return { pick, choices: present.length > 1 ? present : [] };
  }, [channels, prefs]);
  const pool = useMemo(() => {
    if (!langChannels) return undefined;
    const l = onlyLang && langChannels.choices.includes(onlyLang) ? onlyLang : null;
    return l ? langChannels.pick.filter((c) => !c.langs?.length || c.langs.includes(l)) : langChannels.pick;
  }, [langChannels, onlyLang]);

  const cats = useMemo(() => {
    const present = new Set((pool || []).map((c) => c.universe));
    return ORDER.filter((u) => present.has(u));
  }, [pool]);

  // ranking only changes when the programme on air changes (EPG map refreshes every minute)
  const ranked = useMemo(() => {
    if (!pool) return undefined;
    const progs = new Map<string, Program | undefined>();
    if (mode === 'tonight' && evening) for (const [k, v] of evening) progs.set(k, v);
    else if (epg) for (const [k, v] of epg) progs.set(k, v.now);
    return rankChannels(pool, { country, prefs, programs: progs, at: mode === 'tonight' && evening ? [...evening.values()][0]?.start : Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, epg, evening, mode, country, prefs]);

  const list = useMemo(() => {
    if (!ranked || !channels) return [];
    let l: Channel[];
    if (cat === 'fav') {
      const order = new Map((favs || []).map((f, i) => [f.key.replace(/^live:/, ''), i]));
      l = channels.filter((c) => favKeys.has(c.groupKey)).sort((a, b) => order.get(a.groupKey)! - order.get(b.groupKey)!);
    } else if (cat === 'all') l = ranked;
    else l = ranked.filter((c) => c.universe === cat);
    if (mode === 'tonight' && evening) l = l.filter((c) => c.epgId && evening.has(c.epgId));
    return l;
  }, [ranked, channels, cat, favs, favKeys, mode, evening]);

  // instant first paint: the saved list of this category until the real one is computed
  const sk = snapKey(profile.id, cat, mode);
  const [snap, setSnap] = useState<LiveSnap | undefined>(() => SNAPS.get(sk));
  useEffect(() => {
    if (SNAPS.has(sk)) return setSnap(SNAPS.get(sk));
    let off = false;
    void getMeta<LiveSnap>(sk).then((s) => {
      if (!off && s) SNAPS.set(sk, s), setSnap(s);
    });
    return () => {
      off = true;
    };
  }, [sk]);
  useEffect(() => {
    if (!ranked || !list.length || !epg || Date.now() - lastSave < 15000) return;
    lastSave = Date.now();
    const top = list.slice(0, 60);
    const progs: Record<string, NowNext> = {};
    for (const c of top) if (c.epgId && epg.get(c.epgId)) progs[c.epgId] = epg.get(c.epgId)!;
    const s: LiveSnap = { at: Date.now(), list: top, progs };
    SNAPS.set(sk, s);
    void setMeta(sk, s).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, epg]);
  const ready = !!ranked && !!epg;
  const shown = ready || !snap?.list.length ? list : snap.list;
  const epgShown = useMemo(() => epg || (snap ? new Map(Object.entries(snap.progs)) : undefined), [epg, snap]);

  const zapList = useMemo(() => list.map((c) => c.id), [list]);

  const label = (c: Cat) => (c === 'fav' ? t('universe.favorites') : c === 'all' ? t('universe.all') : t(`universe.${c}` as 'universe.sport'));

  return (
    <div className="tab-tv">
      <div className="tv-head" data-row data-tabs>
        <div className="tabs">
          {(['now', 'tonight'] as const).map((m) => (
            <button key={m} data-f className={`tab ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
              {m === 'now' ? t('tv.now') : t('tv.tonight')}
            </button>
          ))}
        </div>
        <button className="btn-guide" data-f data-noauto onClick={() => (setGuideList(zapList), push({ name: 'guide' }))}>
          <IcCalendar /> {!narrow && t('tv.guide')}
        </button>
      </div>
      <div className="chips-bar">
        <div className="chips" data-row data-tabs>
          {langChannels?.choices.map((l) => (
            <button key={l} data-f data-noauto className={`chip lang-chip ${onlyLang === l ? 'active' : ''}`} onClick={() => setOnlyLang(onlyLang === l ? null : l)} title={langName(l)}>
              {flagOf(l)} {l.toUpperCase()}
            </button>
          ))}
          {(['fav', 'all', ...cats] as Cat[]).map((c) => (
            <button key={c} data-f className={`chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>
              {label(c)}
            </button>
          ))}
        </div>
      </div>

      <div className="container" style={{ paddingTop: 22 }}>
        {!ranked && !shown.length ? (
          <div className="spinner big" style={{ margin: '60px auto' }} />
        ) : shown.length === 0 ? (
          <div className="empty">{cat === 'fav' ? t('tv.noFav') : mode === 'tonight' ? t('tv.tonightEmpty') : t('tv.noChannels')}</div>
        ) : (
          <VirtualGrid
            className="vgrid"
            items={shown}
            minWidth={narrow ? 150 : 250}
            aspect={16 / 9}
            extraHeight={narrow ? 70 : 78}
            gap={narrow ? 10 : 18}
            getKey={(c) => c.id}
            render={(c) => (
              <ChannelCard
                ch={c}
                event={mode === 'now' && c.epgId ? matchEvent(epgShown?.get(c.epgId)?.now, scores || []) : undefined}
                nn={c.epgId ? nowOf(epgShown?.get(c.epgId), now) : undefined}
                evening={mode === 'tonight' && c.epgId ? evening?.get(c.epgId) : undefined}
                now={now}
                onPlay={(p, fromStart) => void playChannel(c, { program: p, fromStart, zapList })}
                onMenu={() => setMenuFor(c)}
              />
            )}
          />
        )}
      </div>

      {menuFor && (
        <ChannelMenu
          ch={menuFor}
          isFav={favKeys.has(menuFor.groupKey)}
          program={menuFor.epgId ? epg?.get(menuFor.epgId)?.now : undefined}
          onClose={() => setMenuFor(null)}
          zapList={zapList}
        />
      )}
    </div>
  );
}

/** a saved "now" may have ended: then its "next" is on air (or nothing) */
function nowOf(nn: NowNext | undefined, now: number): NowNext | undefined {
  if (!nn) return nn;
  if (nn.now && nn.now.stop > now) return nn;
  return nn.next && nn.next.start <= now && nn.next.stop > now ? { now: nn.next } : undefined;
}

function ChannelCard({ ch, nn, evening, now, onPlay, onMenu, event }: { ch: Channel; nn?: NowNext; evening?: Program; now: number; onPlay: (p?: Program, fromStart?: boolean) => void; onMenu: () => void; event?: LiveEvent }) {
  const p = evening || nn?.now;
  const progress = p && !evening ? (now - p.start) / (p.stop - p.start) : undefined;
  const sub = evening ? `${fmtTime(evening.start)} · ${evening.category || ch.name}` : p ? p.subTitle || p.category || ch.name : t('tv.noProgram');
  return (
    <LandCard
      title={p?.title || ch.name}
      sub={sub}
      image={p?.icon}
      centerLogo={[ch.logoAlt, ch.logo]}
      logo={p?.icon ? [ch.logoAlt, ch.logo] : undefined}
      progress={progress}
      badge={event ? scoreLabel(event) : evening ? fmtTime(evening.start) : undefined}
      badgeLive={event?.state === 'in'}
      onClick={() => onPlay(nn?.now)}
      onLongPress={onMenu}
      action={
        <button className="mini-icon" data-f onClick={onMenu} aria-label="menu" title={t('tv.startOver')}>
          {canCatchup(ch) ? <IcRestart /> : <IcInfo />}
        </button>
      }
    />
  );
}

export function ChannelMenu({ ch, isFav, program, onClose, zapList }: { ch: Channel; isFav: boolean; program?: Program; onClose: () => void; zapList?: string[] }) {
  const profile = useApp((s) => s.profile)!;
  const toast = useApp((s) => s.toast);
  const [variants, setVariants] = useState<Channel[] | null>(null);
  const items = [
    { label: t('channels.watch'), icon: <IcPlay />, onSelect: () => (onClose(), void playChannel(ch, { program, zapList })) },
    ...(canCatchup(ch) && program
      ? [{ label: `${t('tv.startOver')} · ${program.title}`, icon: <IcRestart />, onSelect: () => (onClose(), void playChannel(ch, { program, fromStart: true, zapList })) }]
      : []),
    { label: t('tv.channelGuide'), icon: <IcCalendar />, onSelect: () => (onClose(), openChannel(ch.id)) },
    {
      label: isFav ? t('tv.removeFav') : t('tv.addFav'),
      icon: isFav ? <IcHeartFill /> : <IcHeart />,
      onSelect: async () => {
        const on = await toggleFavorite(profile.id, 'live', ch.groupKey, ch.id);
        toast(on ? t('tv.addFav') : t('tv.removeFav'));
        onClose();
      },
    },
    { label: t('tv.chooseSource'), icon: <IcHd />, onSelect: async () => setVariants(await channelVariants(ch)) },
  ];
  return (
    <Sheet title={ch.name} onClose={onClose}>
      {variants ? (
        <Menu
          items={variants.map((v) => ({
            label: `${v.rawName}${v.quality ? ` · ${v.quality}` : ''}`,
            onSelect: () => (onClose(), void playChannel(v, { program, zapList })),
          }))}
        />
      ) : (
        <Menu items={items} />
      )}
    </Sheet>
  );
}
