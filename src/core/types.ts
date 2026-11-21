export type SourceType = 'm3u' | 'xtream';
export type Universe =
  | 'general' | 'sport' | 'cinema' | 'kids' | 'news' | 'series' | 'docs' | 'ent' | 'music' | 'adult' | 'other';
export type Quality = 'SD' | 'HD' | 'FHD' | '4K' | 'HEVC' | null;
export type CatchupMode = 'xc' | 'default' | 'append' | 'shift' | 'flussonic' | null;
export type ThemeId = 'night' | 'oled' | 'light' | 'midnight';
export type Lang = 'fr' | 'en';

export interface Profile {
  id: string;
  name: string;
  color: string;
  emoji: string;
  lang: Lang;
  theme: ThemeId;
  accent?: string;
  /** optional profile lock */
  pin?: string;
  /** parental control for the Adult universe */
  parental: { enabled: boolean; pin?: string };
  hasTmdb: boolean;
  /** ISO 3166 country (channel ranking, TMDB region) */
  country?: string;
  /** preferred audio languages (ISO 639-1): [primary, secondary?] */
  audioLangs?: string[];
  /** preferred subtitle languages: [primary, secondary?] */
  subLangs?: string[];
  /** when to show subtitles: never, only when the audio isn't a preferred language, always */
  subMode?: 'off' | 'auto' | 'always';
  createdAt: number;
  lastSyncAt?: number;
}

export interface XtreamAccount {
  expiresAt?: number;
  maxConn?: number;
  activeCons?: number;
  formats?: string[];
  timezone?: string;
  status?: string;
}

export interface Source {
  id: string;
  profileId: string;
  type: SourceType;
  label: string;
  priority: number;
  enabled: boolean;
  /** m3u: playlist url. xtream: server base url */
  url: string;
  username?: string;
  /** password lives in the secure store, never in IndexedDB */
  epgUrls: string[];
  status: 'unknown' | 'ok' | 'degraded' | 'down';
  lastSyncAt?: number;
  lastError?: string;
  account?: XtreamAccount;
  counts?: { live: number; vod: number; series: number };
}

export interface Category {
  id: string;
  sourceId: string;
  profileId: string;
  kind: 'live' | 'vod' | 'series';
  name: string;
  universe: Universe;
  order: number;
}

export interface Channel {
  id: string;
  sourceId: string;
  profileId: string;
  extId: string;
  rawName: string;
  name: string;
  logo?: string;
  categoryId?: string;
  universe: Universe;
  epgId?: string;
  catchupDays: number;
  catchupMode: CatchupMode;
  catchupSource?: string;
  quality: Quality;
  groupKey: string;
  num: number;
  /** m3u only: direct stream url */
  url?: string;
  /** audio languages detected from the name / category / EPG id */
  langs?: string[];
  /** ISO country guessed from prefix / EPG id */
  country?: string;
}

export interface Movie {
  id: string;
  sourceId: string;
  profileId: string;
  extId: string;
  rawName: string;
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  logo?: string;
  plot?: string;
  rating?: number;
  durationSec?: number;
  genres?: string[];
  cast?: string[];
  director?: string;
  trailer?: string;
  tmdbId?: number;
  addedAt: number;
  ext: string;
  categoryId?: string;
  universe: Universe;
  groupKey: string;
  enrichedAt?: number;
  url?: string;
  /** audio languages (provider tags, then learned from the real tracks once played) */
  langs?: string[];
  subs?: string[];
  /** TMDB original language */
  origLang?: string;
  /** set when langs/subs come from the actual stream tracks */
  tracksAt?: number;
}

export interface Series {
  id: string;
  sourceId: string;
  profileId: string;
  extId: string;
  rawName: string;
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  logo?: string;
  plot?: string;
  rating?: number;
  genres?: string[];
  cast?: string[];
  trailer?: string;
  tmdbId?: number;
  addedAt: number;
  categoryId?: string;
  universe: Universe;
  groupKey: string;
  enrichedAt?: number;
  episodesLoadedAt?: number;
  langs?: string[];
  subs?: string[];
  origLang?: string;
}

export interface Episode {
  id: string;
  seriesId: string;
  sourceId: string;
  extId: string;
  season: number;
  episode: number;
  title: string;
  plot?: string;
  still?: string;
  durationSec?: number;
  ext: string;
  url?: string;
}

export interface Program {
  id?: number;
  epgId: string;
  start: number;
  stop: number;
  title: string;
  subTitle?: string;
  desc?: string;
  category?: string;
  icon?: string;
  episodeNum?: string;
}

export type ItemKind = 'live' | 'movie' | 'series' | 'episode';

export interface WatchState {
  profileId: string;
  key: string;
  kind: ItemKind;
  itemId: string;
  seriesId?: string;
  title: string;
  subtitle?: string;
  image?: string;
  positionSec: number;
  durationSec: number;
  completed: boolean;
  updatedAt: number;
}

export interface Favorite {
  profileId: string;
  key: string;
  kind: ItemKind;
  itemId: string;
  order: number;
  addedAt: number;
}

export interface MetaRow {
  key: string;
  value: unknown;
  updatedAt: number;
}

/** A list fetched from TMDB (trending, popular…) stored to build home rails */
export interface TmdbListItem {
  tmdbId: number;
  title: string;
  year?: number;
  poster?: string;
  backdrop?: string;
}

export interface SyncProgress {
  sourceId?: string;
  step: 'start' | 'live' | 'vod' | 'series' | 'epg' | 'enrich' | 'done' | 'error';
  message?: string;
  count?: number;
}

/** Everything a playback needs, resolved on the main thread */
export interface PlayRequest {
  kind: ItemKind;
  itemId: string;
  title: string;
  subtitle?: string;
  image?: string;
  logo?: string;
  /** ordered candidate urls (fallback chain) */
  candidates: { url: string; label: string; quality: Quality; sourceId: string }[];
  startAt?: number;
  live?: boolean;
  /** catch-up playback of a past/current program */
  catchup?: { start: number; stop: number };
  channelId?: string;
  seriesId?: string;
  durationSec?: number;
  /** channel ids available for zapping (current TV list) */
  zapList?: string[];
}
