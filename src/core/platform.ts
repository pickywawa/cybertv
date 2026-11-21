import { Capacitor } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();
export const isAndroid = Capacitor.getPlatform() === 'android';

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
