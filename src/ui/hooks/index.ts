import { useEffect, useRef, useState, type DependencyList } from 'react';
import { useApp } from '@/state/store';

/** Async query re-run on deps change and whenever the catalog version bumps */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, opts: { epg?: boolean } = {}): T | undefined {
  const catalogVersion = useApp((s) => s.catalogVersion);
  const epgVersion = useApp((s) => (opts.epg ? s.epgVersion : 0));
  const [v, setV] = useState<T>();
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    fn().then(
      (r) => id === seq.current && setV(r),
      (e) => console.warn('[query]', e),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, catalogVersion, epgVersion]);
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
