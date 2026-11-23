import { createContext, useContext, useEffect, useRef, useState, type DependencyList } from 'react';
import { useApp } from '@/state/store';

/**
 * Last result of each keyed query, kept across tab switches (screens remount on every switch):
 * a revisited screen renders its previous content at once while the query refreshes it.
 */
const MEM = new Map<string, unknown>();
const MEM_MAX = 60;

export function primeCache(key: string, value: unknown) {
  MEM.delete(key);
  MEM.set(key, value);
  if (MEM.size > MEM_MAX) MEM.delete(MEM.keys().next().value!);
}
export function cached<T>(key: string): T | undefined {
  return MEM.get(key) as T | undefined;
}

/**
 * false for a screen that is covered (the tab under a film page, everything under the player):
 * its queries don't follow catalogue / guide updates until it is shown again — on a TV box, the
 * Home recomputed behind a film page every few seconds while TMDB enrichment was running.
 */
export const ScreenActive = createContext(true);

/**
 * Async query re-run on deps change and whenever the catalog version bumps (visible screens only).
 * With `key`, the previous result is shown immediately (stale-while-revalidate).
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, opts: { epg?: boolean; key?: string } = {}): T | undefined {
  const active = useContext(ScreenActive);
  const liveCatalog = useApp((s) => s.catalogVersion);
  const liveEpg = useApp((s) => (opts.epg ? s.epgVersion : 0));
  const versions = useRef({ c: liveCatalog, e: liveEpg });
  if (active) versions.current = { c: liveCatalog, e: liveEpg };
  const { c: catalogVersion, e: epgVersion } = versions.current;
  const [v, setV] = useState<T | undefined>(() => (opts.key ? cached<T>(opts.key) : undefined));
  const seq = useRef(0);
  const applied = useRef(0);
  const running = useRef(false);
  const again = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const lastKey = useRef(opts.key);
  if (opts.key !== lastKey.current) {
    // another query (e.g. other filter): show its cached result, never the previous query's
    lastKey.current = opts.key;
    const c = opts.key ? cached<T>(opts.key) : undefined;
    if (c !== v) setV(c);
  }
  useEffect(() => {
    /**
     * One run at a time: while a slow query runs (big guide on a phone, sync writing the guide),
     * new triggers only ask for one more run afterwards. A result is shown as long as it is the
     * newest one for the current key — a slow query is never thrown away just because data moved.
     */
    const go = () => {
      if (running.current) {
        again.current = true;
        return;
      }
      running.current = true;
      const id = ++seq.current;
      const key = lastKey.current;
      fnRef.current()
        .then(
          (r) => {
            if (key !== lastKey.current || id <= applied.current) return;
            applied.current = id;
            if (key) primeCache(key, r);
            setV(r);
          },
          (e) => console.warn('[query]', e),
        )
        .finally(() => {
          running.current = false;
          if (again.current) {
            again.current = false;
            go();
          }
        });
    };
    go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, opts.key, catalogVersion, epgVersion]);
  return v;
}

/** current time, refreshed every `ms` (aligned to the minute by default) */
export function useNow(ms = 30000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useLongPress<T extends HTMLElement>(cb: () => void) {
  const ref = useRef<T>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = () => cbRef.current();
    el.addEventListener('longpress', h);
    return () => el.removeEventListener('longpress', h);
  }, []);
  return ref;
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const h = () => setM(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [q]);
  return m;
}
