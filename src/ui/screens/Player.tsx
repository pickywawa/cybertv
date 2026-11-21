import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerEngine, EngineState, EngineTracks } from '@/core/player/engine';
import { initialState } from '@/core/player/engine';
import { WebEngine } from '@/core/player/web';
import { NativeEngine } from '@/core/player/native';
import { isNative, isTvMode, isTouch } from '@/core/platform';
import { CyberNative } from '@/core/native';
import { db } from '@/core/db';
import type { Channel, PlayRequest, Program } from '@/core/types';
import { catchupCandidates, nextEpisode, playChannelRequest, playEpisodeRequest } from '@/core/playback';
import { canCatchup } from '@/core/sources/urls';
import { nowNext, programsFor, saveProgress } from '@/core/repo';
import { fmtDuration, fmtTime, t } from '@/core/i18n';
import { useApp } from '@/state/store';
import { langPrefs, subMode } from '@/core/prefs';
import { toLang } from '@/core/util/lang';
import { focusEl, focusFirst, setKeyInterceptor } from '../spatial';
import { Img } from '../components/Img';
import { Menu } from '../components/Overlay';
import {
  IcAudio, IcBack10, IcClose, IcFwd10, IcHistory, IcInfo, IcPause, IcPip, IcPlay, IcRestart, IcSettings, IcSubtitles, IcTv,
  IcFullscreen, IcExitFullscreen, IcSpeed, IcAspect, IcHd,
} from '../icons';

type Mode = 'live' | 'shift' | 'vod';
type Panel = null | 'channels' | 'programs' | 'settings' | 'info';

const HIDE_MS = 4500;
const STALL_MS = 14000;

export function Player({ req }: { req: PlayRequest }) {
  const profile = useApp((s) => s.profile)!;
  const playStore = useApp((s) => s.play);
  const toast = useApp((s) => s.toast);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PlayerEngine | null>(null);
  const [st, setSt] = useState<EngineState>(initialState);
  const [mode, setMode] = useState<Mode>(req.kind === 'live' ? (req.catchup ? 'shift' : 'live') : 'vod');
  const [shiftStart, setShiftStart] = useState<number>(req.catchup?.start ?? 0);
  const [cands, setCands] = useState(req.candidates);
  const [candIdx, setCandIdx] = useState(0);
  const [fatal, setFatal] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  const [panel, setPanel] = useState<Panel>(null);
  const [tracks, setTracks] = useState<EngineTracks>({ audio: [], text: [], video: [] });
  const [channel, setChannel] = useState<Channel | null>(null);
  const [prog, setProg] = useState<{ now?: Program; next?: Program }>({});
  const [chanProgs, setChanProgs] = useState<Program[]>([]);
  const [zapChannels, setZapChannels] = useState<Channel[]>([]);
  const [zapNow, setZapNow] = useState<Map<string, { now?: Program }>>(new Map());
  const [numBuf, setNumBuf] = useState('');
  const [banner, setBanner] = useState(false);
  const [fit, setFit] = useState<'fit' | 'fill' | 'zoom'>('fit');
  const [rate, setRate] = useState(1);
  const [nextEp, setNextEp] = useState<{ count: number } | null>(null);
  const [gesture, setGesture] = useState<{ side: 'l' | 'r'; text: string } | null>(null);
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  const [now, setNow] = useState(Date.now());
  const hideTimer = useRef<number>(0);
  const stallTimer = useRef<number>(0);
  const lastPos = useRef(0);
  const pausedAt = useRef<number | null>(null);
  const prevChannel = useRef<string | null>(null);
  const stRef = useRef(st);
  stRef.current = st;

  // ───────── engine lifecycle ─────────
  useEffect(() => {
    const eng: PlayerEngine = isNative ? new NativeEngine() : new WebEngine(videoRef.current!);
    engineRef.current = eng;
    eng.onState((s) => setSt(s));
    eng.onTracks(() => void eng.tracks().then(setTracks));
    if (isNative && !isTvMode()) {
      void CyberNative.setOrientation({ mode: 'landscape' }).catch(() => {});
      void CyberNative.setImmersive({ on: true }).catch(() => {});
    }
    return () => {
      eng.destroy();
      engineRef.current = null;
      if (isNative && !isTvMode()) {
        void CyberNative.setOrientation({ mode: 'auto' }).catch(() => {});
        void CyberNative.setImmersive({ on: false }).catch(() => {});
      }
    };
  }, []);

  // new request (initial or zap)
  useEffect(() => {
    setCands(req.candidates);
    setCandIdx(0);
    setFatal(false);
    setMode(req.kind === 'live' ? (req.catchup ? 'shift' : 'live') : 'vod');
    setShiftStart(req.catchup?.start ?? 0);
    setNextEp(null);
    pausedAt.current = null;
    if (!req.candidates.length) setFatal(true);
  }, [req]);

  // load current candidate
  useEffect(() => {
    const eng = engineRef.current;
    const c = cands[candIdx];
    if (!eng || !c) return;
    lastPos.current = -1;
    void eng.load(c.url, { startAt: candIdx === 0 ? req.startAt : undefined, live: mode === 'live' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cands, candIdx]);

  // ───────── language-aware track selection + learning the real languages of a movie ─────────
  const autoTracksFor = useRef('');
  useEffect(() => {
    const eng = engineRef.current;
    const c = cands[candIdx];
    if (!eng || !c || !tracks.audio.length && !tracks.text.length) return;
    if (autoTracksFor.current === c.url) return;
    autoTracksFor.current = c.url;
    const prefs = langPrefs(profile);
    const audioLangs = [...new Set(tracks.audio.map((a) => toLang(a.language || a.label)).filter(Boolean) as string[])];
    const subLangs = [...new Set(tracks.text.map((a) => toLang(a.language || a.label)).filter(Boolean) as string[])];
    // audio: best track in the preferred languages
    let audio = tracks.audio.find((a) => a.selected);
    const curLang = toLang(audio?.language || audio?.label);
    if (tracks.audio.length > 1 && !(curLang && prefs.audio.includes(curLang))) {
      for (const l of prefs.audio) {
        const hit = tracks.audio.find((a) => toLang(a.language || a.label) === l);
        if (hit) {
          eng.selectTrack('audio', hit.id);
          audio = hit;
          break;
        }
      }
    }
    // subtitles: 'auto' only when the audio isn't a language the user understands
    const mode = subMode(profile);
    const aLang = toLang(audio?.language || audio?.label);
    const foreign = !!aLang && !prefs.audio.includes(aLang);
    if (tracks.text.length && !tracks.text.some((x) => x.selected) && (mode === 'always' || (mode === 'auto' && foreign))) {
      for (const l of prefs.subs) {
        const hit = tracks.text.find((x) => toLang(x.language || x.label) === l);
        if (hit) {
          eng.selectTrack('text', hit.id);
          break;
        }
      }
    }
    // remember what the stream really contains (flags on the detail page, language ranking)
    if (req.kind === 'movie' && audioLangs.length && c.url === cands[candIdx]?.url && candIdx === 0) {
      void db.movies.update(req.itemId, { langs: audioLangs, subs: subLangs, tracksAt: Date.now() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks]);

  const nextCandidate = useCallback(() => {
    setCandIdx((i) => {
      if (i + 1 < cands.length) {
        toast(t('player.fallback', { label: cands[i + 1].label }));
        return i + 1;
      }
      setFatal(true);
      return i;
    });
  }, [cands, toast]);

  // errors & stall watchdog → fallback chain
  useEffect(() => {
    if (st.status === 'error') {
      nextCandidate();
      return;
    }
    clearTimeout(stallTimer.current);
    if (st.status === 'loading' || st.status === 'buffering') {
      const pos = st.position;
      stallTimer.current = window.setTimeout(() => {
        if (stRef.current.position === pos && (stRef.current.status === 'loading' || stRef.current.status === 'buffering')) nextCandidate();
      }, STALL_MS);
    }
    return () => clearTimeout(stallTimer.current);
  }, [st.status, st.position, nextCandidate]);

  // ───────── live context: channel, EPG, zap list ─────────
  useEffect(() => {
    if (!req.channelId) {
      setChannel(null);
      return;
    }
    void db.channels.get(req.channelId).then((c) => setChannel(c || null));
  }, [req.channelId]);

  useEffect(() => {
    const t1 = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t1);
  }, []);

  const minute = Math.floor(now / 60000);
  useEffect(() => {
    if (!channel?.epgId) {
      setProg({});
      setChanProgs([]);
      return;
    }
    const d0 = new Date();
    d0.setHours(0, 0, 0, 0);
    void programsFor(channel.epgId, d0.getTime() - 86400000, Date.now() + 86400000).then((list) => {
      setChanProgs(list);
      const at = Date.now();
      setProg({ now: list.find((p) => p.start <= at && p.stop > at), next: list.find((p) => p.start > at) });
    });
  }, [channel, minute]);

  useEffect(() => {
    if (!req.zapList?.length) return;
    void db.channels.bulkGet(req.zapList).then((l) => setZapChannels(l.filter(Boolean) as Channel[]));
  }, [req.zapList]);

  useEffect(() => {
    if (panel === 'channels') void nowNext().then(setZapNow);
  }, [panel]);

  // ───────── timeline ─────────
  const catchupOk = !!channel && canCatchup(channel);
  const playhead = mode === 'live' ? now : mode === 'shift' ? shiftStart + st.position * 1000 : 0;
  const progAtHead = useMemo(
    () => (mode === 'vod' ? undefined : chanProgs.find((p) => p.start <= playhead && p.stop > playhead) || (mode === 'live' ? prog.now : undefined)),
    [chanProgs, playhead, mode, prog.now],
  );
  const winStart = progAtHead?.start ?? (mode === 'shift' ? shiftStart : now - 3600000);
  const winEnd = progAtHead?.stop ?? (mode === 'shift' ? Math.max(now, shiftStart + 3600000) : now + 600000);

  const goLive = useCallback(async () => {
    if (!channel) return;
    const r = await playChannelRequest(channel, prog.now);
    setMode('live');
    setCands(r.candidates);
    setCandIdx(0);
    setFatal(false);
  }, [channel, prog.now]);

  const goShift = useCallback(
    async (at: number) => {
      if (!channel || !catchupOk) return false;
      const target = Math.max(at, Date.now() - channel.catchupDays * 86400000);
      if (target > Date.now() - 20000) {
        await goLive();
        return true;
      }
      const end = chanProgs.find((p) => p.start <= target && p.stop > target)?.stop ?? target + 3 * 3600000;
      const c = await catchupCandidates(channel.id, target, Math.max(end, target + 3600000));
      if (!c.length) return false;
      setMode('shift');
      setShiftStart(target);
      setCands(c);
      setCandIdx(0);
      setFatal(false);
      return true;
    },
    [channel, catchupOk, chanProgs, goLive],
  );

  // ───────── commands ─────────
  const eng = () => engineRef.current;
  const togglePlay = useCallback(() => {
    const e = eng();
    if (!e) return;
    if (stRef.current.status === 'playing' || stRef.current.status === 'buffering') {
      e.pause();
      if (mode === 'live') pausedAt.current = Date.now();
    } else {
      if (mode === 'live' && pausedAt.current && Date.now() - pausedAt.current > 20000 && catchupOk) {
        const at = pausedAt.current;
        pausedAt.current = null;
        void goShift(at);
        return;
      }
      pausedAt.current = null;
      e.play();
    }
  }, [mode, catchupOk, goShift]);

  const seekBy = useCallback(
    (delta: number) => {
      const e = eng();
      if (!e) return;
      const s = stRef.current;
      if (mode === 'vod') {
        e.seek(s.position + delta);
        return;
      }
      if (mode === 'shift') {
        const target = shiftStart + (s.position + delta) * 1000;
        if (target > Date.now() - 20000) void goLive();
        else if (target >= shiftStart) e.seek(s.position + delta);
        else void goShift(target);
        return;
      }
      // live: DVR window first, then catch-up
      if (delta < 0 && catchupOk) {
        void goShift(Date.now() + delta * 1000);
        return;
      }
      if (s.seekableEnd > s.seekableStart) e.seek(Math.min(s.seekableEnd, Math.max(s.seekableStart, s.position + delta)));
    },
    [mode, shiftStart, catchupOk, goLive, goShift],
  );

  const seekToRatio = useCallback(
    (r: number) => {
      const e = eng();
      if (!e) return;
      const s = stRef.current;
      if (mode === 'vod') {
        if (s.duration) e.seek(r * s.duration);
        return;
      }
      const target = winStart + r * (winEnd - winStart);
      if (mode === 'shift' && target >= shiftStart && (target - shiftStart) / 1000 <= Math.max(s.duration, s.buffered)) e.seek((target - shiftStart) / 1000);
      else void goShift(target);
    },
    [mode, winStart, winEnd, shiftStart, goShift],
  );

  const startOver = useCallback(() => {
    const p = progAtHead || prog.now;
    if (p) void goShift(p.start);
  }, [progAtHead, prog.now, goShift]);

  const zapTo = useCallback(
    async (ch: Channel) => {
      if (!ch || ch.id === channel?.id) return;
      prevChannel.current = channel?.id || null;
      const pn = (await nowNext()).get(ch.epgId || '')?.now;
      const r = await playChannelRequest(ch, pn);
      setPanel(null);
      setBanner(true);
      playStore({ ...r, zapList: req.zapList });
    },
    [channel, playStore, req.zapList],
  );

  const zapBy = useCallback(
    (d: number) => {
      if (!zapChannels.length || !channel) return;
      const i = zapChannels.findIndex((c) => c.groupKey === channel.groupKey);
      const n = zapChannels[(i + d + zapChannels.length) % zapChannels.length];
      void zapTo(n);
    },
    [zapChannels, channel, zapTo],
  );

  // ───────── UI visibility ─────────
  const poke = useCallback(() => {
    setUiVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (stRef.current.status === 'playing') setUiVisible(false);
    }, HIDE_MS);
  }, []);
  useEffect(() => {
    poke();
    return () => clearTimeout(hideTimer.current);
  }, [poke]);
  useEffect(() => {
    if (st.status !== 'playing') setUiVisible(true);
    else poke();
  }, [st.status, poke]);
  useEffect(() => {
    if (!banner) return;
    const tm = setTimeout(() => setBanner(false), 4000);
    return () => clearTimeout(tm);
  }, [banner, req]);
  useEffect(() => {
    if (uiVisible && !panel) requestAnimationFrame(() => {
      const root = rootRef.current;
      if (root && !root.contains(document.activeElement)) focusEl(root.querySelector<HTMLElement>('[data-play]'), false);
    });
  }, [uiVisible, panel]);
  useEffect(() => {
    if (panel) requestAnimationFrame(() => rootRef.current && focusFirst(rootRef.current.querySelector('.panel')!));
  }, [panel]);

  // number zapping
  useEffect(() => {
    if (!numBuf) return;
    const tm = setTimeout(() => {
      const n = parseInt(numBuf, 10);
      const target = zapChannels.find((c) => c.num === n) || zapChannels[n - 1];
      if (target) void zapTo(target);
      setNumBuf('');
    }, 1400);
    return () => clearTimeout(tm);
  }, [numBuf, zapChannels, zapTo]);

  // ───────── keys ─────────
  useEffect(() => {
    setKeyInterceptor((e) => {
      const k = e.key;
      if (k === 'MediaPlayPause' || k === ' ' && !panel) return togglePlay(), poke(), true;
      if (k === 'MediaPlay') return eng()?.play(), true;
      if (k === 'MediaPause') return eng()?.pause(), true;
      if (k === 'MediaFastForward' || k === 'MediaTrackNext') return seekBy(30), poke(), true;
      if (k === 'MediaRewind' || k === 'MediaTrackPrevious') return seekBy(-30), poke(), true;
      if (k === 'ChannelUp' || k === 'PageUp') return zapBy(-1), true;
      if (k === 'ChannelDown' || k === 'PageDown') return zapBy(1), true;
      if (/^[0-9]$/.test(k) && channel && !panel && !(document.activeElement instanceof HTMLInputElement)) {
        setNumBuf((b) => (b + k).slice(-4));
        return true;
      }
      if (panel) return false;
      if (!uiVisible) {
        if (k === 'ArrowUp' && mode !== 'vod') return zapBy(-1), true;
        if (k === 'ArrowDown' && mode !== 'vod') return zapBy(1), true;
        if (k === 'ArrowLeft') return seekBy(-10), poke(), true;
        if (k === 'ArrowRight') return seekBy(10), poke(), true;
        if (k === 'Enter') return poke(), true;
        return false;
      }
      poke();
      return false;
    });
    return () => setKeyInterceptor(null);
  }, [panel, uiVisible, mode, channel, togglePlay, seekBy, zapBy, poke]);

  // back: close panel, else close the player
  useEffect(() => {
    const onBack = (e: Event) => {
      if (panel) {
        e.preventDefault();
        setPanel(null);
        return;
      }
      if (isTvMode() && uiVisible && st.status === 'playing') {
        e.preventDefault();
        setUiVisible(false);
      }
    };
    window.addEventListener('cyber:player-back', onBack);
    return () => window.removeEventListener('cyber:player-back', onBack);
  }, [panel, uiVisible, st.status]);

  // ───────── progress persistence & next episode ─────────
  useEffect(() => {
    if (mode !== 'vod' || !st.duration) return;
    if (Math.abs(st.position - lastPos.current) < 10 && st.status !== 'paused' && st.status !== 'ended') return;
    lastPos.current = st.position;
    void saveProgress({
      profileId: profile.id,
      key: `${req.kind}:${req.itemId}`,
      kind: req.kind,
      itemId: req.itemId,
      seriesId: req.seriesId,
      title: req.title,
      subtitle: req.subtitle,
      image: req.image,
      positionSec: st.status === 'ended' ? st.duration : st.position,
      durationSec: st.duration,
      completed: st.status === 'ended' ? true : undefined,
    });
  }, [st.position, st.status, st.duration, mode, req, profile.id]);

  useEffect(() => {
    if (req.kind !== 'episode' || !st.duration || nextEp) return;
    if (st.status === 'ended' || (st.duration > 120 && st.duration - st.position < 25)) setNextEp({ count: 10 });
  }, [st.position, st.status, st.duration, req.kind, nextEp]);

  const playNext = useCallback(async () => {
    if (!req.seriesId) return;
    const cur = await db.episodes.get(req.itemId);
    const s = await db.series.get(req.seriesId);
    if (!cur || !s) return;
    const n = await nextEpisode(req.seriesId, cur);
    setNextEp(null);
    if (n) playStore(await playEpisodeRequest(s, n, 0));
  }, [req, playStore]);

  useEffect(() => {
    if (!nextEp) return;
    if (nextEp.count <= 0) {
      void playNext();
      return;
    }
    const tm = setTimeout(() => setNextEp((n) => (n ? { count: n.count - 1 } : n)), 1000);
    return () => clearTimeout(tm);
  }, [nextEp, playNext]);

  // picture-in-picture (Android): hide the HTML controls in the small window
  const [pip, setPip] = useState(false);
  useEffect(() => {
    if (!isNative) return;
    const h = CyberNative.addListener('pipChanged', (e) => setPip(e.active));
    return () => void h.then((x) => x.remove());
  }, []);

  // ───────── misc ─────────
  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  // touch: tap toggles UI, double-tap left/right seeks
  const lastTap = useRef<{ t: number; x: number }>({ t: 0, x: 0 });
  const onSurfaceTap = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    const nowT = Date.now();
    const w = (e.currentTarget as HTMLElement).clientWidth;
    if (nowT - lastTap.current.t < 300) {
      const side = e.clientX < w / 2 ? 'l' : 'r';
      seekBy(side === 'l' ? -10 : 10);
      setGesture({ side, text: side === 'l' ? '« 10 s' : '10 s »' });
      setTimeout(() => setGesture(null), 600);
      lastTap.current = { t: 0, x: 0 };
      return;
    }
    lastTap.current = { t: nowT, x: e.clientX };
    if (uiVisible && !panel) setUiVisible(false);
    else poke();
  };

  const close = () => playStore(null);

  // ───────── render values ─────────
  const loading = st.status === 'loading' || st.status === 'buffering';
  const playing = st.status === 'playing' || st.status === 'buffering';
  let ratio = 0;
  let bufRatio = 0;
  let leftLabel = '';
  let rightLabel = '';
  if (mode === 'vod') {
    ratio = st.duration ? st.position / st.duration : 0;
    bufRatio = st.duration ? st.buffered / st.duration : 0;
    leftLabel = fmtDuration(st.position);
    rightLabel = st.duration ? `-${fmtDuration(Math.max(0, st.duration - st.position))}` : '';
  } else {
    ratio = Math.min(1, Math.max(0, (playhead - winStart) / (winEnd - winStart)));
    bufRatio = Math.min(1, Math.max(0, (now - winStart) / (winEnd - winStart)));
    leftLabel = fmtTime(winStart);
    rightLabel = fmtTime(winEnd);
  }
  const atLive = mode === 'live';
  const title = mode === 'vod' ? req.title : progAtHead?.title || req.title;
  const subtitle = mode === 'vod' ? req.subtitle : [channel?.name, progAtHead?.subTitle].filter(Boolean).join(' · ') || req.subtitle;
  const touch = isTouch();

  return (
    <div className="player" ref={rootRef} data-scope onPointerMove={() => !touch && poke()}>
      {!isNative && <video ref={videoRef} playsInline autoPlay onPointerUp={onSurfaceTap} />}
      <div className="ui-surface" style={{ position: 'absolute', inset: 0 }} onPointerUp={onSurfaceTap} />

      {loading && !fatal && (
        <div className="center-spin">
          <div className="spinner big" />
        </div>
      )}

      {gesture && (
        <div className="gesture-hint" style={gesture.side === 'l' ? { left: '15%' } : { right: '15%' }}>
          {gesture.text}
        </div>
      )}

      {numBuf && <div className="zap-num">{numBuf}</div>}

      <div className={`ui ${(uiVisible || panel || fatal) && !pip ? '' : 'hidden'}`} onPointerUp={onSurfaceTap}>
        <div className="top" onPointerUp={onSurfaceTap}>
          {mode !== 'vod' && channel?.logo && <Img srcs={[channel.logo]} contain className="ch-logo" alt="" />}
          <div className="ttl">
            <h2 className="ellipsis">{title}</h2>
            {subtitle && <div className="small ellipsis" style={{ opacity: 0.85, marginTop: 4 }}>{subtitle}</div>}
          </div>
          {!isNative && document.pictureInPictureEnabled && (
            <button className="pbtn" data-f onClick={() => eng()?.pip()} aria-label={t('player.pip')}>
              <IcPip />
            </button>
          )}
          {isNative && !isTvMode() && (
            <button className="pbtn" data-f onClick={() => eng()?.pip()} aria-label={t('player.pip')}>
              <IcPip />
            </button>
          )}
          <button className="pbtn" data-f onClick={close} aria-label={t('common.close')}>
            <IcClose />
          </button>
        </div>

        <div className="bottom" onPointerUp={onSurfaceTap}>
          <div className="controls">
            <button className="pbtn" data-f onClick={() => seekBy(-10)} aria-label="-10s" disabled={mode === 'live' && !catchupOk && !(st.seekableEnd > st.seekableStart)}>
              <IcBack10 />
            </button>
            <button className="pbtn big" data-f data-play onClick={togglePlay} aria-label="play/pause">
              {playing ? <IcPause /> : <IcPlay />}
            </button>
            <button className="pbtn" data-f onClick={() => seekBy(10)} aria-label="+10s" disabled={mode === 'live'}>
              <IcFwd10 />
            </button>
            {mode !== 'vod' && (
              <button className={`live-badge ${atLive ? '' : 'off'}`} data-f onClick={() => !atLive && void goLive()} title={t('player.goLive')}>
                {t('player.live')}
              </button>
            )}
            {mode !== 'vod' && catchupOk && (progAtHead || prog.now) && (
              <button className="tbtn" data-f onClick={startOver}>
                <IcRestart /> <span>{t('player.fromStart')}</span>
              </button>
            )}
            <div className="grow" />
            {mode !== 'vod' && zapChannels.length > 1 && (
              <button className="tbtn" data-f onClick={() => setPanel('channels')}>
                <IcTv /> <span>{t('player.allChannels')}</span>
              </button>
            )}
            {mode !== 'vod' && chanProgs.length > 0 && (
              <button className="tbtn" data-f onClick={() => setPanel('programs')}>
                <IcHistory /> <span>{t('player.replayNext')}</span>
              </button>
            )}
            <button className="pbtn" data-f onClick={() => setPanel('settings')} aria-label={t('player.subtitles')}>
              <IcSubtitles />
            </button>
            <button className="pbtn" data-f onClick={() => setPanel('info')} aria-label={t('player.info')}>
              <IcInfo />
            </button>
            {!isNative && (
              <button className="pbtn" data-f onClick={toggleFullscreen} aria-label="fullscreen">
                {fullscreen ? <IcExitFullscreen /> : <IcFullscreen />}
              </button>
            )}
          </div>
          <SeekBar ratio={ratio} buffered={bufRatio} onSeek={seekToRatio} onStep={(d) => seekBy(d)} disabled={mode === 'live' && !catchupOk} />
          <div className="times">
            <span>{leftLabel}</span>
            {mode === 'shift' && <span>{t('player.delayed')} · {fmtTime(playhead)}</span>}
            <span>{rightLabel}</span>
          </div>
        </div>
      </div>

      {banner && !uiVisible && channel && (
        <div className="zap-banner">
          {channel.logo && <Img srcs={[channel.logo]} contain alt="" />}
          <div>
            <div style={{ fontWeight: 800 }}>{channel.num ? `${channel.num} · ` : ''}{channel.name}</div>
            <div className="small">{prog.now ? `${fmtTime(prog.now.start)} ${prog.now.title}` : t('tv.noProgram')}</div>
            {prog.next && <div className="small" style={{ opacity: 0.7 }}>{t('tv.next')} : {fmtTime(prog.next.start)} {prog.next.title}</div>}
          </div>
        </div>
      )}

      {fatal && (
        <div className="err">
          <div>
            <h2 style={{ marginBottom: 10 }}>{t('player.error')}</h2>
            <p style={{ opacity: 0.8, maxWidth: 480 }}>{t('player.errorText')}</p>
            <div className="btn-row" style={{ justifyContent: 'center', marginTop: 20 }}>
              <button className="btn primary" data-f data-autofocus onClick={() => { setFatal(false); setCandIdx(0); setCands([...cands]); }}>
                {t('common.retry')}
              </button>
              <button className="btn" data-f onClick={close}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}

      {nextEp && (
        <div className="next-ep">
          <div>{t('player.nextEpisode', { n: nextEp.count })}</div>
          <button className="btn primary small" data-f data-autofocus onClick={() => void playNext()}>
            {t('player.playNext')}
          </button>
          <button className="btn small" data-f onClick={() => setNextEp(null)}>
            {t('common.cancel')}
          </button>
        </div>
      )}

      {!isNative && mode !== 'vod' && uiVisible && candIdx === 0 && st.status === 'playing' && import.meta.env.DEV && (
        <div className="notice">{t('player.webAudioWarn')}</div>
      )}

      {panel && <div className="panel-scrim" onPointerUp={(e) => (e.stopPropagation(), setPanel(null))} />}
      {panel && (
        <div className="panel" data-scope>
          <button className="panel-close icon-btn" onClick={() => setPanel(null)} aria-label={t('common.close')}>
            <IcClose />
          </button>
          {panel === 'channels' && (
            <>
              <h3>{t('player.allChannels')}</h3>
              <div className="zap-list">
                {zapChannels.map((c) => (
                  <button key={c.id} className={`zap-item ${c.groupKey === channel?.groupKey ? 'cur' : ''}`} data-f data-autofocus={c.groupKey === channel?.groupKey || undefined} onClick={() => void zapTo(c)}>
                    <span className="n">{c.num}</span>
                    <span className="zap-logo">
                      <Img srcs={[c.logo]} contain label={c.name} alt="" />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <div className="ellipsis" style={{ fontWeight: 600 }}>{c.name}</div>
                      <div className="xs ellipsis" style={{ opacity: 0.7 }}>{zapNow.get(c.epgId || '')?.now?.title || ''}</div>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          {panel === 'programs' && (
            <>
              <h3>{t('player.replayNext')}</h3>
              <div className="menu">
                {chanProgs
                  .filter((p) => p.stop > Date.now() - (channel?.catchupDays ? 86400000 : 0) && p.start < Date.now() + 12 * 3600000)
                  .map((p) => {
                    const past = p.stop <= Date.now();
                    const cur = p.start <= Date.now() && p.stop > Date.now();
                    const canPlay = (past || cur) && catchupOk;
                    return (
                      <button key={p.id ?? p.start} data-f data-autofocus={cur || undefined} disabled={!canPlay && !cur} onClick={() => (canPlay ? void goShift(p.start).then(() => setPanel(null)) : cur ? (void goLive(), setPanel(null)) : null)}>
                        <span style={{ width: 54, opacity: 0.7 }}>{fmtTime(p.start)}</span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <div className="ellipsis" style={{ fontWeight: cur ? 800 : 500 }}>{p.title}</div>
                          {p.subTitle && <div className="xs ellipsis" style={{ opacity: 0.7 }}>{p.subTitle}</div>}
                        </span>
                        {cur && <span className="live-badge">{t('player.live')}</span>}
                        {past && catchupOk && <IcPlay width={18} height={18} />}
                      </button>
                    );
                  })}
              </div>
            </>
          )}
          {panel === 'settings' && (
            <SettingsPanel
              tracks={tracks}
              cands={cands}
              candIdx={candIdx}
              fit={fit}
              rate={rate}
              vod={mode === 'vod'}
              onTrack={(type, id) => eng()?.selectTrack(type, id)}
              onCand={(i) => setCandIdx(i)}
              onFit={(m) => (setFit(m), eng()?.setFit(m))}
              onRate={(r) => (setRate(r), eng()?.setRate(r))}
            />
          )}
          {panel === 'info' && (
            <div>
              <h3>{title}</h3>
              {mode !== 'vod' && progAtHead && (
                <p className="small" style={{ opacity: 0.8 }}>
                  {fmtTime(progAtHead.start)} – {fmtTime(progAtHead.stop)} {progAtHead.category ? `· ${progAtHead.category}` : ''}
                </p>
              )}
              <p style={{ opacity: 0.9, lineHeight: 1.5 }}>{mode !== 'vod' ? progAtHead?.desc || t('tv.noProgram') : req.subtitle}</p>
              {mode !== 'vod' && prog.next && (
                <p className="small" style={{ opacity: 0.75 }}>
                  {t('tv.next')} : {fmtTime(prog.next.start)} · {prog.next.title}
                </p>
              )}
              <p className="xs" style={{ opacity: 0.5, marginTop: 18 }}>
                {cands[candIdx]?.label} · {isNative ? 'Media3' : 'Web'}
              </p>
              <button className="btn small" data-f onClick={() => setPanel(null)}>{t('common.close')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SeekBar({ ratio, buffered, onSeek, onStep, disabled }: { ratio: number; buffered: number; onSeek: (r: number) => void; onStep: (d: number) => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const [hover, setHover] = useState<number | null>(null);
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const shown = hover ?? ratio;
  return (
    <div
      ref={ref}
      className="seekbar"
      data-f={disabled ? undefined : ''}
      data-row
      data-row-lock
      tabIndex={disabled ? -1 : 0}
      role="slider"
      aria-valuenow={Math.round(ratio * 100)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') (onStep(-30), e.preventDefault(), e.stopPropagation());
        if (e.key === 'ArrowRight') (onStep(30), e.preventDefault(), e.stopPropagation());
      }}
      onPointerDown={(e) => {
        if (disabled) return;
        drag.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setHover(at(e));
      }}
      onPointerMove={(e) => drag.current && setHover(at(e))}
      onPointerUp={(e) => {
        e.stopPropagation();
        if (!drag.current) return;
        drag.current = false;
        onSeek(at(e));
        setHover(null);
      }}
    >
      <div className="track" />
      <div className="buf" style={{ width: `${buffered * 100}%` }} />
      <div className="fill" style={{ width: `${shown * 100}%` }} />
      <div className="knob" style={{ left: `${shown * 100}%` }} />
    </div>
  );
}

function SettingsPanel(p: {
  tracks: EngineTracks;
  cands: PlayRequest['candidates'];
  candIdx: number;
  fit: 'fit' | 'fill' | 'zoom';
  rate: number;
  vod: boolean;
  onTrack: (type: 'audio' | 'text' | 'video', id: string | null) => void;
  onCand: (i: number) => void;
  onFit: (m: 'fit' | 'fill' | 'zoom') => void;
  onRate: (r: number) => void;
}) {
  const autoQuality = !p.tracks.video.some((v) => v.selected);
  return (
    <div>
      {p.tracks.audio.length > 1 && (
        <>
          <h3><IcAudio width={18} height={18} /> {t('player.audio')}</h3>
          <Menu items={p.tracks.audio.map((a) => ({ label: a.label, checked: a.selected, onSelect: () => p.onTrack('audio', a.id) }))} />
        </>
      )}
      <h3><IcSubtitles width={18} height={18} /> {t('player.subtitles')}</h3>
      <Menu
        items={[
          { label: t('player.off'), checked: !p.tracks.text.some((x) => x.selected), onSelect: () => p.onTrack('text', null) },
          ...p.tracks.text.map((a) => ({ label: a.label, checked: a.selected, onSelect: () => p.onTrack('text', a.id) })),
        ]}
      />
      {(p.tracks.video.length > 1 || p.cands.length > 1) && (
        <>
          <h3><IcHd width={18} height={18} /> {t('player.quality')}</h3>
          <Menu
            items={[
              ...(p.tracks.video.length > 1
                ? [
                    { label: t('player.auto'), checked: autoQuality, onSelect: () => p.onTrack('video', null) },
                    ...p.tracks.video
                      .slice()
                      .sort((a, b) => (b.height || 0) - (a.height || 0))
                      // same resolution at several bitrates: keep one entry per label
                      .filter((v, i, arr) => arr.findIndex((x) => x.label === v.label) === i)
                      .map((v) => ({ label: v.label, checked: v.selected, onSelect: () => p.onTrack('video', v.id) })),
                  ]
                : []),
              ...(p.cands.length > 1 ? p.cands.map((c, i) => ({ label: `${c.label}`, checked: p.tracks.video.length <= 1 && i === p.candIdx, onSelect: () => p.onCand(i) })) : []),
            ]}
          />
        </>
      )}
      <h3><IcAspect width={18} height={18} /> {t('player.format')}</h3>
      <Menu
        items={(['fit', 'fill', 'zoom'] as const).map((m) => ({ label: t(`player.${m}`), checked: p.fit === m, onSelect: () => p.onFit(m) }))}
        autoFocusChecked={false}
      />
      {p.vod && (
        <>
          <h3><IcSpeed width={18} height={18} /> {t('player.speed')}</h3>
          <Menu items={[0.75, 1, 1.25, 1.5, 2].map((r) => ({ label: `${r}×`, checked: p.rate === r, onSelect: () => p.onRate(r) }))} autoFocusChecked={false} />
        </>
      )}
      <div style={{ height: 12 }} />
      <span className="xs" style={{ opacity: 0.5 }}>
        <IcSettings width={12} height={12} />
      </span>
    </div>
  );
}
