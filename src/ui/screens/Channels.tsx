import { useState } from 'react';
import { useApp } from '@/state/store';
import { t, fmtTime, fmtDate } from '@/core/i18n';
import { db } from '@/core/db';
import { programsFor } from '@/core/repo';
import type { Program } from '@/core/types';
import { canCatchup } from '@/core/sources/urls';
import { useAsync, useNow } from '../hooks';
import { LandCard } from '../components/Cards';
import { Img } from '../components/Img';
import { BackButton } from '../components/BackButton';
import { Rail } from '../components/Rail';
import { ProgramSheet } from './Guide';
import { playChannel } from '../actions';
import { IcCalendar, IcPlay, IcRestart } from '../icons';

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
            <Img srcs={[ch.logo, ch.logoAlt]} contain label={ch.name} alt={ch.name} eager />
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
            <LandCard key={p.id ?? p.start} title={p.title} sub={`${fmtTime(p.start)} · ${p.category || ''}`} image={p.icon} centerLogo={[ch.logo, ch.logoAlt]} badge={fmtTime(p.start)} onClick={() => setSel(p)} />
          ))}
        </Rail>
      )}
      {catchup ? (
        [...byDay.entries()].slice(0, 7).map(([day, list]) => (
          <Rail key={day} title={`${t('tv.replay')} · ${day}`}>
            {list.map((p) => (
              <LandCard key={p.id ?? p.start} title={p.title} sub={`${fmtTime(p.start)} – ${fmtTime(p.stop)}`} image={p.icon} centerLogo={[ch.logo, ch.logoAlt]} onClick={() => void playChannel(ch, { program: p, fromStart: true })} onLongPress={() => setSel(p)} />
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
