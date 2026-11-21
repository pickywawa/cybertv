import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { focusFirst } from '../spatial';
import { IcCheck } from '../icons';

/** Modal sheet that traps D-pad focus and closes on Back */
export function Sheet({ title, onClose, children, bottom = true }: { title?: ReactNode; onClose: () => void; children: ReactNode; bottom?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    const el = ref.current;
    requestAnimationFrame(() => el && focusFirst(el));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'Backspace') {
        if ((e.target as HTMLElement).tagName === 'INPUT' && e.key === 'Backspace') return;
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
      }
    };
    const onBack = () => onClose();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('cyber:back', onBack);
    const p = prev.current;
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('cyber:back', onBack);
      if (p instanceof HTMLElement && p.isConnected) p.focus({ preventScroll: true });
    };
  }, [onClose]);
  return createPortal(
    <div className={`overlay ${bottom ? 'bottom' : ''}`} onClick={(e) => e.target === e.currentTarget && onClose()} data-scope ref={ref} data-sheet>
      <div className="sheet" role="dialog">
        {title && <h3>{title}</h3>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  checked?: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

export function Menu({ items, autoFocusChecked = true }: { items: MenuItem[]; autoFocusChecked?: boolean }) {
  return (
    <div className="menu">
      {items.map((it, i) => (
        <button key={i} data-f disabled={it.disabled} data-autofocus={(autoFocusChecked && it.checked) || undefined} onClick={it.onSelect}>
          {it.icon}
          <span>{it.label}</span>
          {it.checked && (
            <span className="chk">
              <IcCheck width={20} height={20} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ label, on, onChange, sub }: { label: ReactNode; sub?: ReactNode; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className="toggle" data-f onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span>
        <div>{label}</div>
        {sub && <div className="small muted">{sub}</div>}
      </span>
      <span className={`switch ${on ? 'on' : ''}`} />
    </button>
  );
}
