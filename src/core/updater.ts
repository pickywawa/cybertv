import { isAndroidApp, isDesktop } from './platform';
import { CyberNative } from './native';
import { proxify } from './net/http';

/**
 * Release manifest published with every GitHub release (scripts/release.mjs):
 * - `version`: web bundle version (package.json)
 * - `versionCode`: Android versionCode of the APK in this release
 * - `minVersionCode`: oldest installed APK able to run this web bundle (native API it relies on)
 */
export interface UpdateManifest {
  version: string;
  versionCode: number;
  minVersionCode: number;
  apk?: string;
  web?: string;
  webSha256?: string;
  notes?: string;
}

export type UpdateState =
  | { kind: 'none' }
  | { kind: 'web-ready'; version: string }
  | { kind: 'apk'; version: string; url: string; notes?: string }
  /** downloaded; Android 12+ installs it silently when the app goes to the background */
  | { kind: 'apk-silent'; version: string }
  /** desktop: a newer installer is published (opens the release page) */
  | { kind: 'desktop'; version: string; url: string };

export const APP_VERSION = __APP_VERSION__;

export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** what to do for a given manifest and installed state (pure, unit-tested) */
export function decide(m: UpdateManifest, installed: { versionCode: number; webVersion: string }): 'web' | 'apk' | 'none' {
  const webNewer = cmpVersion(m.version, installed.webVersion) > 0;
  if (webNewer && m.web && m.minVersionCode <= installed.versionCode) return 'web';
  if (m.versionCode > installed.versionCode && m.apk) return 'apk';
  return 'none';
}

export async function fetchManifest(): Promise<UpdateManifest | null> {
  if (!__UPDATE_URL__) return null;
  try {
    // GitHub release assets send no CORS headers: go through the native proxy
    const res = await fetch(proxify(`${__UPDATE_URL__}?t=${Date.now()}`), { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as UpdateManifest;
  } catch {
    return null;
  }
}

let checking = false;

/**
 * Web updates install silently (applied on the next start or via "Restart now");
 * APK updates are announced and installed on demand (Android asks the user to confirm).
 */
export async function checkForUpdate(): Promise<UpdateState> {
  if (isDesktop && !checking) {
    const m = await fetchManifest();
    if (m && cmpVersion(m.version, APP_VERSION) > 0) {
      const repo = __UPDATE_URL__.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1];
      return { kind: 'desktop', version: m.version, url: repo ? `https://github.com/${repo}/releases/tag/v${m.version}` : __UPDATE_URL__ };
    }
    return { kind: 'none' };
  }
  if (!isAndroidApp || checking) return { kind: 'none' };
  checking = true;
  try {
    const info = await CyberNative.updateInfo();
    const m = await fetchManifest();
    if (!m) return { kind: 'none' };
    const webVersion = info.webVersion || APP_VERSION;
    const what = decide(m, { versionCode: info.versionCode, webVersion });
    if (what === 'web') {
      await CyberNative.updateWeb({ url: m.web!, version: m.version, sha256: m.webSha256 });
      return { kind: 'web-ready', version: m.version };
    }
    if (what === 'apk') {
      if (info.silentUpdates) {
        await CyberNative.updateDownloadApk({ url: m.apk! });
        return { kind: 'apk-silent', version: m.version };
      }
      return { kind: 'apk', version: m.version, url: m.apk!, notes: m.notes };
    }
    return { kind: 'none' };
  } catch (e) {
    console.warn('[update]', e);
    return { kind: 'none' };
  } finally {
    checking = false;
  }
}

export async function installApk(url: string): Promise<'installing' | 'permission'> {
  await CyberNative.updateDownloadApk({ url });
  const r = await CyberNative.updateInstallApk();
  return r.needsPermission ? 'permission' : 'installing';
}

/** the running bundle booted fine: keep it (otherwise the native side rolls back after 2 launches) */
export function reportBootOk() {
  if (isAndroidApp) void CyberNative.updateBootOk().catch(() => {});
}

/** installs a silently-installable update now (the app is replaced and closes) */
export async function installSilentNow(): Promise<void> {
  await CyberNative.updateInstallApk();
}
