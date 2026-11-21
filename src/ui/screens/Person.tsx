import { useState } from 'react';
import { t, fmtDate } from '@/core/i18n';
import { useApp } from '@/state/store';
import { dataWorker } from '@/core/workers';
import { availableByTmdb } from '@/core/repo';
import { langPrefs } from '@/core/prefs';
import type { Movie, Series } from '@/core/types';
import { useAsync } from '../hooks';
import { PageHeader } from '../components/BackButton';
import { PosterCard } from '../components/Cards';
import { Img } from '../components/Img';
import { openMovie, openSeries } from '../actions';

type Item = { kind: 'movie'; it: Movie; role?: string } | { kind: 'series'; it: Series; role?: string };

/** Actor / director page: TMDB biography + their films and series that are in the catalogue */
export function PersonPage({ id, title }: { id: number; title: string }) {
  const profile = useApp((s) => s.profile)!;
  const [fullBio, setFullBio] = useState(false);
  const data = useAsync(async () => {
    const p = await dataWorker().tmdbPerson(id);
    if (!p) return { p: null, items: [] as Item[] };
    const prefs = langPrefs(profile);
    const credits = [...p.credits].sort((a, b) => b.popularity - a.popularity);
    const role = new Map(credits.map((c) => [`${c.kind}:${c.tmdbId}`, c.job === 'Director' ? t('person.director') : c.character]));
    const movieIds = [...new Set(credits.filter((c) => c.kind === 'movie').map((c) => c.tmdbId))];
    const tvIds = [...new Set(credits.filter((c) => c.kind === 'tv').map((c) => c.tmdbId))];
    const [movies, series] = await Promise.all([
      availableByTmdb(profile.id, 'movie', movieIds, prefs),
      availableByTmdb(profile.id, 'series', tvIds, prefs),
    ]);
    const items: Item[] = [
      ...movies.map((it) => ({ kind: 'movie' as const, it, role: role.get(`movie:${it.tmdbId}`) })),
      ...series.map((it) => ({ kind: 'series' as const, it, role: role.get(`tv:${it.tmdbId}`) })),
    ];
    // most recent first
    items.sort((a, b) => (b.it.year || 0) - (a.it.year || 0));
    return { p, items };
  }, [id, profile.id], { key: `person:${id}:${profile.id}` });

  const p = data?.p;
  return (
    <div className="settings person-page">
      <PageHeader title={p?.name || title} />
      {!data ? (
        <div className="spinner big" style={{ margin: '60px auto' }} />
      ) : (
        <>
          {p && (
            <div className="person-head">
              <div className="person-photo">
                <Img srcs={[p.photo]} label={p.name} alt={p.name} />
              </div>
              <div className="person-info">
                <h1>{p.name}</h1>
                <div className="small muted">
                  {[p.knownFor === 'Directing' ? t('person.director') : undefined, p.birthday && t('person.born', { date: fmtDate(Date.parse(p.birthday)) }), p.place].filter(Boolean).join(' · ')}
                  {p.deathday && <div>{t('person.died', { date: fmtDate(Date.parse(p.deathday)) })}</div>}
                </div>
                {p.bio && (
                  <>
                    <p className={fullBio ? '' : 'clamp5'} style={{ lineHeight: 1.55 }}>{p.bio}</p>
                    {!fullBio && p.bio.length > 400 && (
                      <button className="btn small" data-f onClick={() => setFullBio(true)}>{t('person.moreBio')}</button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          <h2 style={{ marginTop: 26 }}>{t('person.available')}</h2>
          {data.items.length === 0 ? (
            <p className="muted">{t('person.none')}</p>
          ) : (
            <div className="grid posters" style={{ marginTop: 12 }}>
              {data.items.map((x) => (
                <PosterCard
                  key={`${x.kind}:${x.it.id}`}
                  imdb={x.it.imdbRating}
                  title={x.it.title}
                  sub={[x.it.year, x.role].filter(Boolean).join(' · ')}
                  image={x.it.poster}
                  onClick={() => (x.kind === 'movie' ? openMovie(x.it.id) : openSeries(x.it.id))}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
