import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/state/store';
import { t, fmtTime } from '@/core/i18n';
import { db, getMeta } from '@/core/db';
import { searchWorker } from '@/core/workers';
import type { SearchHit } from '@/core/search';
import type { Channel, Movie, Program, Series } from '@/core/types';
import { isNative } from '@/core/platform';
import { CyberNative } from '@/core/native';
import { sortByLang } from '@/core/util/lang';
import { langPrefs } from '@/core/prefs';
import { dedupLang } from '@/core/repo';
import { PosterCard, LandCard, LogoTile } from '../components/Cards';
import { Rail } from '../components/Rail';
import { IcMic, IcSearch, IcClose } from '../icons';
import { openChannel, openMovie, openSeries, playChannel, prioritizeEnrichment } from '../actions';
import { ProgramSheet } from './Guide';

interface Results {
  channels: Channel[];
  movies: Movie[];
  series: Series[];
  programs: { p: Program; ch: Channel }[];
}

/** results of recent queries (typing back / reopening the tab is instant) */
const RESULTS = new Map<string, Results>();
function rememberResults(key: string, r: Results) {
  RESULTS.delete(key);
  RESULTS.set(key, r);
  if (RESULTS.size > 30) RESULTS.delete(RESULTS.keys().next().value!);
}

type SpeechRec = { lang: string; interimResults: boolean; start(): void; stop(): void; onresult: (e: any) => void; onend: () => void; onerror: () => void };

export function Search() {
  const profile = useApp((s) => s.profile)!;
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const toast = useApp((s) => s.toast);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Results | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [prog, setProg] = useState<{ p: Program; ch: Channel } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const epgVersion = useApp((s) => s.epgVersion);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setRes(null);
      return;
    }
    // same query seen earlier in the session: instant, refreshed below
    const memo = RESULTS.get(`${profile.id}|${settings.hideAdult}|${query}`);
    if (memo) setRes(memo);
    setBusy(true);
    let alive = true;
    const tm = setTimeout(async () => {
      const version = (await getMeta<number>(`catalog:version:${profile.id}`)) || 0;
      const hits: SearchHit[] = await searchWorker().search(profile.id, version, query);
      if (!alive) return;
      const ids = (k: SearchHit['kind']) => hits.filter((h) => h.kind === k).map((h) => h.id);
      const [channels, movies, series] = await Promise.all([db.channels.bulkGet(ids('live')), db.movies.bulkGet(ids('movie')), db.series.bulkGet(ids('series'))]);
      if (!alive) return;
      const hide = (u: string) => settings.hideAdult && u === 'adult';
      const prefs = langPrefs(profile);
      // titles first: shown as soon as they're known
      const base: Results = {
        channels: sortByLang((channels.filter(Boolean) as Channel[]).filter((c) => !hide(c.universe)), prefs),
        movies: dedupLang((movies.filter(Boolean) as Movie[]).filter((c) => !hide(c.universe)), prefs),
        series: dedupLang((series.filter(Boolean) as Series[]).filter((c) => !hide(c.universe)), prefs),
        programs: memo?.programs || [],
      };
      setRes(base);
      setBusy(false);
      rememberResults(`${profile.id}|${settings.hideAdult}|${query}`, base);
      // then TV programmes (separate index in the search worker)
      const progIds = await searchWorker().searchPrograms(query, epgVersion);
      if (!alive) return;
      const progRows = (await db.programs.bulkGet(progIds)).filter(Boolean) as Program[];
      const epgIds = [...new Set(progRows.map((p) => p.epgId))];
      const chs = epgIds.length ? await db.channels.where('epgId').anyOf(epgIds).filter((c) => c.profileId === profile.id).toArray() : [];
      const chByEpg = new Map(chs.map((c) => [c.epgId!, c]));
      const full: Results = { ...base, programs: progRows.filter((p) => chByEpg.has(p.epgId)).map((p) => ({ p, ch: chByEpg.get(p.epgId)! })) };
      if (!alive) return;
      rememberResults(`${profile.id}|${settings.hideAdult}|${query}`, full);
      setRes(full);
    }, memo ? 60 : 120);
    return () => {
      alive = false;
      clearTimeout(tm);
    };
  }, [q, profile.id, settings.hideAdult, epgVersion]);

  useEffect(() => {
    if (res) {
      prioritizeEnrichment('movie', res.movies.slice(0, 24));
      prioritizeEnrichment('series', res.series.slice(0, 24));
    }
  }, [res]);

  const remember = () => {
    const v = q.trim();
    if (v.length < 2) return;
    update({ recentSearches: [v, ...settings.recentSearches.filter((x) => x !== v)].slice(0, 8) });
  };

  const voice = async () => {
    if (isNative) {
      try {
        setListening(true);
        const r = await CyberNative.speech({ lang: profile.lang === 'fr' ? 'fr-FR' : 'en-US', prompt: t('search.listening') });
        if (r.text) setQ(r.text);
      } catch {
        toast(t('search.voiceUnavailable'));
      } finally {
        setListening(false);
      }
      return;
    }
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return toast(t('search.voiceUnavailable'));
    const rec: SpeechRec = new Ctor();
    rec.lang = profile.lang === 'fr' ? 'fr-FR' : 'en-US';
    rec.interimResults = true;
    rec.onresult = (e: any) => setQ(Array.from(e.results).map((r: any) => r[0].transcript).join(''));
    rec.onend = () => setListening(false);
    rec.onerror = () => (setListening(false), toast(t('search.voiceUnavailable')));
    setListening(true);
    rec.start();
  };

  const empty = res && !res.channels.length && !res.movies.length && !res.series.length && !res.programs.length;
  const total = useMemo(() => (res ? res.channels.length + res.movies.length + res.series.length : 0), [res]);

  return (
    <div className="tab-search">
      <div className="search-box" data-row>
        <IcSearch />
        <input
          ref={inputRef}
          className="search-input"
          data-f
          data-autofocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onBlur={remember}
          onKeyDown={(e) => e.key === 'Enter' && (remember(), (e.target as HTMLInputElement).blur())}
          placeholder={t('search.placeholder')}
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
        />
        {busy && <span className="spinner" />}
        {q && (
          <button className="icon-btn" data-f onClick={() => (setQ(''), inputRef.current?.focus())} aria-label={t('common.close')}>
            <IcClose />
          </button>
        )}
        <button className={`icon-btn mic ${listening ? 'listening' : ''}`} data-f onClick={() => void voice()} aria-label={t('search.voice')}>
          <IcMic />
        </button>
      </div>
      {listening && <div className="container muted" style={{ marginTop: 6 }}>{t('search.listening')}</div>}

      {!res && settings.recentSearches.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="container muted small" style={{ marginBottom: 8 }}>{t('search.recent')}</div>
          <div className="recent" data-row>
            {settings.recentSearches.map((s) => (
              <button key={s} className="chip active" data-f onClick={() => setQ(s)}>{s}</button>
            ))}
          </div>
        </div>
      )}

      {empty && <div className="empty">{t('search.noResult', { q })}</div>}
      {res && total > 0 && res.movies.length + res.series.length > 0 && (
        <section className="rail">
          <div className="rail-head"><h2 className="section-title">{t('search.movies')} & {t('search.series')}</h2></div>
          <div className="grid posters">
            {res.series.slice(0, 18).map((s) => <PosterCard imdb={s.imdbRating} key={s.id} title={s.title} sub={t('search.series')} image={s.poster} onClick={() => openSeries(s.id)} />)}
            {res.movies.slice(0, 60).map((m) => <PosterCard imdb={m.imdbRating} key={m.id} title={m.title} sub={m.year ? String(m.year) : undefined} image={m.poster} onClick={() => openMovie(m.id)} />)}
          </div>
        </section>
      )}
      {res && res.channels.length > 0 && (
        <Rail title={t('search.channels')}>
          {res.channels.slice(0, 30).map((c) => <LogoTile key={c.id} name={c.name} logo={[c.logo, c.logoAlt]} onClick={() => void playChannel(c)} onLongPress={() => openChannel(c.id)} />)}
        </Rail>
      )}
      {res && res.programs.length > 0 && (
        <Rail title={t('search.programs')}>
          {res.programs.map(({ p, ch }) => (
            <LandCard key={`${p.epgId}${p.start}`} title={p.title} sub={`${ch.name} · ${fmtTime(p.start)}`} image={p.icon} centerLogo={[ch.logo, ch.logoAlt]} onClick={() => setProg({ p, ch })} />
          ))}
        </Rail>
      )}
      {prog && <ProgramSheet ch={prog.ch} p={prog.p} onClose={() => setProg(null)} />}
    </div>
  );
}
