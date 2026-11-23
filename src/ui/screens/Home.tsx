import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/state/store';
import { t, fmtDuration } from '@/core/i18n';
import { db, setMeta } from '@/core/db';
import { continueWatching, dedup, favoritesOf, hideFromContinue, matchMovies, matchSeries } from '@/core/repo';
import { dataWorker } from '@/core/workers';
import type { Movie, Series, WatchState } from '@/core/types';
import { useAsync } from '../hooks';
import { Rail } from '../components/Rail';
import { LandCard, PosterCard, Tile, Top10Card } from '../components/Cards';
import { Img } from '../components/Img';
import { IcFilm, IcGlobe, IcInfo, IcKids, IcLive, IcPlay, IcSeries } from '../icons';
import { openMovie, openSeries, playMovie, prioritizeEnrichment, resume } from '../actions';
import { resizeTmdb } from '@/core/enrich/tmdb';
import { langPrefs } from '@/core/prefs';
import { sortByLang } from '@/core/util/lang';
import { traktLists } from '@/core/trakt';
import type { TmdbListItem } from '@/core/types';

type HeroItem = { kind: 'movie' | 'series'; item: Movie | Series };
type MixItem = HeroItem;

export const homeKey = (profileId: string, prefsKey: string, hideAdult: boolean) => `home:${profileId}:${prefsKey}:${hideAdult}`;
export const homePrefsKey = (p: { lang: string; audioLangs?: string[]; subLangs?: string[] }) => `${p.lang}|${p.audioLangs?.join()}|${p.subLangs?.join()}`;

let lastSnapshot = 0;
/** persisted (throttled) so the next launch shows Home immediately — see loadHomeSnapshot() */
function saveHomeSnapshot(profileId: string, key: string, data: unknown) {
  if (Date.now() - lastSnapshot < 20000) return;
  lastSnapshot = Date.now();
  void setMeta(`snapshot:home:${profileId}`, { key, data, at: Date.now() }).catch(() => {});
}

const TILES = [
  { key: 'cinema', Icon: IcFilm },
  { key: 'series', Icon: IcSeries },
  { key: 'live', Icon: IcLive },
  { key: 'kids', Icon: IcKids },
  { key: 'docs', Icon: IcGlobe },
] as const;

export function Home() {
  const profile = useApp((s) => s.profile)!;
  const settings = useApp((s) => s.settings);
  const push = useApp((s) => s.push);
  const setTab = useApp((s) => s.setTab);
  const hideAdult = settings.hideAdult || (profile.parental.enabled && !useApp.getState().unlockedAdult);

  const prefsKey = homePrefsKey(profile);
  const data = useAsync(async () => {
    const prefs = langPrefs(profile);
    // the film / series rails come from the data worker: the whole catalogue is read there, never here
    const [cont, vod, favs] = await Promise.all([
      continueWatching(profile.id),
      dataWorker().homeCatalog(profile.id, profile.lang, hideAdult, prefs),
      favoritesOf(profile.id),
    ]);
    const favMovies = (await db.movies.bulkGet(favs.filter((f) => f.kind === 'movie').map((f) => f.itemId))).filter(Boolean) as Movie[];
    const favSeries = (await db.series.bulkGet(favs.filter((f) => f.kind === 'series').map((f) => f.itemId))).filter(Boolean) as Series[];
    // Trakt: recommendations, watchlist and personal lists, only what the sources carry
    const tr = await traktLists(profile.id).catch(() => null);
    const mixed = async (movies: TmdbListItem[], shows: TmdbListItem[]) => {
      const [m, sr] = await Promise.all([matchMovies(profile.id, movies), matchSeries(profile.id, shows)]);
      const out: MixItem[] = [];
      for (let i = 0; i < Math.max(m.length, sr.length); i++) {
        if (m[i]) out.push({ kind: 'movie', item: m[i] });
        if (sr[i]) out.push({ kind: 'series', item: sr[i] });
      }
      return out;
    };
    const trakt = tr
      ? {
          forYou: await mixed(tr.forYouMovies, tr.forYouShows),
          watchlist: await mixed(tr.watchlistMovies, tr.watchlistShows),
          lists: await Promise.all(tr.lists.map(async (l) => ({ name: l.name, items: await mixed(l.movies, l.shows) }))),
        }
      : null;
    return {
      trakt,
      cont, ...vod, favMovies, favSeries,
    };
  }, [profile.id, prefsKey, hideAdult], { key: homeKey(profile.id, prefsKey, hideAdult) });

  // snapshot for the next cold start: Home renders at once, then refreshes
  useEffect(() => {
    if (data) saveHomeSnapshot(profile.id, homeKey(profile.id, prefsKey, hideAdult), data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // enrich what's on screen first
  useEffect(() => {
    if (!data) return;
    prioritizeEnrichment('movie', [...data.top, ...data.fresh.slice(0, 16), ...data.nowPlaying.slice(0, 10)]);
    prioritizeEnrichment('series', [...data.trendingTv.slice(0, 10), ...data.newSeries.slice(0, 16)]);
  }, [data]);

  const hero = useMemo<HeroItem[]>(() => {
    if (!data) return [];
    const pool: HeroItem[] = [
      ...data.top.map((m) => ({ kind: 'movie' as const, item: m })),
      ...data.trendingTv.slice(0, 3).map((s) => ({ kind: 'series' as const, item: s })),
      ...data.fresh.map((m) => ({ kind: 'movie' as const, item: m })),
    ];
    const seen = new Set<string>();
    const prefs = langPrefs(profile);
    const ok = pool.filter((h) => h.item.backdrop && !seen.has(h.item.groupKey) && seen.add(h.item.groupKey));
    return sortByLang(ok.map((h) => ({ ...h, langs: h.item.langs, subs: h.item.subs, origLang: h.item.origLang })), prefs).slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (!data) return <div className="empty"><div className="spinner big" style={{ margin: '80px auto' }} /></div>;

  const open = (kind: 'movie' | 'series', id: string) => (kind === 'movie' ? openMovie(id) : openSeries(id));
  const removeCont = (w: WatchState) => void hideFromContinue(w).then(() => useApp.getState().bumpCatalog());

  return (
    <div>
      {hero.length > 0 ? <Hero items={hero} /> : <div className="hero-spacer" />}

      <Rail className="cat-rail">
        {TILES.map((tl) => (
          <Tile
            key={tl.key}
            label={tl.key === 'live' ? t('nav.tv') : tl.key === 'cinema' ? t('universe.cinema') : t(`universe.${tl.key}` as 'universe.kids')}
            icon={<tl.Icon />}
            onClick={() => {
              if (tl.key === 'live') return setTab('tv');
              if (tl.key === 'series') return push({ name: 'grid', kind: 'series', title: t('universe.series'), filter: {} });
              if (tl.key === 'cinema') return push({ name: 'grid', kind: 'movie', title: t('universe.cinema'), filter: {} });
              push({ name: 'grid', kind: 'movie', title: t(`universe.${tl.key}` as 'universe.kids'), filter: { universe: tl.key } });
            }}
          />
        ))}
      </Rail>

      {data.cont.length > 0 && (
        <Rail title={t('home.continue')}>
          {data.cont.map((w) => (
            <LandCard
              key={w.key}
              title={w.title}
              sub={w.subtitle}
              image={w.image}
              progress={w.durationSec ? w.positionSec / w.durationSec : 0}
              progressLight
              onClick={() => void resume(w)}
              onRemove={() => removeCont(w)}
              sub2={w.durationSec ? `${fmtDuration(Math.max(0, w.durationSec - w.positionSec))}` : undefined}
            />
          ))}
        </Rail>
      )}

      {!data.hasVod && (
        <div className="empty">
          <h3>{t('home.emptyTitle')}</h3>
          <p>{t('home.emptyText')}</p>
          <button className="btn primary" data-f onClick={() => setTab('tv')}>{t('nav.tv')}</button>
        </div>
      )}

      {data.trakt && <MixRail title={t('trakt.forYou')} items={data.trakt.forYou} />}

      <MovieRail title={t('home.fresh')} items={data.fresh} onAll={() => push({ name: 'grid', kind: 'movie', title: t('home.fresh'), filter: { sort: 'added' } })} />

      {data.top.length >= 3 && (
        <Rail title={t('home.top10')}>
          {data.top.map((m, i) => (
            <Top10Card key={m.id} rank={i + 1} title={m.title} image={m.poster} onClick={() => openMovie(m.id)} />
          ))}
        </Rail>
      )}

      <MovieRail title={t('home.nowPlaying')} items={data.nowPlaying} />
      <SeriesRail title={t('home.newSeries')} items={data.newSeries} onAll={() => push({ name: 'grid', kind: 'series', title: t('home.newSeries'), filter: { sort: 'added' } })} />
      <SeriesRail title={t('home.popularSeries')} items={dedup([...data.trendingTv, ...data.popularTv])} />
      <MovieRail title={t('home.mustSee')} items={data.mustSee} onAll={() => push({ name: 'grid', kind: 'movie', title: t('home.mustSee'), filter: { sort: 'rating' } })} />
      {(data.favMovies.length > 0 || data.favSeries.length > 0) && (
        <Rail title={t('home.myList')}>
          {data.favMovies.map((m) => <PosterCard imdb={m.imdbRating} key={m.id} title={m.title} sub={m.year ? String(m.year) : undefined} image={m.poster} onClick={() => open('movie', m.id)} />)}
          {data.favSeries.map((s) => <PosterCard imdb={s.imdbRating} key={s.id} title={s.title} image={s.poster} onClick={() => open('series', s.id)} />)}
        </Rail>
      )}
      {data.trakt && <MixRail title={t('trakt.watchlist')} items={data.trakt.watchlist} />}
      {data.trakt?.lists.map((l) => <MixRail key={l.name} title={l.name} items={l.items} />)}
      <MovieRail title={t('home.kids')} items={data.kids} onAll={() => push({ name: 'grid', kind: 'movie', title: t('home.kids'), filter: { universe: 'kids' } })} />
      <MovieRail title={t('home.popularMovies')} items={data.popularMovies} />
      {data.genres.map(([g, list]) => (
        <MovieRail key={g} title={g} items={list.slice(0, 30)} onAll={() => push({ name: 'grid', kind: 'movie', title: g, filter: { genre: g } })} />
      ))}
    </div>
  );
}

function MixRail({ title, items }: { title: string; items: MixItem[] }) {
  if (items.length < 2) return null;
  return (
    <Rail title={title}>
      {items.slice(0, 40).map(({ kind, item: x }) => (
        <PosterCard
          imdb={x.imdbRating}
          key={x.id}
          title={x.title}
          sub={[x.year, x.genres?.[0]].filter(Boolean).join(' · ')}
          image={x.poster}
          fallback={resizeTmdb(x.backdrop, 'w780')}
          onClick={() => (kind === 'movie' ? openMovie(x.id) : openSeries(x.id))}
        />
      ))}
    </Rail>
  );
}

function MovieRail({ title, items, onAll }: { title: string; items: Movie[]; onAll?: () => void }) {
  if (items.length < 3) return null;
  return (
    <Rail title={title} onSeeAll={onAll} seeAllLabel={t('common.all')}>
      {items.slice(0, 30).map((m) => (
        <PosterCard imdb={m.imdbRating} key={m.id} title={m.title} sub={[m.year, m.genres?.[0]].filter(Boolean).join(' · ')} image={m.poster} fallback={resizeTmdb(m.backdrop, 'w780')} onClick={() => openMovie(m.id)} onLongPress={() => void playMovie(m.id)} />
      ))}
    </Rail>
  );
}

function SeriesRail({ title, items, onAll }: { title: string; items: Series[]; onAll?: () => void }) {
  if (items.length < 3) return null;
  return (
    <Rail title={title} onSeeAll={onAll} seeAllLabel={t('common.all')}>
      {items.slice(0, 30).map((s) => (
        <PosterCard imdb={s.imdbRating} key={s.id} title={s.title} sub={[s.year, s.genres?.[0]].filter(Boolean).join(' · ')} image={s.poster} fallback={resizeTmdb(s.backdrop, 'w780')} onClick={() => openSeries(s.id)} />
      ))}
    </Rail>
  );
}

function Hero({ items }: { items: HeroItem[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || items.length < 2) return;
    const tm = setInterval(() => setI((x) => (x + 1) % items.length), 8000);
    return () => clearInterval(tm);
  }, [items.length, paused]);
  const h = items[Math.min(i, items.length - 1)];
  const it = h.item;
  return (
    <section className="hero" onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className="bg">
        <Img srcs={[resizeTmdb(it.backdrop, 'w1280')]} eager label={it.title} />
      </div>
      <div className="content">
        {it.logo ? <img className="title-logo" src={resizeTmdb(it.logo, 'w500')} alt={it.title} /> : <h1>{it.title}</h1>}
        <div className="facts">
          {it.year && <span>{it.year}</span>}
          {it.genres?.slice(0, 2).map((g) => <span key={g}>{g}</span>)}
          {it.rating ? <span className="rating">★ {it.rating.toFixed(1)}</span> : null}
        </div>
        {it.plot && <p className="clamp3">{it.plot}</p>}
        <div className="btn-row" data-row>
          <button
            className="btn primary"
            data-f
            data-autofocus
            onClick={() => (h.kind === 'movie' ? void playMovie(it.id) : openSeries(it.id))}
          >
            <IcPlay /> {t('home.play')}
          </button>
          <button className="btn" data-f onClick={() => (h.kind === 'movie' ? openMovie(it.id) : openSeries(it.id))}>
            <IcInfo /> {t('home.info')}
          </button>
          {items.length > 1 && (
            <button className="btn ghost small" data-f onClick={() => setI((x) => (x + 1) % items.length)} aria-label="next">
              ›
            </button>
          )}
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
