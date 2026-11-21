/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { db, getMeta, setMeta } from '@/core/db';
import { SearchIndex, type SearchDoc } from '@/core/search';
import { norm } from '@/core/util/text';

/**
 * Search runs on the index it already has (stale-while-revalidate): a newer catalogue version
 * rebuilds it in the background, the next keystroke uses the fresh one. The compact document list
 * is saved in IndexedDB so a cold start searches at once instead of re-reading every title.
 */
/** swapped atomically once a rebuild is complete: searches never wait for it */
let index = new SearchIndex();
let current: { profileId: string; version: number } | null = null;
let building: Promise<void> | null = null;

const snapKey = (profileId: string) => `search:docs:${profileId}`;

async function build(profileId: string, version: number) {
  const docs: SearchDoc[] = [];
  // read in pages so searches can run between them
  const pages = async <T>(table: any, map: (x: T) => void) => {
    let offset = 0;
    for (;;) {
      const rows: T[] = await table.where('profileId').equals(profileId).offset(offset).limit(3000).toArray();
      rows.forEach(map);
      if (rows.length < 3000) break;
      offset += rows.length;
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  await pages<any>(db.channels, (c) => docs.push({ kind: 'live', id: c.id, groupKey: c.groupKey, title: c.name }));
  await pages<any>(db.movies, (m) =>
    docs.push({ kind: 'movie', id: m.id, groupKey: m.groupKey, title: m.title, extra: [m.year, ...(m.cast || []).slice(0, 4), m.director].filter(Boolean).join(' ') }),
  );
  await pages<any>(db.series, (s) =>
    docs.push({ kind: 'series', id: s.id, groupKey: s.groupKey, title: s.title, extra: [s.year, ...(s.cast || []).slice(0, 4)].filter(Boolean).join(' ') }),
  );
  const next = new SearchIndex();
  await next.loadAsync(docs);
  index = next;
  current = { profileId, version };
  // without the precomputed `n` (rebuilt on load)
  void setMeta(snapKey(profileId), { version, docs: docs.map(({ n: _n, ...d }) => d) }).catch(() => {});
}

function rebuildLater(profileId: string, version: number) {
  if (building) return;
  building = build(profileId, version).finally(() => {
    building = null;
  });
}

async function ensure(profileId: string, version: number) {
  if (current?.profileId === profileId) {
    if (current.version !== version) rebuildLater(profileId, version);
    return;
  }
  // first search of the session: the saved index answers right away
  const snap = await getMeta<{ version: number; docs: SearchDoc[] }>(snapKey(profileId));
  if (snap?.docs?.length) {
    const next = new SearchIndex();
    next.load(snap.docs);
    index = next;
    current = { profileId, version: snap.version };
    if (snap.version !== version) rebuildLater(profileId, version);
    return;
  }
  if (building) await building;
  if (current?.profileId !== profileId) await build(profileId, version);
}

// ─────────── TV programmes (now → +24 h), indexed apart, refreshed every 20 min ───────────
interface ProgDoc {
  id?: number;
  epgId: string;
  start: number;
  stop: number;
  n: string;
}
let progs: { at: number; epgVersion: number; docs: ProgDoc[] } | null = null;
let progBuilding: Promise<void> | null = null;

async function buildProgs(epgVersion: number) {
  const now = Date.now();
  const docs: ProgDoc[] = [];
  await db.programs
    .where('start')
    .between(now - 3 * 3600000, now + 24 * 3600000)
    .each((p) => {
      if (p.stop > now) docs.push({ id: p.id, epgId: p.epgId, start: p.start, stop: p.stop, n: ' ' + norm(p.title) + ' ' });
    });
  progs = { at: now, epgVersion, docs };
}

const api = {
  async search(profileId: string, version: number, q: string) {
    await ensure(profileId, version);
    return index.search(q);
  },
  async warm(profileId: string, version: number) {
    await ensure(profileId, version);
    if (!progs) void buildProgs(0);
    return index.size;
  },
  /** programme ids whose title matches, soonest first */
  async searchPrograms(q: string, epgVersion: number, limit = 40): Promise<number[]> {
    const stale = !progs || progs.epgVersion !== epgVersion || Date.now() - progs.at > 20 * 60000;
    if (stale && !progBuilding) progBuilding = buildProgs(epgVersion).finally(() => (progBuilding = null));
    if (!progs) await progBuilding;
    const tokens = norm(q).split(' ').filter(Boolean);
    if (!tokens.length || !progs) return [];
    const now = Date.now();
    const out: ProgDoc[] = [];
    for (const d of progs.docs) {
      if (d.stop <= now) continue;
      if (tokens.every((t) => d.n.includes(' ' + t) || (t.length >= 3 && d.n.includes(t)))) out.push(d);
    }
    out.sort((a, b) => a.start - b.start);
    return out.slice(0, limit).map((d) => d.id!).filter((x) => x !== undefined);
  },
};

export type SearchApi = typeof api;
Comlink.expose(api);
