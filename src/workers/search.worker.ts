/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { db } from '@/core/db';
import { SearchIndex, type SearchDoc } from '@/core/search';

const index = new SearchIndex();
let loadedFor = '';

async function ensure(profileId: string, version: number) {
  const key = `${profileId}:${version}`;
  if (loadedFor === key) return;
  const docs: SearchDoc[] = [];
  await db.channels.where('profileId').equals(profileId).each((c) => docs.push({ kind: 'live', id: c.id, groupKey: c.groupKey, title: c.name }));
  await db.movies.where('profileId').equals(profileId).each((m) =>
    docs.push({ kind: 'movie', id: m.id, groupKey: m.groupKey, title: m.title, extra: [m.year, ...(m.cast || []).slice(0, 4), m.director].filter(Boolean).join(' ') }),
  );
  await db.series.where('profileId').equals(profileId).each((s) =>
    docs.push({ kind: 'series', id: s.id, groupKey: s.groupKey, title: s.title, extra: [s.year, ...(s.cast || []).slice(0, 4)].filter(Boolean).join(' ') }),
  );
  index.load(docs);
  loadedFor = key;
}

const api = {
  async search(profileId: string, version: number, q: string) {
    await ensure(profileId, version);
    return index.search(q);
  },
  async warm(profileId: string, version: number) {
    await ensure(profileId, version);
    return index.size;
  },
};

export type SearchApi = typeof api;
Comlink.expose(api);
