import type Hls from 'hls.js';
import type { EngineState, EngineTracks, PlayerEngine } from './engine';
import { initialState } from './engine';
import { proxify } from '../net/http';

type Mpegts = typeof import('mpegts.js').default;
type MpegtsPlayer = ReturnType<Mpegts['createPlayer']>;

function kindOf(url: string): 'hls' | 'ts' | 'file' {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8') || path.includes('.m3u8') || /[?&](type|output)=(m3u8|hls)/.test(url)) return 'hls';
  if (path.endsWith('.ts') || /\/live\/[^/]+\/[^/]+\/\d+$/.test(path) || /[?&](output|extension)=ts/.test(url)) return 'ts';
  if (/\.(mp4|mkv|webm|mov|m4v|avi|mp3|aac)$/.test(path)) return 'file';
  return 'hls';
}

/** Browser engine (dev/testing): hls.js for HLS, mpegts.js for MPEG-TS, <video> for files */
export class WebEngine implements PlayerEngine {
  readonly kind = 'web' as const;
  private hls: Hls | null = null;
  private ts: MpegtsPlayer | null = null;
  private stateCb: (s: EngineState) => void = () => {};
  private tracksCb: () => void = () => {};
  private state: EngineState = { ...initialState };
  private detach: (() => void) | null = null;

  constructor(private video: HTMLVideoElement) {
    const v = video;
    const emit = (patch: Partial<EngineState> = {}) => {
      const sk = v.seekable;
      const seekableStart = sk.length ? sk.start(0) : 0;
      const seekableEnd = sk.length ? sk.end(sk.length - 1) : 0;
      let buffered = 0;
      for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5) buffered = v.buffered.end(i);
      const isLive = this.state.isLive || v.duration === Infinity;
      this.state = { ...this.state, position: v.currentTime, duration: isFinite(v.duration) ? v.duration : 0, buffered, seekableStart, seekableEnd, isLive, ...patch };
      this.stateCb(this.state);
    };
    const on: [string, () => void][] = [
      ['timeupdate', () => emit()],
      ['progress', () => emit()],
      ['durationchange', () => emit()],
      ['waiting', () => emit({ status: 'buffering' })],
      ['playing', () => emit({ status: 'playing' })],
      ['pause', () => emit({ status: v.ended ? 'ended' : 'paused' })],
      ['ended', () => emit({ status: 'ended' })],
      ['loadedmetadata', () => (emit(), this.tracksCb())],
      ['error', () => emit({ status: 'error', error: v.error?.message || `media error ${v.error?.code}` })],
    ];
    on.forEach(([e, h]) => v.addEventListener(e, h));
    v.textTracks.addEventListener?.('addtrack', () => this.tracksCb());
    this.detach = () => on.forEach(([e, h]) => v.removeEventListener(e, h));
  }

  onState(cb: (s: EngineState) => void) {
    this.stateCb = cb;
  }
  onTracks(cb: () => void) {
    this.tracksCb = cb;
  }

  private cleanup() {
    this.hls?.destroy();
    this.hls = null;
    if (this.ts) {
      try {
        this.ts.pause();
        this.ts.unload();
        this.ts.detachMediaElement();
        this.ts.destroy();
      } catch {
        /* ignore */
      }
      this.ts = null;
    }
    this.video.removeAttribute('src');
    this.video.load();
  }

  async load(url: string, opts: { startAt?: number; live?: boolean }) {
    this.cleanup();
    this.state = { ...initialState, status: 'loading', isLive: !!opts.live };
    this.stateCb(this.state);
    const v = this.video;
    const src = proxify(url);
    const kind = kindOf(url);
    const fail = (msg: string) => {
      this.state = { ...this.state, status: 'error', error: msg };
      this.stateCb(this.state);
    };

    if (kind === 'hls') {
      const { default: HlsCtor } = await import('hls.js');
      if (HlsCtor.isSupported()) {
        const hls = new HlsCtor({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: opts.live ? 90 : 30,
          maxBufferLength: 30,
          startPosition: opts.startAt ?? -1,
          manifestLoadingMaxRetry: 2,
          levelLoadingMaxRetry: 3,
          fragLoadingMaxRetry: 4,
        });
        this.hls = hls;
        hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
          this.tracksCb();
          void v.play().catch(() => {});
        });
        hls.on(HlsCtor.Events.LEVEL_LOADED, (_e, d) => {
          if (d.details.live !== this.state.isLive) {
            this.state.isLive = d.details.live;
            this.stateCb(this.state);
          }
        });
        hls.on(HlsCtor.Events.AUDIO_TRACKS_UPDATED, () => this.tracksCb());
        hls.on(HlsCtor.Events.SUBTITLE_TRACKS_UPDATED, () => this.tracksCb());
        hls.on(HlsCtor.Events.LEVEL_SWITCHED, () => this.tracksCb());
        hls.on(HlsCtor.Events.ERROR, (_e, d) => {
          if (!d.fatal) return;
          if (d.type === HlsCtor.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          fail(`${d.type}: ${d.details}`);
        });
        hls.loadSource(src);
        hls.attachMedia(v);
        return;
      }
      if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = src;
        if (opts.startAt) v.currentTime = opts.startAt;
        void v.play().catch(() => {});
        return;
      }
      return fail('HLS non supporté');
    }

    if (kind === 'ts') {
      const { default: mpegts } = await import('mpegts.js');
      if (!mpegts.getFeatureList().mseLivePlayback) return fail('MSE indisponible');
      const p = mpegts.createPlayer(
        { type: 'mpegts', isLive: !!opts.live, url: new URL(src, location.href).toString() },
        { enableWorker: true, liveBufferLatencyChasing: false, lazyLoad: false, autoCleanupSourceBuffer: true },
      );
      this.ts = p;
      p.on(mpegts.Events.ERROR, (type: string, detail: string) => fail(`${type}: ${detail}`));
      p.attachMediaElement(v);
      p.load();
      void (p.play() as Promise<void> | void)?.catch?.(() => {});
      return;
    }

    v.src = src;
    if (opts.startAt) {
      const s = opts.startAt;
      v.addEventListener('loadedmetadata', () => (v.currentTime = s), { once: true });
    }
    void v.play().catch(() => {});
  }

  play() {
    void this.video.play().catch(() => {});
  }
  pause() {
    this.video.pause();
  }
  seek(sec: number) {
    const v = this.video;
    const max = this.state.isLive ? (v.seekable.length ? v.seekable.end(v.seekable.length - 1) : sec) : v.duration || sec;
    v.currentTime = Math.max(0, Math.min(sec, max));
  }
  stop() {
    this.cleanup();
  }
  destroy() {
    this.cleanup();
    this.detach?.();
  }

  async tracks(): Promise<EngineTracks> {
    const out: EngineTracks = { audio: [], text: [], video: [] };
    const h = this.hls;
    if (h) {
      out.audio = h.audioTracks.map((a, i) => ({ id: String(i), label: a.name || a.lang || `Audio ${i + 1}`, language: a.lang, selected: i === h.audioTrack }));
      out.text = h.subtitleTracks.map((s, i) => ({ id: String(i), label: s.name || s.lang || `Sub ${i + 1}`, language: s.lang, selected: i === h.subtitleTrack }));
      out.video = h.levels.map((l, i) => ({
        id: String(i), label: l.height ? `${l.height}p` : `${Math.round((l.bitrate || 0) / 1000)} kb/s`, height: l.height,
        selected: !h.autoLevelEnabled && i === h.currentLevel,
      }));
      return out;
    }
    const tt = this.video.textTracks;
    for (let i = 0; i < tt.length; i++) out.text.push({ id: String(i), label: tt[i].label || tt[i].language || `Sub ${i + 1}`, language: tt[i].language, selected: tt[i].mode === 'showing' });
    return out;
  }

  selectTrack(type: 'audio' | 'text' | 'video', id: string | null) {
    const h = this.hls;
    if (type === 'video' && h) h.currentLevel = id === null ? -1 : parseInt(id, 10);
    else if (type === 'audio' && h && id !== null) h.audioTrack = parseInt(id, 10);
    else if (type === 'text') {
      if (h) {
        h.subtitleTrack = id === null ? -1 : parseInt(id, 10);
        h.subtitleDisplay = id !== null;
      } else {
        const tt = this.video.textTracks;
        for (let i = 0; i < tt.length; i++) tt[i].mode = String(i) === id ? 'showing' : 'disabled';
      }
    }
    setTimeout(() => this.tracksCb(), 50);
  }

  setRate(r: number) {
    this.video.playbackRate = r;
  }
  setFit(mode: 'fit' | 'fill' | 'zoom') {
    this.video.classList.toggle('fill', mode === 'fill');
    this.video.classList.toggle('zoom', mode === 'zoom');
  }
  pip() {
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else void this.video.requestPictureInPicture?.().catch(() => {});
  }
}
