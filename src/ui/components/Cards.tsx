import { memo, type ReactNode } from 'react';
import { Img } from './Img';
import { useLongPress } from '../hooks';
import { resizeTmdb } from '@/core/enrich/tmdb';
import { IcClose } from '../icons';

/** one url or a fallback chain (provider logo, then iptv-org's) */
type Srcs = string | (string | undefined)[];
const list = (x?: Srcs) => (Array.isArray(x) ? x : [x]);

interface Base {
  onClick?: () => void;
  onLongPress?: () => void;
  autoFocus?: boolean;
}

export const PosterCard = memo(function PosterCard(p: Base & { title: string; sub?: string; image?: string; fallback?: string; badge?: string; progress?: number; hideMeta?: boolean; imdb?: number }) {
  const ref = useLongPress<HTMLButtonElement>(() => p.onLongPress?.());
  return (
    <button ref={ref} className="card poster" data-f data-lp={p.onLongPress ? '' : undefined} data-autofocus={p.autoFocus || undefined} onClick={p.onClick} aria-label={p.title}>
      <div className="thumb">
        <Img srcs={[resizeTmdb(p.image, 'w342'), p.fallback]} label={p.title} alt={p.title} />
        {p.badge && <span className="badge">{p.badge}</span>}
        {p.imdb ? <ImdbBadge rating={p.imdb} /> : null}
        {p.progress !== undefined && (
          <div className="progress">
            <i style={{ width: `${Math.min(100, Math.max(2, p.progress * 100))}%` }} />
          </div>
        )}
      </div>
      {!p.hideMeta && (
        <div className="meta">
          <div className="title ellipsis">{p.title}</div>
          {p.sub && <div className="sub ellipsis">{p.sub}</div>}
        </div>
      )}
    </button>
  );
});

export const LandCard = memo(function LandCard(
  p: Base & {
    title: string;
    sub?: string;
    sub2?: string;
    image?: string;
    fallbacks?: (string | undefined)[];
    logo?: Srcs;
    progress?: number;
    progressLight?: boolean;
    badge?: string;
    badgeLive?: boolean;
    action?: ReactNode;
    onRemove?: () => void;
    /** show this logo centered (no program artwork available) */
    centerLogo?: Srcs;
  },
) {
  const ref = useLongPress<HTMLButtonElement>(() => p.onLongPress?.());
  return (
    <div className="card land" style={{ padding: 0 }}>
      <button ref={ref} className="card land" data-f data-lp={p.onLongPress ? '' : undefined} data-autofocus={p.autoFocus || undefined} onClick={p.onClick} aria-label={p.title} style={{ width: '100%' }}>
        <div className="thumb">
          {p.centerLogo !== undefined && !p.image ? (
            <div className="logo-center">
              <Img srcs={list(p.centerLogo)} contain label={p.title} alt={p.title} />
            </div>
          ) : (
            <Img srcs={[resizeTmdb(p.image, 'w780'), ...(p.fallbacks || [])]} label={p.title} alt={p.title} />
          )}
          {p.logo && (
            <span className="ch-logo-badge">
              <Img srcs={list(p.logo)} contain alt="" />
            </span>
          )}
          {p.badge && <span className={`badge ${p.badgeLive ? 'live' : ''}`}>{p.badge}</span>}
          {p.progress !== undefined && (
            <div className={`progress ${p.progressLight ? 'light' : ''}`}>
              <i style={{ width: `${Math.min(100, Math.max(1, p.progress * 100))}%` }} />
            </div>
          )}
        </div>
      </button>
      {p.onRemove && (
        <button className="remove-x" data-f onClick={p.onRemove} aria-label="remove">
          <IcClose width={14} height={14} />
        </button>
      )}
      <div className="meta">
        <div className="row">
          <div className="grow">
            <div className="title clamp2">{p.title}</div>
            {p.sub && <div className="sub ellipsis">{p.sub}</div>}
            {p.sub2 && <div className="sub dim ellipsis">{p.sub2}</div>}
          </div>
          {p.action}
        </div>
      </div>
    </div>
  );
});

export const Top10Card = memo(function Top10Card(p: Base & { rank: number; title: string; image?: string }) {
  return (
    <button className="card top10" data-f onClick={p.onClick} aria-label={`${p.rank}. ${p.title}`}>
      <span className="num">{p.rank}</span>
      <div className="thumb">
        <Img srcs={[resizeTmdb(p.image, 'w342')]} label={p.title} alt={p.title} />
      </div>
    </button>
  );
});

/** Home category shortcut: icon chip + label, in the app's surface style */
export const Tile = memo(function Tile(p: Base & { label: string; sub?: string; icon: ReactNode }) {
  return (
    <button className="card cat-card" data-f onClick={p.onClick}>
      <span className="ic">{p.icon}</span>
      <span className="txt">
        <span className="lb">{p.label}</span>
        {p.sub && <span className="sb">{p.sub}</span>}
      </span>
    </button>
  );
});

export const LogoTile = memo(function LogoTile(p: Base & { name: string; logo?: Srcs }) {
  const ref = useLongPress<HTMLButtonElement>(() => p.onLongPress?.());
  return (
    <button ref={ref} className="card logo-tile" data-f data-lp={p.onLongPress ? '' : undefined} onClick={p.onClick} aria-label={p.name} title={p.name}>
      <Img srcs={list(p.logo)} contain label={p.name} alt={p.name} />
    </button>
  );
});

/** IMDb rating tag (IMDb's yellow), on posters and detail pages */
export function ImdbBadge({ rating, votes, inline }: { rating: number; votes?: number; inline?: boolean }) {
  return (
    <span className={`imdb ${inline ? 'inline' : ''}`} title={votes ? `${votes.toLocaleString()} votes` : undefined}>
      <b>IMDb</b>
      {rating.toFixed(1)}
    </span>
  );
}
