import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/state/store';
import { t, fmtDate, fmtDuration } from '@/core/i18n';
import { db, getMeta, setMeta } from '@/core/db';
import { continueWatching, getProgress } from '@/core/repo';
import type { Channel, WatchState } from '@/core/types';
import { OFFICIAL_LIVE, officialFor, replayCatalog, replayInfo, replayShow, type OfficialLive, type ReplayCatalog, type ReplayItem, type ReplayProvider, type ReplayShow } from '@/core/replay';
import { useAsync } from '../hooks';
import { profileCountry } from '@/core/prefs';
import { Rail } from '../components/Rail';
import { LandCard, LogoTile } from '../components/Cards';
import { Img } from '../components/Img';
import { BackButton } from '../components/BackButton';
import { openReplay, playChannel, playOfficial, playReplay, resume } from '../actions';
import { IcInfo, IcPlay, IcRefresh, IcRestart } from '../icons';

const MEM = new Map<string, ReplayCatalog>();
const LIVE_SNAP = new Map<string, Map<string, Channel>>();
const PROVIDER_LABEL: Record<ReplayProvider, string> = { arte: 'ARTE', francetv: 'france.tv', youtube: 'YouTube' };
type Filter = 'all' | ReplayProvider | 'kids';

function lastDays(it: ReplayItem): number | null {
  if (!it.expires) return null;
  const d = Math.ceil((it.expires - Date.now()) / 86400000);
  return d > 0 && d <= 3 ? d : null;
}

/** "il y a 3 h" for YouTube videos */
function ago(ts?: number): string | undefined {
  if (!ts) return undefined;
  const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return t('yt.ago.m', { n: m });
  if (m < 48 * 60) return t('yt.ago.h', { n: Math.round(m / 60) });
  return t('yt.ago.d', { n: Math.round(m / 1440) });
}

function cardProps(it: ReplayItem) {
  const days = lastDays(it);
  if (it.provider === 'youtube') return { title: it.title, sub: it.channel, sub2: ago(it.published), image: it.image, badge: undefined as string | undefined };
  return {
    title: it.title,
    sub: it.subtitle || it.channel,
    sub2: it.durationSec ? fmtDuration(it.durationSec) : it.kind === 'show' ? t('replay.show') : undefined,
    image: it.image,
    badge: days ? t('replay.lastDays', { n: days }) : undefined,
  };
}

export function Replay() {
  const profile = useApp((s) => s.profile)!;
  const lang = profile.lang;
  const country = profileCountry(profile);
  const memKey = `${lang}:${country}`;
  const [cat, setCat] = useState<ReplayCatalog | null | undefined>(() => MEM.get(memKey));
  const [filter, setFilter] = useState<Filter>('all');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let off = false;
    // the saved copy shows at once, the network refreshes it when it is old
    if (!MEM.has(memKey)) void replayCatalog(lang, { cachedOnly: true, country }).then((c) => !off && c && setCat((x) => x ?? c));
    replayCatalog(lang, { force: reload > 0, country }).then(
      (c) => {
        if (off || !c) return;
        MEM.set(memKey, c);
        setCat(c);
      },
      () => !off && setCat((x) => x ?? null),
    );
    return () => {
      off = true;
    };
  }, [lang, country, memKey, reload]);

  const cont = useAsync(async () => (await continueWatching(profile.id)).filter((w) => w.kind === 'replay'), [profile.id], { key: `replay:cont:${profile.id}` });
  const rails = useMemo(() => {
    if (!cat) return [];
    if (filter === 'kids') return cat.kids || [];
    const yt = cat.youtube || [];
    if (filter === 'youtube') return yt;
    const list = cat.rails.filter((r) => filter === 'all' || r.provider === filter);
    if (filter !== 'all') return list;
    // "All": broadcasters' replay, a taste of the youth catalogue, YouTube themes woven in
    const out = [...list.slice(0, 4)];
    const rest = [...list.slice(4, 6), ...(cat.kids || []).slice(0, 1), ...list.slice(6)];
    for (let i = 0; i < Math.max(rest.length, yt.length); i++) {
      if (yt[i]) out.push(yt[i]);
      out.push(...rest.slice(i * 3, i * 3 + 3));
    }
    return out;
  }, [cat, filter]);
  const hero = useMemo(
    () => (filter === 'kids' ? cat?.kidsHero || [] : filter === 'youtube' ? [] : (cat?.hero || []).filter((h) => filter === 'all' || h.provider === filter)),
    [cat, filter],
  );

  return (
    <div className="tab-replay">
      {hero.length > 0 ? (
        <ReplayHero items={hero} />
      ) : cat === undefined && filter !== 'youtube' ? (
        // same height as the banner while the catalogue loads: nothing jumps when it arrives
        <section className="hero hero-skeleton" aria-hidden />
      ) : (
        <div className="hero-spacer" />
      )}
      <div className="chips" data-row data-tabs>
        {(['all', 'arte', 'francetv', 'youtube', 'kids'] as Filter[]).map((f) => (
          <button key={f} data-f className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? t('replay.all') : f === 'kids' ? t('replay.kids') : PROVIDER_LABEL[f]}
          </button>
        ))}
      </div>
      {(filter === 'all' || filter === 'francetv') && <LiveRail />}
      {!!cont?.length && (
        <Rail title={t('home.continue')}>
          {cont.map((w: WatchState) => (
            <LandCard key={w.key} title={w.title} sub={w.subtitle} image={w.image} progress={w.positionSec / Math.max(1, w.durationSec)} progressLight sub2={fmtDuration(Math.max(0, w.durationSec - w.positionSec))} onClick={() => void resume(w)} />
          ))}
        </Rail>
      )}
      {cat === undefined && <div className="spinner big" style={{ margin: '80px auto' }} />}
      {cat === null && (
        <div className="empty">
          <p>{t('replay.error')}</p>
          <button className="btn" data-f onClick={() => setReload((n) => n + 1)}>
            <IcRefresh /> {t('replay.retry')}
          </button>
        </div>
      )}
      {cat?.failed.map((p) => (filter === 'all' || filter === p || (filter === 'kids' && p === 'francetv')) && (
        <p key={p} className="container muted small">{t('replay.providerDown', { name: PROVIDER_LABEL[p] })}</p>
      ))}
      {rails.map((r) => (
        <Rail key={r.id} title={<><span className={`rp-prov ${r.kids ? 'okoo' : r.provider}`}>{r.kids ? 'Okoo' : PROVIDER_LABEL[r.provider]}</span>{r.title}</>}>
          {r.items.map((it) => (
            <LandCard key={it.id} {...cardProps(it)} onClick={() => openReplay(it)} />
          ))}
        </Rail>
      ))}
      {cat && <p className="container dim small" style={{ margin: '28px 0 40px' }}>{t('replay.footer')}</p>}
    </div>
  );
}

/** official free live streams; the user's own channel (with its guide) when a source carries it */
function LiveRail() {
  const profile = useApp((s) => s.profile)!;
  // the user's own versions of these channels (logos, guide); saved so their logos show at once
  const snapKey = `snapshot:replaylive:${profile.id}`;
  const [saved, setSaved] = useState<Map<string, Channel> | undefined>(() => LIVE_SNAP.get(snapKey));
  useEffect(() => {
    if (LIVE_SNAP.has(snapKey)) return;
    void getMeta<[string, Channel][]>(snapKey).then((rows) => {
      if (!rows) return;
      const m = new Map(rows);
      LIVE_SNAP.set(snapKey, m);
      setSaved((x) => x || m);
    });
  }, [snapKey]);
  const fresh = useAsync(async () => {
    const keys = OFFICIAL_LIVE.flatMap((o) => o.keys);
    const rows = (await db.channels.where('groupKey').anyOf(keys).toArray()).filter((c) => c.profileId === profile.id);
    const out = new Map<string, Channel>();
    for (const c of rows) {
      const o = officialFor(c);
      if (o && !out.has(o.key)) out.set(o.key, c);
    }
    LIVE_SNAP.set(snapKey, out);
    void setMeta(snapKey, [...out.entries()]).catch(() => {});
    return out;
  }, [profile.id], { key: `replay:live:${profile.id}` });
  const matches = fresh || saved;
  const play = (o: OfficialLive) => {
    const ch = matches?.get(o.key);
    void (ch ? playChannel(ch) : playOfficial(o));
  };
  return (
    <Rail title={t('replay.live')}>
      {OFFICIAL_LIVE.map((o) => {
        const ch = matches?.get(o.key);
        return <LogoTile key={o.key} name={o.name} logo={ch ? [ch.logoAlt, ch.logo] : undefined} onClick={() => play(o)} />;
      })}
    </Rail>
  );
}

function ReplayHero({ items }: { items: ReplayItem[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || items.length < 2) return;
    const tm = setInterval(() => setI((x) => (x + 1) % items.length), 8000);
    return () => clearInterval(tm);
  }, [items.length, paused]);
  const it = items[Math.min(i, items.length - 1)];
  return (
    <section className="hero" onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className="bg">
        <Img srcs={[it.image?.replace('940x530', '1280x720')]} eager label={it.title} />
      </div>
      <div className="content">
        <span className={`rp-prov ${it.provider}`}>{it.channel || PROVIDER_LABEL[it.provider]}</span>
        <h1>{it.title}</h1>
        <div className="facts">
          {it.subtitle && <span>{it.subtitle}</span>}
          {it.genre && <span>{it.genre}</span>}
          {it.durationSec ? <span>{fmtDuration(it.durationSec)}</span> : null}
        </div>
        {it.desc && <p className="clamp3">{it.desc}</p>}
        <div className="btn-row" data-row>
          <button className="btn primary" data-f data-autofocus onClick={() => (it.kind === 'video' ? void playReplay(it) : openReplay(it))}>
            <IcPlay /> {t('home.play')}
          </button>
          <button className="btn" data-f onClick={() => openReplay(it)}>
            <IcInfo /> {t('home.info')}
          </button>
        </div>
      </div>
      <div className="dots">
        {items.map((_, k) => (
          <i key={k} className={k === i ? 'on' : ''} />
        ))}
      </div>
    </section>
  );
}

/** a replay video (play / resume) or a show (its seasons and episodes) */
export function ReplayPage({ id, item }: { id: string; item?: ReplayItem }) {
  const profile = useApp((s) => s.profile)!;
  const lang = profile.lang;
  const isShow = item ? item.kind === 'show' : /^ftvp:|^arte:RC-/.test(id);
  const [season, setSeason] = useState(0);
  const [failed, setFailed] = useState(false);
  const [show, setShow] = useState<ReplayShow | null>(null);
  const [info, setInfo] = useState<ReplayItem | undefined>(item);
  const progress = useAsync(() => (isShow ? Promise.resolve(undefined) : getProgress(profile.id, `replay:${id}`)), [id, profile.id]);

  useEffect(() => {
    let off = false;
    setFailed(false);
    if (isShow) replayShow(id, lang).then((s) => !off && (setShow(s), setInfo((x) => ({ ...s.item, ...x, desc: x?.desc || s.item.desc }))), () => !off && setFailed(true));
    else if (!item?.desc) replayInfo(id, lang).then((x) => !off && setInfo((cur) => ({ ...x, ...cur, desc: cur?.desc || x.desc })), () => !off && !item && setFailed(true));
    return () => {
      off = true;
    };
  }, [id, lang, isShow, item]);

  const it = info;
  const resumeAt = progress && !progress.completed && progress.positionSec > 30 ? progress.positionSec : undefined;
  const seasons = show?.seasons || [];
  const cur = seasons[Math.min(season, seasons.length - 1)];

  return (
    <div style={{ paddingBottom: 40 }}>
      <BackButton />
      <section className="detail-hero" style={{ minHeight: 'min(62vh, 44vw)' }}>
        <div className="bg">
          <Img srcs={[it?.image?.replace('940x530', '1280x720'), it?.image]} label={it?.title || ''} eager />
        </div>
        <div className="content">
          {it && <span className={`rp-prov ${it.provider}`}>{it.channel || PROVIDER_LABEL[it.provider]}</span>}
          <h1 style={{ fontSize: 'clamp(1.6rem,3vw,2.6rem)', margin: '6px 0' }}>{it?.title || ''}</h1>
          {it && (
            <div className="facts">
              {it.subtitle && <span>{it.subtitle}</span>}
              {it.genre && <span>{it.genre}</span>}
              {it.durationSec ? <span>{fmtDuration(it.durationSec)}</span> : null}
              {it.age ? <span className="age-pill">{it.age}+</span> : null}
              {it.expires && <span>{t('replay.until', { date: fmtDate(it.expires, { day: 'numeric', month: 'long' }) })}</span>}
            </div>
          )}
          {it?.desc && <p className="clamp3 muted">{it.desc}</p>}
          {failed && <p className="muted">{t('replay.unavailable')}</p>}
          {it && !isShow && (
            <div className="btn-row" data-row style={{ marginTop: 18 }}>
              <button className="btn primary" data-f data-autofocus onClick={() => void playReplay(it, resumeAt)}>
                <IcPlay /> {resumeAt ? t('detail.resume') : t('detail.play')}
              </button>
              {resumeAt && (
                <button className="btn" data-f onClick={() => void playReplay(it, 0)}>
                  <IcRestart /> {t('detail.restart')}
                </button>
              )}
            </div>
          )}
          {isShow && cur?.items[0] && (
            <div className="btn-row" data-row style={{ marginTop: 18 }}>
              <button className="btn primary" data-f data-autofocus onClick={() => void playReplay(cur.items[0])}>
                <IcPlay /> {t('detail.play')}
              </button>
            </div>
          )}
        </div>
      </section>
      {isShow && !show && !failed && <div className="spinner big" style={{ margin: '40px auto' }} />}
      {seasons.length > 1 && (
        <div className="chips" data-row data-tabs>
          {seasons.map((s, k) => (
            <button key={k} data-f className={`chip ${k === season ? 'active' : ''}`} onClick={() => setSeason(k)}>
              {s.title}
            </button>
          ))}
        </div>
      )}
      {cur && (
        <Rail title={seasons.length > 1 ? undefined : cur.title || t('detail.episodes')}>
          {cur.items.map((ep) => (
            <LandCard key={ep.id} {...cardProps(ep)} title={ep.subtitle && ep.title === it?.title ? ep.subtitle : ep.title} sub={ep.subtitle && ep.title === it?.title ? undefined : ep.subtitle} onClick={() => void playReplay(ep)} />
          ))}
        </Rail>
      )}
      {isShow && show && !seasons.length && <p className="container muted">{t('replay.noEpisodes')}</p>}
    </div>
  );
}
