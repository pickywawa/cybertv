import { lazy, Suspense } from 'react';
import { useApp } from '@/state/store';
import { ProfilePicker } from '@/ui/screens/Profiles';
import { Onboarding } from '@/ui/screens/Onboarding';
import { Shell } from '@/ui/Shell';

const Player = lazy(() => import('@/ui/screens/Player').then((m) => ({ default: m.Player })));

export function App() {
  const screen = useApp((s) => s.screen);
  const player = useApp((s) => s.player);
  const toasts = useApp((s) => s.toasts);
  return (
    <>
      {screen === 'boot' && (
        <div className="center-screen">
          <Logo />
          <div className="spinner big" style={{ marginTop: 24 }} />
        </div>
      )}
      {screen === 'profiles' && <ProfilePicker />}
      {screen === 'onboarding' && <Onboarding />}
      {screen === 'app' && <Shell />}
      {player && (
        <Suspense fallback={null}>
          <Player req={player} />
        </Suspense>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}

export function Logo({ size = 1 }: { size?: number }) {
  return (
    <div className="logo" style={{ fontSize: `${1.55 * size}rem` }} aria-label="CyberIPTV">
      <LogoMark />
      <span>
        <span className="w1">Cyber</span>
        <span className="w2">IPTV</span>
      </span>
    </div>
  );
}

/** Brand mark: green rounded square with a dark play triangle */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <rect width="64" height="64" rx="16" fill="var(--accent, #4fe3a8)" />
      <path d="M25 19.5c0-2 2.2-3.2 3.9-2.1l17.4 11.2c1.5 1 1.5 3.3 0 4.3L28.9 44.1c-1.7 1.1-3.9-.1-3.9-2.1z" fill="#0d1f19" />
    </svg>
  );
}
