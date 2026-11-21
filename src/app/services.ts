import { App as CapApp } from '@capacitor/app';
import { db, getMeta } from '@/core/db';
import { setProxyBase } from '@/core/net/http';
import { setImageProxy } from '@/core/images';
import { isNative, setTvMode, isTvMode } from '@/core/platform';
import { CyberNative } from '@/core/native';
import { dataWorker, proxyCb, reinitWorkers, searchWorker } from '@/core/workers';
import { loadSecrets } from '@/core/repo';
import { secureGet, tmdbKey } from '@/core/secure';
import { setLang } from '@/core/i18n';
import { applyTheme, useApp } from '@/state/store';
import { installSpatialNav, setBackHandler, setSmoothScroll } from '@/ui/spatial';
import type { Profile, SyncProgress } from '@/core/types';

let periodic: number | null = null;
let lastEnrichBump = 0;
let enrichBumpTimer: number | null = null;

export async function boot() {
  const st = useApp.getState();
  if (isNative) {
    try {
      const info = await CyberNative.getInfo();
      setProxyBase(`http://127.0.0.1:${info.proxyPort}/proxy?u=`);
      setImageProxy(`http://127.0.0.1:${info.proxyPort}/img?u=`);
      setTvMode(info.isTv);
      reinitWorkers();
    } catch (e) {
      console.warn('native info unavailable', e);
    }
    CapApp.addListener('backButton', () => handleBack(true));
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void maybeSync();
    });
  }
  document.documentElement.classList.toggle('tv', isTvMode());
  installSpatialNav();
  setBackHandler(() => handleBack(false));
  // keyboard users get visible focus rings even on cards
  window.addEventListener('keydown', (e) => {
    if (e.key.startsWith('Arrow') || e.key === 'Tab') document.documentElement.classList.add('kbd');
  });
  window.addEventListener('pointerdown', () => document.documentElement.classList.remove('kbd'));
  if (isTvMode()) document.documentElement.classList.add('kbd');

  setSmoothScroll(!st.settings.performance);
  const profiles = await db.profiles.toArray();
  if (!profiles.length) {
    applyTheme('night');
    useApp.setState({ screen: 'onboarding', booted: true });
    return;
  }
  const def = profiles.find((p) => p.id === st.settings.defaultProfileId);
  if (!st.settings.askProfile && def && !def.parental.pin) {
    await selectProfile(def);
  } else {
    applyTheme(def?.theme || profiles[0].theme, def?.accent, st.settings.performance);
    setLang(def?.lang || profiles[0].lang);
    useApp.setState({ screen: 'profiles', booted: true });
  }
}

/** Back from remote / Escape / Android back button */
export function handleBack(hardware: boolean): boolean {
  if (document.querySelector('[data-sheet]')) {
    window.dispatchEvent(new Event('cyber:back'));
    return true;
  }
  if (window.dispatchEvent(new CustomEvent('cyber:player-back', { cancelable: true })) === false) return true;
  const ok = useApp.getState().pop();
  if (!ok && hardware) void CapApp.minimizeApp().catch(() => CapApp.exitApp());
  return ok;
}

export async function selectProfile(p: Profile) {
  const s = useApp.getState();
  setLang(p.lang);
  applyTheme(p.theme, p.accent, s.settings.performance);
  s.setProfile(p);
  useApp.setState({ screen: 'app', booted: true });
  await loadSecrets(p.id, true);
  void startEnrichment(p);
  void searchWorker().warm(p.id, (await getMeta<number>(`catalog:version:${p.id}`)) || 0);
  void maybeSync();
  if (periodic) clearInterval(periodic);
  periodic = window.setInterval(() => void maybeSync(), 20 * 60000);
}

export async function startEnrichment(p: Profile) {
  const token = p.hasTmdb ? await secureGet(tmdbKey(p.id)) : null;
  await dataWorker().startEnrichment(
    p.id,
    token,
    p.lang,
    proxyCb(() => {
      // throttle UI refreshes while enrichment runs
      const now = Date.now();
      const run = () => {
        lastEnrichBump = Date.now();
        enrichBumpTimer = null;
        useApp.getState().bumpCatalog();
      };
      if (now - lastEnrichBump > 4000) run();
      else if (!enrichBumpTimer) enrichBumpTimer = window.setTimeout(run, 4000);
    }),
  );
}

export async function maybeSync(force = false) {
  const s = useApp.getState();
  const p = s.profile;
  if (!p || s.sync.running) return;
  const stale = !p.lastSyncAt || Date.now() - p.lastSyncAt > s.settings.syncIntervalH * 3600000;
  if (force || stale) await runSync(p.id);
}

export async function runSync(profileId: string, withEpg = true) {
  const s = useApp.getState();
  if (s.sync.running) return;
  s.setSync({ running: true, progress: { step: 'start' }, lastError: undefined });
  const secrets = await loadSecrets(profileId, true);
  let lastBump = 0;
  try {
    await dataWorker().syncProfile(
      profileId,
      secrets,
      proxyCb((p: SyncProgress) => {
        const st = useApp.getState();
        st.setSync({ progress: p, lastError: p.step === 'error' ? p.message : st.sync.lastError });
        // show channels/movies as soon as they land
        if ((p.step === 'live' || p.step === 'vod' || p.step === 'series') && p.count !== undefined && Date.now() - lastBump > 1500) {
          lastBump = Date.now();
          st.bumpCatalog();
        }
        if (p.step === 'epg' && p.count && Date.now() - lastBump > 3000) {
          lastBump = Date.now();
          st.bumpEpg();
        }
      }),
      withEpg,
    );
    const prof = await db.profiles.get(profileId);
    if (prof && useApp.getState().profile?.id === profileId) {
      useApp.getState().patchProfile({ lastSyncAt: prof.lastSyncAt });
      void startEnrichment(prof);
    }
    void searchWorker().warm(profileId, (await getMeta<number>(`catalog:version:${profileId}`)) || Date.now());
  } catch (e) {
    useApp.getState().setSync({ lastError: (e as Error).message });
  } finally {
    const st = useApp.getState();
    st.setSync({ running: false });
    st.bumpCatalog();
    st.bumpEpg();
  }
}
