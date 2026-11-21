import { create } from 'zustand';
import type { PlayRequest, Profile, SyncProgress, ThemeId, Lang } from '@/core/types';

export type TabId = 'home' | 'search' | 'tv' | 'channels' | 'myvideos' | 'settings';

export type Route =
  | { name: 'movie'; id: string }
  | { name: 'series'; id: string }
  | { name: 'channel'; id: string }
  | { name: 'guide'; channelId?: string }
  | { name: 'grid'; kind: 'movie' | 'series'; title: string; filter: GridFilter }
  | { name: 'settings-section'; section: SettingsSection }
  | { name: 'source-edit'; sourceId?: string }
  | { name: 'profiles' }
  | { name: 'profile-edit'; profileId?: string };

export type SettingsSection = 'sources' | 'services' | 'appearance' | 'player' | 'parental' | 'sync' | 'categories' | 'about';

export interface GridFilter {
  universe?: string;
  genre?: string;
  categoryId?: string;
  sort?: 'added' | 'rating' | 'title' | 'year';
  tmdbList?: string;
  myList?: boolean;
}

export interface GlobalSettings {
  askProfile: boolean;
  defaultProfileId?: string;
  performance: boolean;
  syncIntervalH: number;
  tonightStartMin: number;
  preferredAudio: string;
  preferredSubs: string;
  hideAdult: boolean;
  recentSearches: string[];
}

const SETTINGS_KEY = 'cybertv.settings';
const DEFAULT_SETTINGS: GlobalSettings = {
  askProfile: true,
  performance: false,
  syncIntervalH: 12,
  tonightStartMin: 20 * 60 + 50,
  preferredAudio: 'fr',
  preferredSubs: 'off',
  hideAdult: true,
  recentSearches: [],
};

function loadSettings(): GlobalSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export interface SyncState {
  running: boolean;
  progress?: SyncProgress;
  lastError?: string;
}

export interface Toast {
  id: number;
  text: string;
}

interface AppState {
  booted: boolean;
  screen: 'boot' | 'profiles' | 'onboarding' | 'app';
  profile: Profile | null;
  settings: GlobalSettings;
  tab: TabId;
  stack: Route[];
  player: PlayRequest | null;
  sync: SyncState;
  /** bumped when the catalog/enrichment changes so views re-query */
  catalogVersion: number;
  epgVersion: number;
  toasts: Toast[];
  unlockedAdult: boolean;

  setScreen(s: AppState['screen']): void;
  setProfile(p: Profile | null): void;
  patchProfile(p: Partial<Profile>): void;
  updateSettings(p: Partial<GlobalSettings>): void;
  setTab(t: TabId): void;
  push(r: Route): void;
  pop(): boolean;
  resetStack(): void;
  play(r: PlayRequest | null): void;
  setSync(s: Partial<SyncState>): void;
  bumpCatalog(): void;
  bumpEpg(): void;
  toast(text: string): void;
  setUnlockedAdult(v: boolean): void;
}

let toastId = 0;

export const useApp = create<AppState>((set, get) => ({
  booted: false,
  screen: 'boot',
  profile: null,
  settings: loadSettings(),
  tab: 'home',
  stack: [],
  player: null,
  sync: { running: false },
  catalogVersion: 0,
  epgVersion: 0,
  toasts: [],
  unlockedAdult: false,

  setScreen: (screen) => set({ screen }),
  setProfile: (profile) => set({ profile, stack: [], tab: 'home', unlockedAdult: false }),
  patchProfile: (p) => {
    const cur = get().profile;
    if (cur) set({ profile: { ...cur, ...p } });
  },
  updateSettings: (p) => {
    const settings = { ...get().settings, ...p };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
    set({ settings });
  },
  setTab: (tab) => set({ tab, stack: [] }),
  push: (r) => set({ stack: [...get().stack, r] }),
  pop: () => {
    const s = get();
    if (s.player) {
      set({ player: null, catalogVersion: s.catalogVersion + 1 });
      return true;
    }
    if (s.stack.length) {
      set({ stack: s.stack.slice(0, -1) });
      return true;
    }
    if (s.tab !== 'home') {
      set({ tab: 'home' });
      return true;
    }
    return false;
  },
  resetStack: () => set({ stack: [] }),
  // closing the player refreshes views (continue watching, progress bars)
  play: (player) => set(player ? { player } : { player: null, catalogVersion: get().catalogVersion + 1 }),
  setSync: (s) => set({ sync: { ...get().sync, ...s } }),
  bumpCatalog: () => set({ catalogVersion: get().catalogVersion + 1 }),
  bumpEpg: () => set({ epgVersion: get().epgVersion + 1 }),
  toast: (text) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, text }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 3800);
  },
  setUnlockedAdult: (unlockedAdult) => set({ unlockedAdult }),
}));

export const useRoute = () => useApp((s) => s.stack[s.stack.length - 1]);

export function applyTheme(theme: ThemeId, accent?: string, performance?: boolean) {
  const r = document.documentElement;
  r.dataset.theme = theme;
  if (accent) r.style.setProperty('--accent', accent);
  else r.style.removeProperty('--accent');
  r.classList.toggle('perf', !!performance);
}

export type { Lang };
