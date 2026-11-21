export interface EngineTrack {
  id: string;
  label: string;
  language?: string;
  selected: boolean;
  height?: number;
}

export interface EngineState {
  status: 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';
  position: number; // seconds
  duration: number; // seconds (Infinity / 0 for live)
  buffered: number; // seconds (end of buffered range)
  seekableStart: number;
  seekableEnd: number;
  isLive: boolean;
  error?: string;
}

export interface EngineTracks {
  audio: EngineTrack[];
  text: EngineTrack[];
  video: EngineTrack[];
}

export interface PlayerEngine {
  readonly kind: 'web' | 'native';
  load(url: string, opts: { startAt?: number; live?: boolean }): Promise<void>;
  play(): void;
  pause(): void;
  seek(sec: number): void;
  stop(): void;
  destroy(): void;
  tracks(): Promise<EngineTracks>;
  selectTrack(type: 'audio' | 'text' | 'video', id: string | null): void;
  setRate(r: number): void;
  setFit(mode: 'fit' | 'fill' | 'zoom'): void;
  pip(): void;
  onState(cb: (s: EngineState) => void): void;
  onTracks(cb: () => void): void;
}

export const initialState: EngineState = {
  status: 'idle', position: 0, duration: 0, buffered: 0, seekableStart: 0, seekableEnd: 0, isLive: false,
};
