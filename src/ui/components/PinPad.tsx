import { useEffect, useState } from 'react';
import { t } from '@/core/i18n';
import { Sheet } from './Overlay';

/** 4-digit PIN entry: on-screen keypad + remote/keyboard digits */
export function PinPad({ title, expected, onOk, onClose, setMode }: { title?: string; expected?: string; onOk: (pin: string) => void; onClose: () => void; setMode?: boolean }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (pin.length < 4) return;
    if (setMode || pin === expected) {
      onOk(pin);
      return;
    }
    setErr(true);
    const tm = setTimeout(() => (setPin(''), setErr(false)), 700);
    return () => clearTimeout(tm);
  }, [pin, expected, onOk, setMode]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) setPin((p) => (p + e.key).slice(0, 4));
      if (e.key === 'Backspace') {
        e.stopPropagation();
        setPin((p) => p.slice(0, -1));
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);
  return (
    <Sheet title={title || t('profiles.enterPin')} onClose={onClose} bottom={false}>
      <div className="pin-dots">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={i < pin.length ? 'on' : ''} />
        ))}
      </div>
      {err && <div className="msg-ko" style={{ textAlign: 'center', marginBottom: 10 }}>{t('profiles.wrongPin')}</div>}
      <div className="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) =>
          k ? (
            <button key={i} data-f data-autofocus={k === '1' || undefined} onClick={() => setPin((p) => (k === '⌫' ? p.slice(0, -1) : (p + k).slice(0, 4)))}>
              {k}
            </button>
          ) : (
            <span key={i} />
          ),
        )}
      </div>
    </Sheet>
  );
}
