import { App as CapApp } from '@capacitor/app';
import { db, getMeta, setMeta } from '@/core/db';
import { setProxyBase } from '@/core/net/http';
import { setImageProxy } from '@/core/images';
import { isAndroidApp, isDesktop, isNative, setTvMode, isTvMode } from '@/core/platform';
import { CyberNative } from '@/core/native';
import { dataWorker, proxyCb, reinitWorkers, searchWorker } from '@/core/workers';
import { loadSecrets } from '@/core/repo';
import { secureGet, tmdbKey } from '@/core/secure';
import { setLang } from '@/core/i18n';
import { applyTheme, useApp } from '@/state/store';
import { installSpatialNav, setBackHandler, setSmoothScroll } from '@/ui/spatial';
import type { Profile, SyncProgress } from '@/core/types';
import { primeCache } from '@/ui/hooks';
import { checkForUpdate, installSilentNow, reportBootOk } from '@/core/updater';
import { enrollTarget } from '@/core/enroll';

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
      if (isActive) {
        void maybeSync();
        void runUpdateCheck();
        return;
      }
      // leaving the app: the right moment for a silent APK update (never during playback)
      if (useApp.getState().update.kind === 'apk-silent' && !useApp.getState().player) void installSilentNow().catch(() => {});
    });
    // QR enrolment: the TV's page opened cyberiptv://enroll?target=… on this phone
    CapApp.addListener('appUrlOpen', ({ url }) => openDeepLink(url));
    void CapApp.getLaunchUrl().then((r) => r?.url && openDeepLink(r.url)).catch(() => {});
    // this web bundle started: keep it; then look for a newer one in the background
    reportBootOk();
    setTimeout(() => void runUpdateCheck(), 8000);
    setInterval(() => void runUpdateCheck(), 6 * 3600000);
  }
  if (isDesktop) {
    setTimeout(() => void runUpdateCheck(), 8000);
    setInterval(() => void runUpdateCheck(), 6 * 3600000);
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

let pendingLink: string | null = null;

/** routes a deep link once a profile is active (the profile's sources are what gets sent) */
export function openDeepLink(url: string) {
  const target = enrollTarget(url);
  if (!target) return;
  const st = useApp.getState();
  if (st.screen !== 'app' || !st.profile) {
    pendingLink = url;
    return;
  }
  st.setTab('home');
  st.push({ name: 'send-to-tv', target });
}

export async function selectProfile(p: Profile) {
  const s = useApp.getState();
  setLang(p.lang);
  applyTheme(p.theme, p.accent, s.settings.performance);
  s.setProfile(p);
  // last Home content from the previous session: shown at once, refreshed right after
  await loadHomeSnapshot(p.id);
  useApp.setState({ screen: 'app', booted: true });
  if (pendingLink) {
    const link = pendingLink;
    pendingLink = null;
    openDeepLink(link);
  }
  await loadSecrets(p.id, true);
  void startEnrichment(p);
  void searchWorker().warm(p.id, (await getMeta<number>(`catalog:version:${p.id}`)) || 0);
  // catalogs synced before language detection existed: resync once to tag languages/countries
  // v0.5: one full resync to restore catalogues an invalid list could have emptied
  const LANG_SCHEMA = `schema:resync:v5:${p.id}`;
  if (p.lastSyncAt && !(await getMeta<boolean>(LANG_SCHEMA))) void maybeSync(true).then(() => setMeta(LANG_SCHEMA, true));
  else {
    if (!p.lastSyncAt) void setMeta(LANG_SCHEMA, true);
    void maybeSync();
  }
  // v0.10: channel versions without a guide id take their sibling's (once, then after every guide sync)
  const EPG_FILL = `schema:epgfill:v2:${p.id}`;
  if (p.lastSyncAt && !(await getMeta<boolean>(EPG_FILL))) {
    void dataWorker()
      .fillEpgIds(p.id)
      .then(async (n) => {
        await setMeta(EPG_FILL, true);
        if (n) useApp.getState().bumpCatalog();
      });
  }
  void schedulePrefetch(p.id);
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
  // catalogues/guides pre-downloaded in the background since the last sync: apply them now,
  // it's local work only (no network wait), so no progress pill either
  const pre = isAndroidApp && s.settings.prefetch ? await CyberNative.prefetchStatus().catch(() => null) : null;
  const fresh = !!pre && !!p.lastSyncAt && pre.lastOkAt > p.lastSyncAt;
  if (force || stale || fresh) await runSync(p.id, true, { quiet: fresh && !force });
}

/** hands the URLs of a full sync to Android's WorkManager (runs while the app is closed) */
export async function schedulePrefetch(profileId: string, runNow = false) {
  if (!isAndroidApp) return;
  const st = useApp.getState().settings;
  if (!st.prefetch) {
    await CyberNative.prefetchCancel().catch(() => {});
    return;
  }
  try {
    const secrets = await loadSecrets(profileId);
    const urls = await dataWorker().prefetchPlan(profileId, secrets);
    if (!urls.length) return;
    await CyberNative.prefetchSchedule({
      plan: JSON.stringify({ profileId, items: urls.map((url) => ({ url })) }),
      intervalH: Math.max(3, Math.round(st.syncIntervalH / 2)),
      wifiOnly: st.prefetchWifiOnly,
      runNow,
    });
  } catch (e) {
    console.warn('[prefetch]', e);
  }
}

export async function runSync(profileId: string, withEpg = true, opts: { quiet?: boolean } = {}) {
  const s = useApp.getState();
  if (s.sync.running) return;
  s.setSync({ running: true, quiet: !!opts.quiet, progress: { step: 'start' }, lastError: undefined });
  const secrets = await loadSecrets(profileId, true);
  let lastBump = 0;
  let lastEpgBump = 0;
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
        // the guide is big: screens refresh it every 20 s at most while it is being written
        if (p.step === 'epg' && p.count && Date.now() - lastEpgBump > 20000) {
          lastEpgBump = Date.now();
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
    // keep the background pre-download in step with the sources / servers in use
    void schedulePrefetch(profileId);
  } catch (e) {
    useApp.getState().setSync({ lastError: (e as Error).message });
  } finally {
    const st = useApp.getState();
    st.setSync({ running: false, quiet: false });
    st.bumpCatalog();
    st.bumpEpg();
  }
}

let lastUpdateCheck = 0;
export async function runUpdateCheck(force = false): Promise<void> {
  if (!force && Date.now() - lastUpdateCheck < 30 * 60000) return;
  lastUpdateCheck = Date.now();
  const r = await checkForUpdate();
  const cur = useApp.getState().update;
  // a ready web bundle stays announced until restart even if a later check finds nothing new
  if (r.kind === 'none' && cur.kind !== 'none') return;
  useApp.setState({ update: r, updateDismissed: false });
}

async function loadHomeSnapshot(profileId: string) {
  try {
    const snap = await getMeta<{ key: string; data: unknown; at: number }>(`snapshot:home:${profileId}`);
    if (snap?.key && snap.data) primeCache(snap.key, snap.data);
  } catch {
    /* no snapshot: Home loads normally */
  }
}
