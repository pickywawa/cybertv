import { isGenericEpisodeTitle } from '@/core/util/text';
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '@/state/store';
import { t, fmtRuntime, fmtDuration } from '@/core/i18n';
import { db } from '@/core/db';
import { dedup, episodesOf, toggleFavorite } from '@/core/repo';
import type { Episode, Movie, Series } from '@/core/types';
import { resizeTmdb } from '@/core/enrich/tmdb';
import { dataWorker } from '@/core/workers';
import { useAsync } from '../hooks';
import { Img } from '../components/Img';
import { BackButton } from '../components/BackButton';
import { Rail } from '../components/Rail';
import { PosterCard } from '../components/Cards';
import { IcCheck, IcPlay, IcPlus, IcRestart, IcStar } from '../icons';
import { openMovie, openSeries, playEpisode, playMovie, prioritizeEnrichment } from '../actions';
import { loadXtreamEpisodesIfNeeded } from '../episodes';

export function Detail({ kind, id }: { kind: 'movie' | 'series'; id: string }) {
  const item = useLiveQuery(() => (kind === 'movie' ? db.movies.get(id) : db.series.get(id)), [kind, id]);
  useEffect(() => {
    if (item && !item.enrichedAt) prioritizeEnrichment(kind, [item]);
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
      {it.rating ? (
        <span className="rating">
          <IcStar width={14} height={14} style={{ verticalAlign: -2 }} /> {it.rating.toFixed(1)}
        </span>
      ) : null}
      {it.genres?.slice(0, 3).map((g) => <span key={g} className="pill">{g}</span>)}
    </div>
  );
}

function HeroBlock({ it, children }: { it: Movie | Series; children: React.ReactNode }) {
  return (
    <section className="detail-hero">
      <div className="bg">
        <Img srcs={[resizeTmdb(it.backdrop, 'w1280'), it.poster]} eager label={it.title} />
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
  const similar = useAsync(async () => {
    const g = m.genres?.[0];
    if (!g) return [];
    const rows = await db.movies.where('profileId').equals(profile.id).filter((x) => x.groupKey !== m.groupKey && !!x.genres?.includes(g)).limit(60).toArray();
    return dedup(rows).sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 24);
  }, [m.id, m.genres?.join()]);
  const canResume = progress && !progress.completed && progress.positionSec > 60;

  return (
    <div style={{ paddingBottom: 40 }}>
      <BackButton />
      <HeroBlock it={m}>
        <Facts it={m} duration={m.durationSec} />
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
      {similar && similar.length > 2 && (
        <Rail title={t('detail.similar')}>
          {similar.map((x) => <PosterCard key={x.id} title={x.title} sub={x.year ? String(x.year) : undefined} image={x.poster} onClick={() => openMovie(x.id)} />)}
        </Rail>
      )}
    </div>
  );
}

function SeriesDetail({ s }: { s: Series }) {
  const profile = useApp((s) => s.profile)!;
  const [fav, toggleFav] = useFav('series', s);
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

  const similar = useAsync(async () => {
    const g = s.genres?.[0];
    if (!g) return [];
    const rows = await db.series.where('profileId').equals(profile.id).filter((x) => x.groupKey !== s.groupKey && !!x.genres?.includes(g)).limit(40).toArray();
    return dedup(rows).slice(0, 24);
  }, [s.id]);

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

  return (
    <div style={{ paddingBottom: 40 }}>
      <BackButton />
      <HeroBlock it={s}>
        <Facts it={s} />
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

      <div className="tabs container" data-row style={{ marginTop: 10 }}>
        <button data-f className={`tab ${tab === 'episodes' ? 'active' : ''}`} onClick={() => setTab('episodes')}>{t('detail.episodes')}</button>
        {similar && similar.length > 0 && (
          <button data-f className={`tab ${tab === 'similar' ? 'active' : ''}`} onClick={() => setTab('similar')}>{t('detail.similar')}</button>
        )}
      </div>

      {tab === 'episodes' && (
        <>
          {seasons.length > 1 && (
            <div className="season-btns" data-row>
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
            <div className="ep-list">
              {list.map((e) => {
                const w = wmap.get(e.id);
                return (
                  <button key={e.id} className="ep" data-f onClick={() => void playEpisode(s.id, e.id, w && !w.completed ? w.positionSec : 0)}>
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
                        {!isGenericEpisodeTitle(e.title) ? ` · ${e.title}` : ''}
                      </div>
                      {e.durationSec ? <div className="small muted" style={{ margin: '4px 0 8px' }}>{t('common.min', { n: Math.round(e.durationSec / 60) })}</div> : null}
                      {e.plot && <p className="clamp3 muted" style={{ margin: 0, lineHeight: 1.45 }}>{e.plot}</p>}
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
          {similar.map((x) => <PosterCard key={x.id} title={x.title} image={x.poster} onClick={() => openSeries(x.id)} />)}
        </div>
      )}
    </div>
  );
}
