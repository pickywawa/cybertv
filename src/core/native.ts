import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativeInfo {
  proxyPort: number;
  isTv: boolean;
  sdk: number;
}

export interface NativePlayerState {
  state: 'idle' | 'buffering' | 'ready' | 'ended' | 'error';
  playing: boolean;
  positionMs: number;
  durationMs: number;
  bufferedMs: number;
  isLive: boolean;
  error?: string;
  width?: number;
  height?: number;
}

export interface NativeTrack {
  id: string;
  type: 'audio' | 'text' | 'video';
  label: string;
  language?: string;
  selected: boolean;
  height?: number;
  bitrate?: number;
}

export interface CyberNativePlugin {
  getInfo(): Promise<NativeInfo>;
  secureGet(o: { key: string }): Promise<{ value: string | null }>;
  secureSet(o: { key: string; value: string }): Promise<void>;
  secureRemove(o: { key: string }): Promise<void>;
  speech(o: { lang: string; prompt?: string }): Promise<{ text: string }>;
  setOrientation(o: { mode: 'landscape' | 'portrait' | 'auto' }): Promise<void>;
  setImmersive(o: { on: boolean }): Promise<void>;

  playerOpen(o: { url: string; startMs?: number; live?: boolean; audioLang?: string; subLang?: string }): Promise<void>;
  clearImageCache(): Promise<void>;
  playerPlay(): Promise<void>;
  playerPause(): Promise<void>;
  playerSeek(o: { positionMs: number }): Promise<void>;
  playerStop(): Promise<void>;
  playerTracks(): Promise<{ tracks: NativeTrack[] }>;
  playerSelectTrack(o: { type: 'audio' | 'text' | 'video'; id: string | null }): Promise<void>;
  playerSetResize(o: { mode: 'fit' | 'fill' | 'zoom' }): Promise<void>;
  playerSetRate(o: { rate: number }): Promise<void>;
  playerPip(): Promise<void>;
  prefetchSchedule(o: { plan: string; intervalH: number; wifiOnly: boolean; runNow?: boolean }): Promise<void>;
  prefetchCancel(): Promise<void>;
  prefetchStatus(): Promise<{ lastRunAt: number; lastOkAt: number; files: number; bytes: number; errors: number; scheduled: boolean }>;
  enrollStart(): Promise<{ url: string }>;
  enrollPoll(): Promise<{ payload?: string }>;
  enrollStop(): Promise<void>;
  updateInfo(): Promise<{ versionCode: number; versionName: string; webVersion?: string; canInstall: boolean; silentUpdates: boolean }>;
  updateBootOk(): Promise<void>;
  updateWeb(o: { url: string; version: string; sha256?: string; apply?: boolean }): Promise<void>;
  updateApplyWeb(): Promise<void>;
  updateDownloadApk(o: { url: string }): Promise<void>;
  updateInstallApk(): Promise<{ needsPermission: boolean; silent?: boolean }>;
  addListener(event: 'playerState', cb: (s: NativePlayerState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'playerTracks', cb: (t: { tracks: NativeTrack[] }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'enrollReceived', cb: (t: { payload: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'pipChanged', cb: (t: { active: boolean }) => void): Promise<PluginListenerHandle>;
}

export const CyberNative = registerPlugin<CyberNativePlugin>('CyberNative');
