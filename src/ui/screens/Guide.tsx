import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useApp } from '@/state/store';
import { t, fmtTime, fmtDate } from '@/core/i18n';
import { liveChannels, programsInRange } from '@/core/repo';
import type { Channel, Program } from '@/core/types';
import { canCatchup } from '@/core/sources/urls';
import { useAsync, useNow } from '../hooks';
import { Img } from '../components/Img';
import { BackButton } from '../components/BackButton';
import { Sheet } from '../components/Overlay';
import { playChannel } from '../actions';
import { focusEl } from '../spatial';
import { IcPlay, IcRestart } from '../icons';
import { langPrefs, profileCountry } from '@/core/prefs';
import { matchesLangs, rankChannels } from '@/core/channelRank';

const ROW_H = 64;
const CH_W = 120;
const PX_PER_MIN = 4.2;

export function Guide({ channelId }: { channelId?: string }) {
  const profile = useApp((s) => s.profile)!;
  const settings = useApp((s) => s.settings);
  const now = useNow(60000);
  const [dayOffset, setDayOffset] = useState(0);
  const [selected, setSelected] = useState<{ ch: Channel; p: Program } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const day0 = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime() + dayOffset * 86400000;
  }, [dayOffset]);
  const dayEnd = day0 + 86400000 + 3 * 3600000;

  const channels = useAsync(() => liveChannels(profile.id, { hideAdult: settings.hideAdult }), [profile.id], { key: `live:${profile.id}:${settings.hideAdult}` });
  const progs = useAsync(() => programsInRange(day0, dayEnd), [day0], { epg: true, key: `guide:${day0}` });
  // same order as the TV tab (national ranking × user languages), without the "on air" boost so rows don't move
  const rows = useMemo(() => {
    const prefs = langPrefs(profile);
    const withEpg = (channels || []).filter((c) => c.epgId && progs?.has(c.epgId));
    const mine = withEpg.filter((c) => matchesLangs(c, prefs));
    return rankChannels(mine.length >= 5 ? mine : withEpg, { country: profileCountry(profile), prefs });
  }, [channels, progs, profile]);
  const totalW = CH_W + ((dayEnd - day0) / 60000) * PX_PER_MIN;
  const x = (ts: number) => CH_W + ((ts - day0) / 60000) * PX_PER_MIN;

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => bodyRef.current, estimateSize: () => ROW_H, overscan: 6, paddingStart: 34 });

  // scroll to "now" (or the requested channel) once
  const did = useRef(false);
  useLayoutEffect(() => {
    if (did.current || !rows.length || !bodyRef.current) return;
    did.current = true;
    bodyRef.current.scrollLeft = Math.max(0, x(Date.now()) - CH_W - 120);
    if (channelId) {
      const i = rows.findIndex((r) => r.id === channelId);
      if (i > 0) v.scrollToIndex(i, { align: 'center' });
    }
    requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>('.guide-prog.now');
      focusEl(el, false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  useEffect(() => {
    if (dayOffset !== 0 && bodyRef.current) bodyRef.current.scrollLeft = x(day0 + 18 * 3600000) - CH_W - 60;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayOffset]);

  const hours = [];
  for (let h = day0; h < dayEnd; h += 1800000) hours.push(h);
  const days = [-2, -1, 0, 1, 2];
  const dayLabel = (o: number) => (o === 0 ? t('tv.today') : o === -1 ? t('tv.yesterday') : o === 1 ? t('tv.tomorrow') : fmtDate(day0 + (o - dayOffset) * 86400000, { weekday: 'long', day: 'numeric' }));

  return (
    <div className="guide">
      <div className="guide-top">
        <BackButton floating={false} />
        <h1 className="section-title">{t('tv.guide')}</h1>
        <div className="guide-days chips" data-row style={{ padding: 0 }}>
          {days.map((o) => (
            <button
              key={o}
              data-f
              className={`chip ${dayOffset === o ? 'active' : ''}`}
              onClick={() => setDayOffset(o)}
              // start the day strip on the selected day (today) rather than on past days
              ref={dayOffset === o ? (el) => el?.scrollIntoView({ inline: 'center', block: 'nearest' }) : undefined}
            >
              {dayLabel(o)}
            </button>
          ))}
        </div>
      </div>
      <div className="guide-body" ref={bodyRef}>
        {!channels || !progs ? (
          <div className="spinner big" style={{ margin: '60px auto' }} />
        ) : rows.length === 0 ? (
          <div className="empty">{t('tv.noProgram')}</div>
        ) : (
          <div style={{ position: 'relative', width: totalW, height: v.getTotalSize() }}>
            <div className="guide-timebar" style={{ width: totalW }}>
              {hours.map((h) => (
                <span key={h} className="guide-time" style={{ left: x(h) }}>
                  {fmtTime(h)}
                </span>
              ))}
            </div>
            {now >= day0 && now < dayEnd && <div className="guide-now" style={{ left: x(now) }} />}
            {v.getVirtualItems().map((r) => {
              const ch = rows[r.index];
              const list = progs.get(ch.epgId!) || [];
              return (
                <div key={ch.id} className="guide-row" data-row style={{ top: r.start, width: totalW }}>
                  <div className="guide-ch" title={ch.name}>
                    <Img srcs={[ch.logo, ch.logoAlt]} contain label={ch.name} alt={ch.name} />
                  </div>
                  {list.map((p) => {
                    const l = Math.max(CH_W, x(p.start));
                    const w = Math.max(24, x(Math.min(p.stop, dayEnd)) - l - 3);
                    if (x(p.stop) < CH_W) return null;
                    const isNow = p.start <= now && p.stop > now;
                    const past = p.stop <= now;
                    return (
                      <button
                        key={p.id ?? p.start}
                        data-f
                        className={`guide-prog ${isNow ? 'now' : ''} ${past ? 'past' : ''} ${past && canCatchup(ch) ? 'replay' : ''}`}
                        style={{ left: l, width: w }}
                        onClick={() => setSelected({ ch, p })}
                      >
                        <div className="t ellipsis">{p.title}</div>
                        <div className="h ellipsis">{fmtTime(p.start)} – {fmtTime(p.stop)}</div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {selected && <ProgramSheet ch={selected.ch} p={selected.p} onClose={() => setSelected(null)} />}
    </div>
  );
}

export function ProgramSheet({ ch, p, onClose }: { ch: Channel; p: Program; onClose: () => void }) {
  const now = Date.now();
  const isNow = p.start <= now && p.stop > now;
  const past = p.stop <= now;
  const replay = canCatchup(ch) && (past || isNow) && p.start > now - ch.catchupDays * 86400000;
  return (
    <Sheet title={p.title} onClose={onClose}>
      {p.icon && (
        <div style={{ borderRadius: 10, overflow: 'hidden', aspectRatio: '16/9', position: 'relative', marginBottom: 12, background: 'var(--surface)' }}>
          <Img srcs={[p.icon]} label={p.title} />
        </div>
      )}
      <div className="muted small" style={{ marginBottom: 8 }}>
        {ch.name} · {fmtDate(p.start, { weekday: 'long', day: 'numeric', month: 'long' })} · {fmtTime(p.start)} – {fmtTime(p.stop)}
        {p.category ? ` · ${p.category}` : ''}
      </div>
      {p.subTitle && <div style={{ fontWeight: 600, marginBottom: 6 }}>{p.subTitle}</div>}
      <p style={{ lineHeight: 1.5 }}>{p.desc || t('tv.noProgram')}</p>
      <div className="btn-row" style={{ marginTop: 14 }}>
        {isNow && (
          <button className="btn primary" data-f data-autofocus onClick={() => (onClose(), void playChannel(ch, { program: p }))}>
            <IcPlay /> {t('tv.live')}
          </button>
        )}
        {replay && (
          <button className="btn" data-f data-autofocus={!isNow || undefined} onClick={() => (onClose(), void playChannel(ch, { program: p, fromStart: true }))}>
            <IcRestart /> {isNow ? t('tv.startOver') : t('tv.replay')}
          </button>
        )}
        <button className="btn ghost" data-f onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </Sheet>
  );
}
