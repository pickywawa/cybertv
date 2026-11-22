/**
 * Free replay catalogues of public broadcasters (ARTE, france.tv), read from their public APIs.
 * Ids carry the provider: `arte:117142-000-A` (video), `arte:RC-027966` (collection / series),
 * `ftv:<si_id>` (video), `ftvp:<program_path>` (show).
 */
export type ReplayProvider = 'arte' | 'francetv' | 'youtube';

export interface ReplayItem {
  id: string;
  provider: ReplayProvider;
  /** a playable video, or a show / collection that lists episodes */
  kind: 'video' | 'show';
  title: string;
  subtitle?: string;
  desc?: string;
  /** 16:9 picture */
  image?: string;
  durationSec?: number;
  /** end of availability (ms) */
  expires?: number;
  /** broadcaster shown on the card ("ARTE", "France 2") */
  channel?: string;
  genre?: string;
  /** minimum age (0 = all audiences) */
  age?: number;
  season?: number;
  episode?: number;
  /** youth catalogue (Okoo): kept apart for the kids filter / a future kids mode */
  kids?: boolean;
  /** YouTube: publication date (ms) and view count */
  published?: number;
  views?: number;
}

export interface ReplayRail {
  id: string;
  provider: ReplayProvider;
  title: string;
  items: ReplayItem[];
  kids?: boolean;
}

export interface ReplayCatalog {
  at: number;
  hero: ReplayItem[];
  rails: ReplayRail[];
  /** youth catalogue (Okoo) */
  kids: ReplayRail[];
  kidsHero: ReplayItem[];
  /** YouTube channels of broadcasters and media, by theme */
  youtube?: ReplayRail[];
  /** providers that could not be read (network, geo-blocking) */
  failed: ReplayProvider[];
}

export interface ReplayShow {
  item: ReplayItem;
  seasons: { title: string; items: ReplayItem[] }[];
}

export interface ResolvedStream {
  url: string;
  label: string;
}
