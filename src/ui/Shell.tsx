import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useApp, useRoute, type TabId } from '@/state/store';
import { t } from '@/core/i18n';
import { isTvMode } from '@/core/platform';
import { Logo } from '@/app/App';
import { useMediaQuery } from './hooks';
import { focusFirst } from './spatial';
import { IcGrid, IcHome, IcMore, IcSearch, IcTv } from './icons';
import { Home } from './screens/Home';
import { PinPad } from './components/PinPad';
import { LiveTv } from './screens/LiveTv';

const Search = lazy(() => import('./screens/Search').then((m) => ({ default: m.Search })));
const Channels = lazy(() => import('./screens/Channels').then((m) => ({ default: m.Channels })));
const MyVideos = lazy(() => import('./screens/MyVideos').then((m) => ({ default: m.MyVideos })));
const Settings = lazy(() => import('./screens/Settings').then((m) => ({ default: m.Settings })));
const StackView = lazy(() => import('./StackView').then((m) => ({ default: m.StackView })));

const TABS: { id: TabId; label: () => string; short?: () => string; icon: typeof IcHome }[] = [
  { id: 'home', label: () => t('nav.home'), icon: IcHome },
  { id: 'search', label: () => t('nav.search'), icon: IcSearch },
  { id: 'tv', label: () => t('nav.tv'), short: () => t('nav.tvShort'), icon: IcTv },
  { id: 'channels', label: () => t('nav.channels'), icon: IcGrid },
  { id: 'myvideos', label: () => t('nav.myvideos'), icon: IcMore },
];

export function Shell() {
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const route = useRoute();
  const player = useApp((s) => s.player);
  const sync = useApp((s) => s.sync);
  const narrow = useMediaQuery('(max-width: 760px)');
  const mobile = narrow && !isTvMode();
  const [solid, setSolid] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('mobile', mobile);
  }, [mobile]);

  // focus management on navigation (remote users)
  useEffect(() => {
    if (player) return;
    // only remote/keyboard users need an initial focus (avoids scroll jumps on touch)
    if (!document.documentElement.classList.contains('kbd')) return;
    // lazy screens mount a bit later: retry until something focusable exists
    let tries = 0;
    const tick = () => {
      const scope = document.querySelector<HTMLElement>('.stack-page:last-of-type') || pageRef.current;
      if (!scope) return;
      if (scope.contains(document.activeElement)) return;
      if (scope.querySelector('[data-f]')) focusFirst(scope);
      else if (tries++ < 30) timer = window.setTimeout(tick, 50);
    };
    let timer = window.setTimeout(tick, 16);
    return () => clearTimeout(timer);
  }, [tab, route, player]);

  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const h = () => setSolid(el.scrollTop > 40);
    el.addEventListener('scroll', h, { passive: true });
    return () => el.removeEventListener('scroll', h);
  }, [tab]);

  return (
    <div className="app-shell" aria-hidden={!!player} inert={player ? true : undefined}>
      {!mobile && <TopNav tab={tab} setTab={setTab} solid={solid || !!route || tab !== 'home'} />}
      <div className={`page ${mobile ? '' : ''}`} ref={pageRef} key={tab} inert={route ? true : undefined}>
        <Suspense fallback={<div className="empty"><div className="spinner big" style={{ margin: 'auto' }} /></div>}>
          {tab === 'home' && <Home />}
          {tab === 'search' && <Search />}
          {tab === 'tv' && <LiveTv />}
          {tab === 'channels' && <Channels />}
          {tab === 'myvideos' && <MyVideos />}
          {tab === 'settings' && <Settings />}
        </Suspense>
      </div>
      {route && (
        <Suspense fallback={null}>
          <StackView />
        </Suspense>
      )}
      {mobile && <BottomNav tab={tab} setTab={setTab} />}
      <PinGate />
      {sync.running && (
        <div className="sync-pill">
          <span className="spinner" />
          {sync.progress?.step && sync.progress.step !== 'start' && sync.progress.step !== 'done' && sync.progress.step !== 'error'
            ? t(`sync.${sync.progress.step}` as 'sync.live')
            : t('sync.running')}
        </div>
      )}
    </div>
  );
}

function TopNav({ tab, setTab, solid }: { tab: TabId; setTab: (t: TabId) => void; solid: boolean }) {
  const profile = useApp((s) => s.profile)!;
  return (
    <header className={`topnav ${solid ? 'solid' : ''}`}>
      <button data-f onClick={() => setTab('home')} aria-label="home" style={{ borderRadius: 4 }}>
        <Logo />
      </button>
      <nav data-row>
        {TABS.filter((x) => x.id !== 'search').map((x) => (
          <button key={x.id} data-f className={`navlink ${tab === x.id ? 'active' : ''}`} onClick={() => setTab(x.id)}>
            {x.label()}
          </button>
        ))}
      </nav>
      <div className="spacer" />
      <button data-f className="icon-btn" onClick={() => setTab('search')} aria-label={t('nav.search')}>
        <IcSearch />
      </button>
      <button data-f className="avatar" style={{ background: profile.color }} onClick={() => setTab('settings')} aria-label={t('nav.settings')}>
        {profile.emoji}
      </button>
    </header>
  );
}

function BottomNav({ tab, setTab }: { tab: TabId; setTab: (t: TabId) => void }) {
  return (
    <nav className="bottomnav">
      {TABS.map((x) => {
        const Ic = x.icon;
        const active = tab === x.id || (x.id === 'myvideos' && tab === 'settings');
        return (
          <button key={x.id} className={active ? 'active' : ''} onClick={() => setTab(x.id)}>
            <Ic />
            {x.id === 'myvideos' ? t('nav.more') : (x.short || x.label)()}
          </button>
        );
      })}
    </nav>
  );
}

/** Parental PIN prompt, opened by `cyber:pin` events (adult channels) */
function PinGate() {
  const profile = useApp((s) => s.profile)!;
  const [pending, setPending] = useState<null | (() => void)>(null);
  useEffect(() => {
    const h = (e: Event) => setPending(() => (e as CustomEvent<() => void>).detail);
    window.addEventListener('cyber:pin', h);
    return () => window.removeEventListener('cyber:pin', h);
  }, []);
  if (!pending) return null;
  return (
    <PinPad
      expected={profile.parental.pin}
      onClose={() => setPending(null)}
      onOk={() => {
        useApp.getState().setUnlockedAdult(true);
        const cb = pending;
        setPending(null);
        cb();
      }}
    />
  );
}
