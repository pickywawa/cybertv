import { useEffect, useRef } from 'react';
import { db } from '@/core/db';
import type { PlayRequest } from '@/core/types';
import type { EngineState } from '@/core/player/engine';
import { traktScrobble, traktStatus, type ScrobbleTarget } from '@/core/trakt';

/** movies and episodes known to TMDB are reported to Trakt (start / pause / stop with progress) */
export function useTraktScrobble(req: PlayRequest, st: EngineState, profileId: string, durationSec: number) {
  const target = useRef<ScrobbleTarget | null>(null);
  const last = useRef<'start' | 'pause' | 'stop' | null>(null);
  const progress = useRef(0);
  progress.current = durationSec > 0 ? (st.position / durationSec) * 100 : 0;

  useEffect(() => {
    target.current = null;
    last.current = null;
    let off = false;
    void (async () => {
      if (req.kind !== 'movie' && req.kind !== 'episode') return;
      if (!(await traktStatus(profileId)).linked) return;
      let t: ScrobbleTarget | null = null;
      if (req.kind === 'movie') {
        const m = await db.movies.get(req.itemId);
        if (m?.tmdbId) t = { movie: { tmdb: m.tmdbId } };
      } else if (req.seriesId) {
        const [s, e] = await Promise.all([db.series.get(req.seriesId), db.episodes.get(req.itemId)]);
        if (s?.tmdbId && e) t = { episode: { showTmdb: s.tmdbId, season: e.season, number: e.episode } };
      }
      if (!off) target.current = t;
    })();
    return () => {
      off = true;
      // leaving the player: stop (Trakt marks it watched past 80 %)
      if (target.current && last.current && last.current !== 'stop') void traktScrobble(profileId, 'stop', target.current, progress.current);
    };
  }, [req.kind, req.itemId, req.seriesId, profileId]);

  useEffect(() => {
    const t = target.current;
    if (!t || !durationSec) return;
    const want = st.status === 'playing' ? 'start' : st.status === 'paused' ? 'pause' : st.status === 'ended' ? 'stop' : null;
    if (!want || want === last.current) return;
    last.current = want;
    void traktScrobble(profileId, want, t, want === 'stop' && st.status === 'ended' ? 100 : progress.current);
  }, [st.status, durationSec, profileId]);
}
