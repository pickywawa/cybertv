import { cleanEpisodeTitle, isGenericEpisodeTitle } from '@/core/util/text';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '@/state/store';
import { t, fmtRuntime, fmtDuration } from '@/core/i18n';
import { db } from '@/core/db';
import { availableByTmdb, dedupLang, episodesOf, toggleFavorite } from '@/core/repo';
import type { Episode, Movie, Person, Series } from '@/core/types';
import { resizeTmdb } from '@/core/enrich/tmdb';
import { dataWorker } from '@/core/workers';
import { useAsync } from '../hooks';
import { Img } from '../components/Img';
import { BackButton } from '../components/BackButton';
import { Rail } from '../components/Rail';
import { ImdbBadge, PosterCard } from '../components/Cards';
import { IcCheck, IcPlay, IcPlus, IcRestart, IcStar, IcVolume, IcVolumeOff } from '../icons';
import { flagOf, type LangPrefs } from '@/core/util/lang';
import { langPrefs } from '@/core/prefs';
import { openMovie, openSeries, playEpisode, playMovie, prioritizeEnrichment } from '../actions';
import { loadXtreamEpisodesIfNeeded } from '../episodes';

export function Detail({ kind, id }: { kind: 'movie' | 'series'; id: string }) {
  const item = useLiveQuery(() => (kind === 'movie' ? db.movies.get(id) : db.series.get(id)), [kind, id]);
  useEffect(() => {
    if (item) prioritizeEnrichment(kind, [item]);
  }, [item, kind]);
  if (item === undefined) return <div className="spinner big" style={{ margin: '30vh auto' }} />;
  if (!item) return <div className="empty">{t('common.empty')}</div>;
  return kind === 'movie' ? <MovieDetail m={item as Movie} /> : <SeriesDetail s={item as Series} />;
}

function Facts({ it, duration }: { it: Movie | Series; duration?: number }) {
  return (
    <div className="facts">
      {it.year && <span>{it.year}</span>}
      {duration ? <span>{fmtRuntime(duration)}</span> : null}
      {it.certAge !== undefined || it.cert ? <AgePill age={it.certAge} cert={it.cert} /> : null}
      {it.imdbRating ? <ImdbBadge rating={it.imdbRating} votes={it.imdbVotes} inline /> : null}
      {it.rating ? (
        <span className="rating" title="TMDB">
          <IcStar width={14} height={14} style={{ verticalAlign: -2 }} /> {it.rating.toFixed(1)}
        </span>
      ) : null}
      {it.genres?.slice(0, 3).map((g) => <span key={g} className="pill">{g}</span>)}
    </div>
  );
}

export function AgePill({ age, cert }: { age?: number; cert?: string }) {
  if (age === undefined) return cert ? <span className="age-pill">{cert}</span> : null;
  return (
    <span className={`age-pill a${age}`} title={age ? t('age.min', { n: age }) : t('age.all')}>
      {age === 0 ? t('age.allShort') : `-${age}`}
    </span>
  );
}

/** main cast, round photos → actor page */
function CastRail({ people }: { people?: Person[] }) {
  const push = useApp((s) => s.push);
  if (!people?.length) return null;
  return (
    <Rail title={t('detail.cast')}>
      {people.map((p) => (
        <button key={p.id} className="card person-card" data-f onClick={() => push({ name: 'person', id: p.id, title: p.name })}>
          <span className="ph-round">{p.photo ? <Img srcs={[p.photo]} label={p.name} alt={p.name} /> : <span className="ini">{p.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>}</span>
          <span className="nm ellipsis">{p.name}</span>
          {p.character && <span className="ch ellipsis">{p.character}</span>}
        </button>
      ))}
    </Rail>
  );
}

/** TMDB recommendations available in the catalogue; same-genre titles when there are too few */
function useRecommendations(kind: 'movie' | 'series', it: Movie | Series) {
  const profile = useApp((s) => s.profile)!;
  return useAsync(async () => {
    const prefs = langPrefs(profile);
    const recos = (await availableByTmdb(profile.id, kind, it.recos || [], prefs)).filter((x) => x.groupKey !== it.groupKey);
    if (recos.length >= 3) return { title: t('detail.recommended'), items: recos.slice(0, 24) };
    const g = it.genres?.[0];
    if (!g) return { title: t('detail.recommended'), items: recos };
    const table = kind === 'movie' ? db.movies : db.series;
    const rows = await (table as typeof db.movies).where('profileId').equals(profile.id).filter((x) => x.groupKey !== it.groupKey && !!x.genres?.includes(g)).limit(80).toArray();
    const more = dedupLang(rows, prefs).sort((a, b) => (b.imdbRating || b.rating || 0) - (a.imdbRating || a.rating || 0));
    const seen = new Set(recos.map((x) => x.groupKey));
    return { title: recos.length ? t('detail.recommended') : t('detail.similar'), items: [...recos, ...more.filter((x) => !seen.has(x.groupKey))].slice(0, 24) };
  }, [kind, it.id, it.recos?.join(), it.genres?.join()]);
}

/** other films of the saga that are in the catalogue, in release order */
function SagaRail({ m }: { m: Movie }) {
  const profile = useApp((s) => s.profile)!;
  const data = useAsync(async () => {
    if (!m.collection) return null;
    const col = await dataWorker().tmdbCollection(m.collection.id);
    if (!col) return null;
    const parts = [...col.parts].sort((a, b) => (a.year || 9999) - (b.year || 9999));
    const items = await availableByTmdb(profile.id, 'movie', parts.map((p) => p.tmdbId), langPrefs(profile));
    // position in the whole saga (some parts may be missing from the catalogue)
    const pos = new Map(parts.map((p, i) => [p.tmdbId, i + 1]));
    return { name: col.name, items, total: parts.length, pos };
  }, [m.collection?.id]);
  if (!data || data.items.length < 2) return null;
  return (
    <Rail title={`${t('detail.saga')} · ${data.name}`}>
      {data.items.map((x) => (
        <PosterCard
          imdb={x.imdbRating}
          key={x.id}
          title={x.title}
          sub={[x.year, x.groupKey === m.groupKey ? t('detail.thisOne') : `${data.pos?.get(x.tmdbId!) ?? '?'}/${data.total}`].filter(Boolean).join(' · ')}
          image={x.poster}
          onClick={() => (x.groupKey === m.groupKey ? undefined : openMovie(x.id))}
        />
      ))}
    </Rail>
  );
}

function youtubeKey(url?: string): string | undefined {
  return url?.match(/(?:v=|youtu\.be\/|embed\/)([\w-]{11})/)?.[1];
}

/**
 * Trailer replacing the backdrop shortly after the page opens (YouTube embed, no controls).
 * Sound on by default; muting is remembered for the next trailers. If the browser refuses to
 * autoplay with sound, it plays muted instead (without changing the saved choice).
 */
function TrailerBg({ url }: { url?: string }) {
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const playing = useApp((s) => !!s.player);
  const key = youtubeKey(url);
  const [mount, setMount] = useState(false);
  const [on, setOn] = useState(false);
  const [muted, setMuted] = useState(settings.trailerMuted);
  const ref = useRef<HTMLIFrameElement>(null);
  const enabled = !!key && settings.autoTrailer && !settings.performance && !playing;
  const startMuted = useRef(settings.trailerMuted);
  useEffect(() => {
    if (!enabled) {
      setMount(false);
      setOn(false);
      return;
    }
    startMuted.current = useApp.getState().settings.trailerMuted;
    setMuted(startMuted.current);
    const tm = setTimeout(() => setMount(true), 900);
    return () => clearTimeout(tm);
  }, [enabled]);

  const cmd = (func: string) => ref.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');

  // YouTube IFrame API messages: reveal once the video really plays, fall back to muted if blocked
  useEffect(() => {
    if (!mount) return;
    let playingSeen = false;
    const onMsg = (e: MessageEvent) => {
      if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname) || e.source !== ref.current?.contentWindow) return;
      let d: any;
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      const state = d?.event === 'onStateChange' ? d.info : d?.info?.playerState;
      if (state === 1 && !playingSeen) {
        playingSeen = true;
        // a short beat hides YouTube's title overlay
        setTimeout(() => setOn(true), 350);
      }
    };
    window.addEventListener('message', onMsg);
    const fallback = setTimeout(() => {
      if (playingSeen) return;
      if (!startMuted.current) {
        cmd('mute');
        cmd('playVideo');
        setMuted(true);
      }
      // no API message at all (blocked postMessage): show it anyway, as before
      setTimeout(() => setOn(true), 1200);
    }, 3500);
    return () => {
      window.removeEventListener('message', onMsg);
      clearTimeout(fallback);
    };
  }, [mount]);

  if (!enabled || !mount) return null;
  const params = new URLSearchParams({
    autoplay: '1', mute: startMuted.current ? '1' : '0', controls: '0', loop: '1', playlist: key!, modestbranding: '1', playsinline: '1', rel: '0',
    iv_load_policy: '3', disablekb: '1', fs: '0', enablejsapi: '1', origin: location.origin,
  });
  return (
    <>
      <div className={`trailer ${on ? 'on' : ''}`}>
        <iframe
          ref={ref}
          src={`https://www.youtube-nocookie.com/embed/${key}?${params}`}
          title="trailer"
          tabIndex={-1}
          allow="autoplay; encrypted-media; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => ref.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'cyber-trailer' }), '*')}
        />
      </div>
      {on && (
        <button
          className="icon-btn trailer-mute"
          data-f
          onClick={() => {
            const next = !muted;
            cmd(next ? 'mute' : 'unMute');
            setMuted(next);
            // remembered for the next trailers
            update({ trailerMuted: next });
          }}
          aria-label={muted ? t('detail.unmute') : t('detail.mute')}
        >
          {muted ? <IcVolumeOff /> : <IcVolume />}
        </button>
      )}
    </>
  );
}

/** audio / subtitle languages of all versions of a title */
function useGroupLangs(kind: 'movie' | 'series', it: Movie | Series) {
  return useAsync(async () => {
    const rows: (Movie | Series)[] = kind === 'movie'
      ? await db.movies.where('groupKey').equals(it.groupKey).toArray()
      : await db.series.where('groupKey').equals(it.groupKey).toArray();
    const audio = new Set<string>();
    const subs = new Set<string>();
    for (const r of rows.filter((x) => x.profileId === it.profileId)) {
      for (const l of r.langs || []) audio.add(l);
      for (const l of r.subs || []) subs.add(l);
    }
    return { audio: [...audio], subs: [...subs] };
  }, [kind, it.groupKey, it.langs?.join(), it.subs?.join()]);
}

function Langs({ audio, subs, prefs }: { audio: string[]; subs: string[]; prefs: LangPrefs }) {
  const order = (l: string[]) => [...l].sort((a, b) => (prefs.audio.indexOf(a) + 1 || 99) - (prefs.audio.indexOf(b) + 1 || 99));
  if (!audio.length && !subs.length) return <div className="langs"><span className="dim">{t('detail.langUnknown')}</span></div>;
  const Flag = ({ l, mine }: { l: string; mine: boolean }) => (
    <span className={`flag ${mine ? 'mine' : ''}`} title={l}>
      <span className="e">{flagOf(l)}</span>
      {l.toUpperCase()}
    </span>
  );
  return (
    <div className="langs">
      {audio.length > 0 && (
        <span className="grp">
          <b>{t('detail.audio')}</b>
          {order(audio).map((l) => <Flag key={l} l={l} mine={prefs.audio.includes(l)} />)}
        </span>
      )}
      {subs.length > 0 && (
        <span className="grp">
          <b>{t('detail.subs')}</b>
          {order(subs).map((l) => <Flag key={l} l={l} mine={prefs.subs.includes(l)} />)}
        </span>
      )}
    </div>
  );
}

function HeroBlock({ it, children }: { it: Movie | Series; children: React.ReactNode }) {
  return (
    <section className="detail-hero">
      <div className="bg">
        <Img srcs={[resizeTmdb(it.backdrop, 'w1280'), it.poster]} eager label={it.title} />
        <TrailerBg url={it.trailer} />
      </div>
      <div className="content">
        {it.logo ? (
          <img className="title-logo" src={resizeTmdb(it.logo, 'w500')} alt={it.title} style={{ maxWidth: 'min(420px,70vw)', maxHeight: 140, objectFit: 'contain', objectPosition: 'left', marginBottom: 14 }} />
        ) : (
          <h1 style={{ fontSize: 'clamp(1.8rem,3.6vw,3rem)', fontWeight: 900, lineHeight: 1.05 }}>{it.title}</h1>
        )}
        {children}
      </div>
    </section>
  );
}

function useFav(kind: 'movie' | 'series', it: Movie | Series) {
  const profile = useApp((s) => s.profile)!;
  const fav = useLiveQuery(() => db.favorites.get([profile.id, `${kind}:${it.groupKey}`]), [profile.id, it.groupKey]);
  const toggle = () => void toggleFavorite(profile.id, kind, it.groupKey, it.id).then(() => useApp.getState().bumpCatalog());
  return [!!fav, toggle] as const;
}

function MovieDetail({ m }: { m: Movie }) {
  const profile = useApp((s) => s.profile)!;
  const progress = useLiveQuery(() => db.watch.get([profile.id, `movie:${m.id}`]), [profile.id, m.id]);
  const [fav, toggleFav] = useFav('movie', m);
  const variants = useAsync(() => db.movies.where('groupKey').equals(m.groupKey).count(), [m.groupKey]);
  const recos = useRecommendations('movie', m);
  const canResume = progress && !progress.completed && progress.positionSec > 60;
  const langs = useGroupLangs('movie', m);

  return (
    <div style={{ paddingBottom: 40 }}>
      <BackButton />
      <HeroBlock it={m}>
        <Facts it={m} duration={m.durationSec} />
        {langs && <Langs audio={langs.audio} subs={langs.subs} prefs={langPrefs(profile)} />}
        {m.plot && <p style={{ lineHeight: 1.55, maxWidth: 680 }} className="clamp3">{m.plot}</p>}
        {canResume && (
          <div style={{ maxWidth: 360, margin: '12px 0' }}>
            <div className="progress" style={{ position: 'relative', left: 0, right: 0, bottom: 0 }}>
              <i style={{ width: `${(progress.positionSec / progress.durationSec) * 100}%` }} />
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>{t('player.resumeAt', { time: fmtDuration(progress.positionSec) })}</div>
          </div>
        )}
        <div className="btn-row" data-row style={{ marginTop: 18 }}>
          <button className="btn primary" data-f data-autofocus onClick={() => void playMovie(m.id, canResume ? progress!.positionSec : 0)}>
            <IcPlay /> {canResume ? t('detail.resume') : t('detail.play')}
          </button>
          {canResume && (
            <button className="btn" data-f onClick={() => void playMovie(m.id, 0)}>
              <IcRestart /> {t('detail.restart')}
            </button>
          )}
          <button className="btn" data-f onClick={toggleFav}>
            {fav ? <IcCheck /> : <IcPlus />} {fav ? t('detail.inList') : t('detail.addList')}
          </button>
          {m.trailer && (
            <a className="btn" data-f href={m.trailer} target="_blank" rel="noreferrer">
              {t('detail.trailer')}
            </a>
          )}
        </div>
        <div className="small muted" style={{ marginTop: 18, lineHeight: 1.6 }}>
          {m.director && <div><b>{t('detail.director')} :</b> {m.director}</div>}
          {m.cast?.length ? <div className="clamp2"><b>{t('detail.cast')} :</b> {m.cast.slice(0, 8).join(', ')}</div> : null}
          {variants && variants > 1 ? <div>{t('detail.sources', { n: variants })}</div> : null}
        </div>
      </HeroBlock>
      <SagaRail m={m} />
      <CastRail people={m.people} />
      {recos && recos.items.length > 2 && (
        <Rail title={recos.title}>
          {recos.items.map((x) => <PosterCard imdb={x.imdbRating} key={x.id} title={x.title} sub={x.year ? String(x.year) : undefined} image={x.poster} onClick={() => openMovie(x.id)} />)}
        </Rail>
      )}
    </div>
  );
}

function SeriesDetail({ s }: { s: Series }) {
  const profile = useApp((s) => s.profile)!;
  const [fav, toggleFav] = useFav('series', s);
  const langs = useGroupLangs('series', s);
  const [tab, setTab] = useState<'episodes' | 'similar'>('episodes');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    void loadXtreamEpisodesIfNeeded(s.id).finally(() => setLoading(false));
  }, [s.id]);
  const episodes = useLiveQuery(() => episodesOf(s.id), [s.id]);
  const seasons = useMemo(() => [...new Set((episodes || []).map((e) => e.season))].sort((a, b) => a - b), [episodes]);
  const watch = useLiveQuery(() => db.watch.where('profileId').equals(profile.id).filter((w) => w.seriesId === s.id).toArray(), [profile.id, s.id]);
  const last = useMemo(() => (watch || []).sort((a, b) => b.updatedAt - a.updatedAt)[0], [watch]);
  const [season, setSeason] = useState<number | null>(null);
  const curSeason = season ?? (last ? episodes?.find((e) => e.id === last.itemId)?.season : undefined) ?? seasons[0];
  const list = (episodes || []).filter((e) => e.season === curSeason);
  const wmap = useMemo(() => new Map((watch || []).map((w) => [w.itemId, w])), [watch]);

  useEffect(() => {
    if (s.tmdbId && curSeason !== undefined) void dataWorker().enrichSeason(s.id, curSeason);
  }, [s.id, s.tmdbId, curSeason]);

  const recos = useRecommendations('series', s);
  const similar = recos?.items;

  const resumeTarget: { ep: Episode; at: number } | null = useMemo(() => {
    if (!episodes?.length) return null;
    if (last) {
      const ep = episodes.find((e) => e.id === last.itemId);
      if (ep && !last.completed) return { ep, at: last.positionSec };
      if (ep) {
        const i = episodes.indexOf(ep);
        if (episodes[i + 1]) return { ep: episodes[i + 1], at: 0 };
      }
    }
    return { ep: episodes[0], at: 0 };
  }, [episodes, last]);

  // the episode to watch next is brought into view in the horizontal list
  const epListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = resumeTarget?.ep.id;
    const box = epListRef.current;
    const el = id ? box?.querySelector<HTMLElement>(`[data-ep="${id}"]`) : null;
    if (box && el) box.scrollLeft = Math.max(0, el.offsetLeft - box.offsetLeft - 16);
  }, [resumeTarget?.ep.id, curSeason, list.length]);

  return (
    <div style={{ paddingBottom: 40 }}>
      <BackButton />
      <HeroBlock it={s}>
        <Facts it={s} />
        {langs && <Langs audio={langs.audio} subs={langs.subs} prefs={langPrefs(profile)} />}
        {s.plot && <p style={{ lineHeight: 1.55, maxWidth: 680 }} className="clamp3">{s.plot}</p>}
        <div className="btn-row" data-row style={{ marginTop: 18 }}>
          <button className="btn primary" data-f data-autofocus disabled={!resumeTarget} onClick={() => resumeTarget && void playEpisode(s.id, resumeTarget.ep.id, resumeTarget.at)}>
            <IcPlay /> {resumeTarget && last ? `${t('detail.resume')} S${resumeTarget.ep.season} E${resumeTarget.ep.episode}` : t('detail.play')}
          </button>
          <button className="btn" data-f onClick={toggleFav}>
            {fav ? <IcCheck /> : <IcPlus />} {fav ? t('detail.inList') : t('detail.addList')}
          </button>
          {s.trailer && (
            <a className="btn" data-f href={s.trailer} target="_blank" rel="noreferrer">{t('detail.trailer')}</a>
          )}
        </div>
        {s.cast?.length ? <div className="small muted clamp2" style={{ marginTop: 16 }}><b>{t('detail.cast')} :</b> {s.cast.slice(0, 8).join(', ')}</div> : null}
      </HeroBlock>

      <div className="tabs container" data-row data-tabs style={{ marginTop: 10 }}>
        <button data-f className={`tab ${tab === 'episodes' ? 'active' : ''}`} onClick={() => setTab('episodes')}>{t('detail.episodes')}</button>
        {similar && similar.length > 0 && (
          <button data-f className={`tab ${tab === 'similar' ? 'active' : ''}`} onClick={() => setTab('similar')}>{t('detail.similar')}</button>
        )}
      </div>

      {tab === 'episodes' && (
        <>
          {seasons.length > 1 && (
            <div className="season-btns" data-row data-tabs>
              {seasons.map((n) => (
                <button key={n} data-f className={`season-btn ${n === curSeason ? 'active' : ''}`} onClick={() => setSeason(n)}>
                  S{n}
                </button>
              ))}
            </div>
          )}
          {list.length > 0 && <div className="container muted small" style={{ margin: '6px 0 12px' }}>{t('detail.seasonCount', { n: list.length })}</div>}
          {loading && !list.length ? (
            <div className="spinner big" style={{ margin: '40px auto' }} />
          ) : !list.length ? (
            <div className="empty">{t('detail.noEpisodes')}</div>
          ) : (
            <div className="ep-list" data-row ref={epListRef}>
              {list.map((e) => {
                const w = wmap.get(e.id);
                return (
                  <button key={e.id} className="ep" data-f data-ep={e.id} onClick={() => void playEpisode(s.id, e.id, w && !w.completed ? w.positionSec : 0)}>
                    <div className="thumb">
                      <Img srcs={[e.still, s.backdrop]} label={`${s.title} ${e.episode}`} />
                      <span className="play-ov"><IcPlay color="#fff" /></span>
                      {w && (
                        <div className="progress">
                          <i style={{ width: `${w.completed ? 100 : (w.positionSec / Math.max(1, w.durationSec)) * 100}%` }} />
                        </div>
                      )}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>
                        {t('detail.episode', { n: e.episode })}
                        {!isGenericEpisodeTitle(e.title) ? ` · ${cleanEpisodeTitle(e.title)}` : ''}
                      </div>
                      {e.durationSec ? <div className="small muted" style={{ margin: '4px 0 8px' }}>{t('common.min', { n: Math.round(e.durationSec / 60) })}</div> : null}
                      {e.plot && <p className="clamp2 muted small" style={{ margin: 0, lineHeight: 1.45 }}>{e.plot}</p>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
      {tab === 'similar' && similar && (
        <div className="grid posters" style={{ marginTop: 16 }}>
          {similar.map((x) => <PosterCard imdb={x.imdbRating} key={x.id} title={x.title} image={x.poster} onClick={() => openSeries(x.id)} />)}
        </div>
      )}
      <CastRail people={s.people} />
    </div>
  );
}
