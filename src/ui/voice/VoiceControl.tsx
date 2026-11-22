import { useEffect, useState } from 'react';
import { useApp } from '@/state/store';
import { t } from '@/core/i18n';
import { CyberNative } from '@/core/native';
import { isAndroidApp } from '@/core/platform';
import { IcMic } from '../icons';
import { runVoice } from './run';

/** Android (TV and phone) uses the system recognizer; the dev build types the command instead */
export const voiceAvailable = isAndroidApp || !!import.meta.env.DEV;

type Bubble =
  | { phase: 'listening' }
  | { phase: 'working'; heard: string }
  | { phase: 'done'; heard: string; done: string }
  | { phase: 'miss'; heard: string }
  | { phase: 'error' };

let show: (b: Bubble | null) => void = () => {};
let busy = false;
let hideTimer = 0;

function display(b: Bubble | null, ms = 0) {
  clearTimeout(hideTimer);
  show(b);
  if (b && ms) hideTimer = window.setTimeout(() => show(null), ms);
}

async function listen(): Promise<string[]> {
  if (!isAndroidApp) {
    const typed = window.prompt(t('voice.prompt'));
    return typed ? [typed] : [];
  }
  const lang = useApp.getState().profile?.lang === 'en' ? 'en-US' : 'fr-FR';
  const r = await CyberNative.speech({ lang, prompt: t('voice.prompt') });
  return [...new Set([r.text, ...(r.alternatives || [])].map((x) => (x || '').trim()).filter(Boolean))];
}

/** "mets France 2", "accueil", "recherche Dune", "recule de 30 secondes"… from anywhere in the app */
export async function startVoice() {
  if (busy || !voiceAvailable) return;
  busy = true;
  display({ phase: 'listening' });
  try {
    const texts = await listen();
    if (!texts.length) return display(null);
    display({ phase: 'working', heard: texts[0] });
    const out = await runVoice(texts);
    display(out.done ? { phase: 'done', heard: out.heard, done: out.done } : { phase: 'miss', heard: out.heard }, 3000);
  } catch {
    display({ phase: 'error' }, 3000);
  } finally {
    busy = false;
  }
}

export function VoiceButton({ className = 'icon-btn' }: { className?: string }) {
  if (!voiceAvailable) return null;
  return (
    <button data-f className={className} onClick={() => void startVoice()} aria-label={t('voice.button')} title={t('voice.button')}>
      <IcMic />
    </button>
  );
}

/** the bubble (over everything, the player included) and the remote's voice key */
export function VoiceControl() {
  const [b, setB] = useState<Bubble | null>(null);
  useEffect(() => {
    show = setB;
    return () => {
      show = () => {};
    };
  }, []);
  useEffect(() => {
    if (!isAndroidApp) return;
    const h = CyberNative.addListener('voiceKey', () => {
      if (useApp.getState().screen === 'app') void startVoice();
    });
    return () => void h.then((x) => x.remove());
  }, []);
  if (!b) return null;
  return (
    <div className={`voice-bubble ${b.phase}`} role="status" aria-live="polite">
      <span className="voice-dot">
        <IcMic />
      </span>
      <div className="voice-text">
        {b.phase === 'listening' && <span>{t('voice.listening')}</span>}
        {b.phase === 'error' && <span>{t('voice.unavailable')}</span>}
        {b.phase !== 'listening' && b.phase !== 'error' && <span className="voice-heard">« {b.heard} »</span>}
        {b.phase === 'working' && <span className="dim">…</span>}
        {b.phase === 'done' && <strong>→ {b.done}</strong>}
        {b.phase === 'miss' && <span className="dim">{t('voice.miss')}</span>}
      </div>
    </div>
  );
}
