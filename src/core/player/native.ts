import type { PluginListenerHandle } from '@capacitor/core';
import { CyberNative, type NativePlayerState, type NativeTrack } from '../native';
import type { EngineState, EngineTracks, PlayerEngine } from './engine';
import { initialState } from './engine';
import { useApp } from '@/state/store';

/** Android Media3/ExoPlayer, rendered on a SurfaceView below the transparent WebView */
export class NativeEngine implements PlayerEngine {
  readonly kind = 'native' as const;
  private stateCb: (s: EngineState) => void = () => {};
  private tracksCb: () => void = () => {};
  private handles: Promise<PluginListenerHandle>[] = [];
  private lastTracks: NativeTrack[] = [];

  constructor() {
    document.documentElement.classList.add('native-video');
    this.handles.push(
      CyberNative.addListener('playerState', (s: NativePlayerState) => {
        const status: EngineState['status'] =
          s.state === 'error' ? 'error' : s.state === 'ended' ? 'ended' : s.state === 'buffering' ? 'buffering' : s.state === 'idle' ? 'loading' : s.playing ? 'playing' : 'paused';
        const dur = s.durationMs > 0 ? s.durationMs / 1000 : 0;
        this.stateCb({
          status,
          position: s.positionMs / 1000,
          duration: s.isLive ? 0 : dur,
          buffered: s.bufferedMs / 1000,
          seekableStart: 0,
          seekableEnd: s.isLive ? dur : dur,
          isLive: s.isLive,
          error: s.error,
        });
      }),
      CyberNative.addListener('playerTracks', (t) => {
        this.lastTracks = t.tracks;
        this.tracksCb();
      }),
    );
  }

  onState(cb: (s: EngineState) => void) {
    this.stateCb = cb;
  }
  onTracks(cb: () => void) {
    this.tracksCb = cb;
  }

  async load(url: string, opts: { startAt?: number; live?: boolean }) {
    this.stateCb({ ...initialState, status: 'loading', isLive: !!opts.live });
    const { preferredAudio, preferredSubs } = useApp.getState().settings;
    await CyberNative.playerOpen({
      url,
      startMs: opts.startAt ? Math.round(opts.startAt * 1000) : undefined,
      live: opts.live,
      audioLang: preferredAudio,
      subLang: preferredSubs,
    });
  }
  play() {
    void CyberNative.playerPlay();
  }
  pause() {
    void CyberNative.playerPause();
  }
  seek(sec: number) {
    void CyberNative.playerSeek({ positionMs: Math.max(0, Math.round(sec * 1000)) });
  }
  stop() {
    void CyberNative.playerStop();
  }
  destroy() {
    void CyberNative.playerStop();
    for (const h of this.handles) void h.then((x) => x.remove());
    document.documentElement.classList.remove('native-video');
  }
  async tracks(): Promise<EngineTracks> {
    const list = this.lastTracks.length ? this.lastTracks : (await CyberNative.playerTracks()).tracks;
    const map = (type: NativeTrack['type']) =>
      list.filter((t) => t.type === type).map((t) => ({ id: t.id, label: t.label, language: t.language, selected: t.selected, height: t.height }));
    return { audio: map('audio'), text: map('text'), video: map('video') };
  }
  selectTrack(type: 'audio' | 'text' | 'video', id: string | null) {
    void CyberNative.playerSelectTrack({ type, id });
  }
  setRate(rate: number) {
    void CyberNative.playerSetRate({ rate });
  }
  setFit(mode: 'fit' | 'fill' | 'zoom') {
    void CyberNative.playerSetResize({ mode });
  }
  pip() {
    void CyberNative.playerPip();
  }
}
