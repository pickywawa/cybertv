import { useMemo, useState } from 'react';
import { useApp } from '@/state/store';
import { t, fmtTime, fmtDate } from '@/core/i18n';
import { db } from '@/core/db';
import { favoritesOf, liveChannels, programsFor } from '@/core/repo';
import type { Channel, Program, Universe } from '@/core/types';
import { canCatchup } from '@/core/sources/urls';
import { useAsync, useNow } from '../hooks';
import { LogoTile, LandCard } from '../components/Cards';
import { Img } from '../components/Img';
import { BackButton } from '../components/BackButton';
import { Rail } from '../components/Rail';
import { ChannelMenu } from './LiveTv';
import { ProgramSheet } from './Guide';
import { openChannel, playChannel } from '../actions';
import { IcCalendar, IcPlay, IcRestart } from '../icons';

const ORDER: Universe[] = ['general', 'news', 'sport', 'cinema', 'series', 'kids', 'docs', 'ent', 'music', 'other', 'adult'];

export function Channels() {
  const profile = useApp((s) => s.profile)!;
  const settings = useApp((s) => s.settings);
  const [menu, setMenu] = useState<Channel | null>(null);
  const channels = useAsync(() => liveChannels(profile.id, { hideAdult: settings.hideAdult }), [profile.id], { key: `live:${profile.id}:${settings.hideAdult}` });
  const favs = useAsync(() => favoritesOf(profile.id, 'live'), [profile.id, menu], { key: `favs:live:${profile.id}` });
  const groups = useMemo(() => {
    const m = new Map<Universe, Channel[]>();
    for (const c of channels || []) (m.get(c.universe) || m.set(c.universe, []).get(c.universe)!).push(c);
    return ORDER.filter((u) => m.has(u)).map((u) => [u, m.get(u)!] as const);
  }, [channels]);
  const favSet = new Set((favs || []).map((f) => f.key.replace(/^live:/, '')));

  if (!channels) return <div className="spinner big" style={{ margin: '120px auto' }} />;
  return (
    <div className="tab-channels">
      <h1 className="container tab-h1" style={{ fontSize: '2rem', fontWeight: 700, marginBottom: 8 }}>{t('channels.title')}</h1>
      {favSet.size > 0 && (
        <Rail title={t('universe.favorites')}>
          {channels.filter((c) => favSet.has(c.groupKey)).map((c) => (
            <LogoTile key={c.id} name={c.name} logo={c.logo} onClick={() => openChannel(c.id)} onLongPress={() => setMenu(c)} />
          ))}
        </Rail>
      )}
      {groups.map(([u, list]) => (
        <section key={u} className="rail">
          <div className="rail-head">
            <h2 className="section-title">{t(`universe.${u}` as 'universe.sport')}</h2>
            <span className="dim small">{list.length}</span>
          </div>
          <div className="grid logos">
            {list.map((c) => (
              <LogoTile key={c.id} name={c.name} logo={c.logo} onClick={() => openChannel(c.id)} onLongPress={() => setMenu(c)} />
            ))}
          </div>
        </section>
      ))}
      {channels.length === 0 && <div className="empty">{t('tv.noChannels')}</div>}
      {menu && <ChannelMenu ch={menu} isFav={favSet.has(menu.groupKey)} onClose={() => setMenu(null)} />}
    </div>
  );
}

export function ChannelPage({ id }: { id: string }) {
  const push = useApp((s) => s.push);
  const now = useNow(60000);
  const [sel, setSel] = useState<Program | null>(null);
  const ch = useAsync(() => db.channels.get(id), [id]);
  const progs = useAsync(
    async () => (ch?.epgId ? programsFor(ch.epgId, Date.now() - Math.min(7, Math.max(1, ch.catchupDays)) * 86400000, Date.now() + 2 * 86400000) : []),
    [ch, Math.floor(now / 60000)],
    { epg: true },
  );
  if (!ch) return null;
  const cur = progs?.find((p) => p.start <= now && p.stop > now);
  const upcoming = (progs || []).filter((p) => p.start > now).slice(0, 12);
  const past = (progs || []).filter((p) => p.stop <= now).reverse();
  const catchup = canCatchup(ch);
  // group replay by day
  const byDay = new Map<string, Program[]>();
  for (const p of past) {
    const k = fmtDate(p.start, { weekday: 'long', day: 'numeric', month: 'long' });
    (byDay.get(k) || byDay.set(k, []).get(k)!).push(p);
  }

  return (
    <div style={{ paddingBottom: 40 }}>
      <BackButton />
      <section className="detail-hero" style={{ minHeight: 'min(56vh, 40vw)' }}>
        <div className="bg">
          <Img srcs={[cur?.icon]} label={ch.name} />
        </div>
        <div className="content">
          <div style={{ height: 70, marginBottom: 16, maxWidth: 220, position: 'relative' }}>
            <Img srcs={[ch.logo]} contain label={ch.name} alt={ch.name} eager />
          </div>
          <div className="muted small">{t('channels.liveNow')}</div>
          <h1 style={{ fontSize: 'clamp(1.6rem,3vw,2.6rem)', margin: '6px 0' }}>{cur?.title || ch.name}</h1>
          {cur && (
            <div className="facts">
              <span>{fmtTime(cur.start)} – {fmtTime(cur.stop)}</span>
              {cur.category && <span>{cur.category}</span>}
              <span>{t('tv.remaining', { n: Math.max(1, Math.round((cur.stop - now) / 60000)) })}</span>
            </div>
          )}
          {cur?.desc && <p className="clamp3 muted">{cur.desc}</p>}
          <div className="btn-row" data-row style={{ marginTop: 18 }}>
            <button className="btn primary" data-f data-autofocus onClick={() => void playChannel(ch, { program: cur })}>
              <IcPlay /> {t('channels.watch')}
            </button>
            {catchup && cur && (
              <button className="btn" data-f onClick={() => void playChannel(ch, { program: cur, fromStart: true })}>
                <IcRestart /> {t('tv.startOver')}
              </button>
            )}
            <button className="btn" data-f onClick={() => push({ name: 'guide', channelId: ch.id })}>
              <IcCalendar /> {t('tv.guide')}
            </button>
          </div>
        </div>
      </section>

      {upcoming.length > 0 && (
        <Rail title={t('channels.upNext')}>
          {upcoming.map((p) => (
            <LandCard key={p.id ?? p.start} title={p.title} sub={`${fmtTime(p.start)} · ${p.category || ''}`} image={p.icon} centerLogo={ch.logo || ''} badge={fmtTime(p.start)} onClick={() => setSel(p)} />
          ))}
        </Rail>
      )}
      {catchup ? (
        [...byDay.entries()].slice(0, 7).map(([day, list]) => (
          <Rail key={day} title={`${t('tv.replay')} · ${day}`}>
            {list.map((p) => (
              <LandCard key={p.id ?? p.start} title={p.title} sub={`${fmtTime(p.start)} – ${fmtTime(p.stop)}`} image={p.icon} centerLogo={ch.logo || ''} onClick={() => void playChannel(ch, { program: p, fromStart: true })} onLongPress={() => setSel(p)} />
            ))}
          </Rail>
        ))
      ) : (
        <p className="container muted" style={{ marginTop: 30 }}>{t('channels.noReplay')}</p>
      )}
      {sel && <ProgramSheet ch={ch} p={sel} onClose={() => setSel(null)} />}
    </div>
  );
}
