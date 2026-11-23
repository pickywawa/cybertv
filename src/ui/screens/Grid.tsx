import { useEffect, useMemo, useState } from 'react';
import { useApp, type GridFilter } from '@/state/store';
import { t } from '@/core/i18n';
import { gridMovies, gridSeries } from '@/core/repo';
import { langPrefs } from '@/core/prefs';
import type { Movie, Series } from '@/core/types';
import { useAsync, useMediaQuery } from '../hooks';
import { VirtualGrid } from '../components/VirtualGrid';
import { PosterCard } from '../components/Cards';
import { PageHeader } from '../components/BackButton';
import { openMovie, openSeries, prioritizeEnrichment } from '../actions';
import { isTvMode } from '@/core/platform';
import { db } from '@/core/db';
import { GENRES, genreKeys } from '@/core/util/genres';

const SORTS = ['added', 'rating', 'year', 'title'] as const;
const SORT_LABEL: Record<(typeof SORTS)[number], { fr: string; en: string }> = {
  added: { fr: 'Ajouts récents', en: 'Recently added' },
  rating: { fr: 'Mieux notés', en: 'Top rated' },
  year: { fr: 'Année', en: 'Year' },
  title: { fr: 'A → Z', en: 'A → Z' },
};

export function Grid({ kind, title, filter }: { kind: 'movie' | 'series'; title: string; filter: GridFilter }) {
  const profile = useApp((s) => s.profile)!;
  const hideAdult = useApp((s) => s.settings.hideAdult);
  const [sort, setSort] = useState(filter.sort || 'added');
  const mobile = useMediaQuery('(max-width: 760px)') && !isTvMode();
  const items = useAsync<(Movie | Series)[]>(
    () => (kind === 'movie' ? gridMovies(profile.id, { ...filter, sort }, hideAdult, langPrefs(profile)) : gridSeries(profile.id, { ...filter, sort }, hideAdult, langPrefs(profile))),
    [kind, JSON.stringify(filter), sort, profile.id, profile.lang, profile.audioLangs?.join(), profile.subLangs?.join()],
    { key: `grid:${profile.id}:${kind}:${JSON.stringify(filter)}:${sort}:${hideAdult}:${profile.lang}:${profile.audioLangs?.join()}:${profile.subLangs?.join()}` },
  );
  // sub-categories (genres) present in this list, from TMDB genres and provider category names
  const [sub, setSub] = useState<string | null>(null);
  const catNames = useAsync(
    async () => new Map((await db.categories.where('[profileId+kind]').between([profile.id, ''], [profile.id, '\uffff']).toArray()).map((c) => [c.id, c.name])),
    [profile.id],
    { key: `catnames:${profile.id}` },
  );
  const tagged = useMemo(() => {
    if (!items || !catNames) return null;
    return items.map((x) => ({ x, g: genreKeys(x, x.categoryId ? catNames.get(x.categoryId) : undefined) }));
  }, [items, catNames]);
  const subs = useMemo(() => {
    if (!tagged || filter.genre) return [];
    const n = new Map<string, number>();
    for (const { g } of tagged) for (const k of g) n.set(k, (n.get(k) || 0) + 1);
    return GENRES.filter((g) => (n.get(g.key) || 0) >= 8);
  }, [tagged, filter.genre]);
  const shown = useMemo(() => (sub && tagged ? tagged.filter((t) => t.g.includes(sub)).map((t) => t.x) : items), [sub, tagged, items]);
  useEffect(() => {
    if (shown) prioritizeEnrichment(kind, shown.slice(0, 40));
  }, [shown, kind]);

  return (
    <div style={{ paddingBottom: 40 }}>
      <PageHeader title={title} right={shown ? <span className="dim small">{shown.length}</span> : undefined} />
      {subs.length > 1 && (
        <div className="chips sub-chips" data-row data-tabs>
          <button data-f className={`chip ${!sub ? 'active' : ''}`} onClick={() => setSub(null)}>
            {t('replay.all')}
          </button>
          {subs.map((g) => (
            <button key={g.key} data-f className={`chip ${sub === g.key ? 'active' : ''}`} onClick={() => setSub(g.key)}>
              {g[profile.lang]}
            </button>
          ))}
        </div>
      )}
      <div className="chips" data-row data-tabs>
        {SORTS.map((s) => (
          <button key={s} data-f className={`chip ${sort === s ? 'active' : ''}`} onClick={() => setSort(s)}>
            {SORT_LABEL[s][profile.lang]}
          </button>
        ))}
      </div>
      <div className="container" style={{ paddingTop: 12 }}>
        {!shown ? (
          <div className="spinner big" style={{ margin: '60px auto' }} />
        ) : shown.length === 0 ? (
          <div className="empty">{t('common.empty')}</div>
        ) : (
          <VirtualGrid
            className="vgrid"
            items={shown}
            minWidth={mobile ? 104 : 170}
            aspect={2 / 3}
            extraHeight={52}
            gap={mobile ? 10 : 18}
            getKey={(x) => x.id}
            render={(x) => (
              <PosterCard
                imdb={x.imdbRating}
                title={x.title}
                sub={[x.year, x.genres?.[0]].filter(Boolean).join(' · ')}
                image={x.poster}
                onClick={() => (kind === 'movie' ? openMovie(x.id) : openSeries(x.id))}
              />
            )}
          />
        )}
      </div>
    </div>
  );
}
