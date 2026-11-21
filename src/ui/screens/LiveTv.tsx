import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/state/store';
import { t, fmtTime } from '@/core/i18n';
import { favoritesOf, liveChannels, nowNext, tonight, toggleFavorite, type NowNext } from '@/core/repo';
import type { Channel, Program, Universe } from '@/core/types';
import { canCatchup } from '@/core/sources/urls';
import { channelVariants } from '@/core/playback';
import { useAsync, useNow, useMediaQuery } from '../hooks';
import { LandCard } from '../components/Cards';
import { VirtualGrid } from '../components/VirtualGrid';
import { Menu, Sheet } from '../components/Overlay';
import { IcCalendar, IcHeart, IcHeartFill, IcPlay, IcRestart, IcHd, IcInfo } from '../icons';
import { openChannel, playChannel } from '../actions';
import { isTvMode } from '@/core/platform';

const ORDER: Universe[] = ['general', 'sport', 'cinema', 'kids', 'news', 'series', 'docs', 'ent', 'music', 'other', 'adult'];
type Cat = 'fav' | 'all' | Universe;

export function LiveTv() {
  const profile = useApp((s) => s.profile)!;
  const settings = useApp((s) => s.settings);
  const unlocked = useApp((s) => s.unlockedAdult);
  const push = useApp((s) => s.push);
  const [mode, setMode] = useState<'now' | 'tonight'>('now');
  const [cat, setCat] = useState<Cat>(() => (sessionStorage.getItem('tv.cat') as Cat) || 'all');
  const [menuFor, setMenuFor] = useState<Channel | null>(null);
  const now = useNow(30000);
  const minute = Math.floor(now / 60000);
  const narrow = useMediaQuery('(max-width: 760px)') && !isTvMode();

  useEffect(() => sessionStorage.setItem('tv.cat', cat), [cat]);

  const hideAdult = settings.hideAdult && !(profile.parental.enabled && unlocked);
  const channels = useAsync(() => liveChannels(profile.id, { hideAdult }), [profile.id, hideAdult]);
  const favs = useAsync(() => favoritesOf(profile.id, 'live'), [profile.id, menuFor]);
  const epg = useAsync(() => nowNext(), [minute], { epg: true });
  const evening = useAsync(() => (mode === 'tonight' ? tonight(settings.tonightStartMin) : Promise.resolve(new Map<string, Program>())), [mode, settings.tonightStartMin], { epg: true });

  const favKeys = useMemo(() => new Set((favs || []).map((f) => f.key.replace(/^live:/, ''))), [favs]);
  const cats = useMemo(() => {
    const present = new Set((channels || []).map((c) => c.universe));
    return ORDER.filter((u) => present.has(u));
  }, [channels]);

  const list = useMemo(() => {
    if (!channels) return [];
    let l: Channel[];
    if (cat === 'fav') {
      const order = new Map((favs || []).map((f, i) => [f.key.replace(/^live:/, ''), i]));
      l = channels.filter((c) => favKeys.has(c.groupKey)).sort((a, b) => order.get(a.groupKey)! - order.get(b.groupKey)!);
    } else if (cat === 'all') l = channels;
    else l = channels.filter((c) => c.universe === cat);
    if (mode === 'tonight' && evening) l = l.filter((c) => c.epgId && evening.has(c.epgId));
    return l;
  }, [channels, cat, favs, favKeys, mode, evening]);

  const zapList = useMemo(() => list.map((c) => c.id), [list]);

  const label = (c: Cat) => (c === 'fav' ? t('universe.favorites') : c === 'all' ? t('universe.all') : t(`universe.${c}` as 'universe.sport'));

  return (
    <div className="tab-tv">
      <div className="tv-head">
        <div className="tabs" data-row>
          {(['now', 'tonight'] as const).map((m) => (
            <button key={m} data-f className={`tab ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
              {m === 'now' ? t('tv.now') : t('tv.tonight')}
            </button>
          ))}
        </div>
        <button className="btn-guide" data-f onClick={() => push({ name: 'guide' })}>
          <IcCalendar /> {!narrow && t('tv.guide')}
        </button>
      </div>
      <div className="chips-bar">
        <div className="chips" data-row>
          {(['fav', 'all', ...cats] as Cat[]).map((c) => (
            <button key={c} data-f className={`chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>
              {label(c)}
            </button>
          ))}
        </div>
      </div>

      <div className="container" style={{ paddingTop: 22 }}>
        {!channels ? (
          <div className="spinner big" style={{ margin: '60px auto' }} />
        ) : list.length === 0 ? (
          <div className="empty">{cat === 'fav' ? t('tv.noFav') : mode === 'tonight' ? t('tv.tonightEmpty') : t('tv.noChannels')}</div>
        ) : (
          <VirtualGrid
            className="vgrid"
            items={list}
            minWidth={narrow ? 150 : 250}
            aspect={16 / 9}
            extraHeight={narrow ? 70 : 78}
            gap={narrow ? 10 : 18}
            getKey={(c) => c.id}
            render={(c) => (
              <ChannelCard
                ch={c}
                nn={c.epgId ? epg?.get(c.epgId) : undefined}
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

function ChannelCard({ ch, nn, evening, now, onPlay, onMenu }: { ch: Channel; nn?: NowNext; evening?: Program; now: number; onPlay: (p?: Program, fromStart?: boolean) => void; onMenu: () => void }) {
  const p = evening || nn?.now;
  const progress = p && !evening ? (now - p.start) / (p.stop - p.start) : undefined;
  const sub = evening ? `${fmtTime(evening.start)} · ${evening.category || ch.name}` : p ? p.subTitle || p.category || ch.name : t('tv.noProgram');
  return (
    <LandCard
      title={p?.title || ch.name}
      sub={sub}
      image={p?.icon}
      centerLogo={ch.logo || ''}
      logo={p?.icon ? ch.logo : undefined}
      progress={progress}
      badge={evening ? fmtTime(evening.start) : undefined}
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
