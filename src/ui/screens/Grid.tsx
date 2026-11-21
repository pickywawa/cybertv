import { useEffect, useState } from 'react';
import { useApp, type GridFilter } from '@/state/store';
import { t } from '@/core/i18n';
import { gridMovies, gridSeries } from '@/core/repo';
import type { Movie, Series } from '@/core/types';
import { useAsync, useMediaQuery } from '../hooks';
import { VirtualGrid } from '../components/VirtualGrid';
import { PosterCard } from '../components/Cards';
import { PageHeader } from '../components/BackButton';
import { openMovie, openSeries, prioritizeEnrichment } from '../actions';
import { isTvMode } from '@/core/platform';

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
    () => (kind === 'movie' ? gridMovies(profile.id, { ...filter, sort }, hideAdult) : gridSeries(profile.id, { ...filter, sort }, hideAdult)),
    [kind, JSON.stringify(filter), sort, profile.id],
  );
  useEffect(() => {
    if (items) prioritizeEnrichment(kind, items.slice(0, 40));
  }, [items, kind]);

  return (
    <div style={{ paddingBottom: 40 }}>
      <PageHeader title={title} right={items ? <span className="dim small">{items.length}</span> : undefined} />
      <div className="chips" data-row>
        {SORTS.map((s) => (
          <button key={s} data-f className={`chip ${sort === s ? 'active' : ''}`} onClick={() => setSort(s)}>
            {SORT_LABEL[s][profile.lang]}
          </button>
        ))}
      </div>
      <div className="container" style={{ paddingTop: 12 }}>
        {!items ? (
          <div className="spinner big" style={{ margin: '60px auto' }} />
        ) : items.length === 0 ? (
          <div className="empty">{t('common.empty')}</div>
        ) : (
          <VirtualGrid
            className="vgrid"
            items={items}
            minWidth={mobile ? 104 : 170}
            aspect={2 / 3}
            extraHeight={52}
            gap={mobile ? 10 : 18}
            getKey={(x) => x.id}
            render={(x) => (
              <PosterCard
                title={x.title}
                sub={[x.year, x.rating ? `★ ${x.rating.toFixed(1)}` : null].filter(Boolean).join(' · ')}
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
