import { useApp } from '@/state/store';
import { t, fmtDuration } from '@/core/i18n';
import { db } from '@/core/db';
import { continueWatching, favoritesOf, history } from '@/core/repo';
import type { Movie, Series } from '@/core/types';
import { useAsync } from '../hooks';
import { Rail } from '../components/Rail';
import { LandCard, PosterCard } from '../components/Cards';
import { openMovie, openSeries, resume } from '../actions';

export function MyVideos() {
  const profile = useApp((s) => s.profile)!;
  const data = useAsync(async () => {
    const [cont, favs, hist] = await Promise.all([continueWatching(profile.id), favoritesOf(profile.id), history(profile.id)]);
    const movies = (await db.movies.bulkGet(favs.filter((f) => f.kind === 'movie').map((f) => f.itemId))).filter(Boolean) as Movie[];
    const series = (await db.series.bulkGet(favs.filter((f) => f.kind === 'series').map((f) => f.itemId))).filter(Boolean) as Series[];
    return { cont, movies, series, hist: hist.filter((h) => h.kind !== 'live' && h.completed) };
  }, [profile.id], { key: `myvideos:${profile.id}` });
  if (!data) return null;
  const empty = !data.cont.length && !data.movies.length && !data.series.length && !data.hist.length;
  return (
    <div className="tab-myvideos">
      <div className="container tab-h1">
        <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>{t('nav.myvideos')}</h1>
      </div>
      {empty && <div className="empty">{t('myvideos.empty')}</div>}
      {data.cont.length > 0 && (
        <Rail title={t('home.continue')}>
          {data.cont.map((w) => (
            <LandCard key={w.key} title={w.title} sub={w.subtitle} image={w.image} progress={w.positionSec / Math.max(1, w.durationSec)} progressLight sub2={fmtDuration(Math.max(0, w.durationSec - w.positionSec))} onClick={() => void resume(w)} />
          ))}
        </Rail>
      )}
      {data.movies.length + data.series.length > 0 && (
        <Rail title={t('home.myList')}>
          {data.movies.map((m) => <PosterCard imdb={m.imdbRating} key={m.id} title={m.title} image={m.poster} onClick={() => openMovie(m.id)} />)}
          {data.series.map((s) => <PosterCard imdb={s.imdbRating} key={s.id} title={s.title} image={s.poster} onClick={() => openSeries(s.id)} />)}
        </Rail>
      )}
      {data.hist.length > 0 && (
        <Rail title={t('myvideos.history')}>
          {data.hist.map((w) => (
            <LandCard key={w.key} title={w.title} sub={w.subtitle} image={w.image} onClick={() => (w.kind === 'movie' ? openMovie(w.itemId) : w.seriesId && openSeries(w.seriesId))} />
          ))}
        </Rail>
      )}
    </div>
  );
}
