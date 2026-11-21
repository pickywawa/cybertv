import Dexie, { type Table } from 'dexie';
import type {
  Category, Channel, Episode, Favorite, MetaRow, Movie, Profile, Program, Series, Source, WatchState,
} from './types';

export class CyberDB extends Dexie {
  profiles!: Table<Profile, string>;
  sources!: Table<Source, string>;
  categories!: Table<Category, string>;
  channels!: Table<Channel, string>;
  movies!: Table<Movie, string>;
  series!: Table<Series, string>;
  episodes!: Table<Episode, string>;
  programs!: Table<Program, number>;
  watch!: Table<WatchState, [string, string]>;
  favorites!: Table<Favorite, [string, string]>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super('cybertv');
    this.version(1).stores({
      profiles: 'id',
      sources: 'id, profileId',
      categories: 'id, sourceId, [profileId+kind]',
      channels: 'id, sourceId, profileId, groupKey, epgId, [profileId+universe]',
      movies: 'id, sourceId, profileId, groupKey, tmdbId, [profileId+addedAt], categoryId, enrichedAt',
      series: 'id, sourceId, profileId, groupKey, tmdbId, [profileId+addedAt], categoryId, enrichedAt',
      episodes: 'id, seriesId, sourceId',
      programs: '++id, [epgId+start], start',
      watch: '[profileId+key], profileId, [profileId+updatedAt]',
      favorites: '[profileId+key], profileId',
      meta: 'key',
    });
  }
}

export const db = new CyberDB();

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}
export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value, updatedAt: Date.now() });
}
