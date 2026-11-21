import { Capacitor } from '@capacitor/core';

/** a Capacitor app (Android or iOS): native proxy, secure store, native HTTP */
export const isNative = Capacitor.isNativePlatform();
export const isAndroid = Capacitor.getPlatform() === 'android';
/** Android app: everything native (Media3 player, pre-download, QR server, self-update…) */
export const isAndroidApp = isNative && isAndroid;
/** iOS app: native proxy + Keychain, playback through iOS's own player (AVPlayer via <video>) */
export const isIOSApp = isNative && Capacitor.getPlatform() === 'ios';
/** desktop app (Electron): web engine, local Node proxy serving the app */
export const isDesktop = typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent);

/** Android TV / large remote-driven screen detection (refined by the native plugin on Android) */
let tvMode: boolean | null = null;
export function isTvMode(): boolean {
  if (tvMode !== null) return tvMode;
  const q = new URLSearchParams(location.search);
  if (q.has('tv')) return (tvMode = q.get('tv') !== '0');
  return (tvMode = /\b(Android TV|AFT|BRAVIA|SmartTV|GoogleTV|Chromecast)\b/i.test(navigator.userAgent));
}
export function setTvMode(v: boolean) {
  tvMode = v;
}

export function isTouch(): boolean {
  return matchMedia('(pointer: coarse)').matches;
}
