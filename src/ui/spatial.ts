/**
 * Lightweight spatial navigation for remotes / keyboards (D-pad).
 *  - focusable elements: [data-f]  (buttons, links, inputs, cards)
 *  - rows:   [data-row]   left/right stays inside the row first, rows remember their last focus
 *  - scope:  [data-scope] the last mounted scope traps focus (modals, player overlay)
 *  - long press on OK: elements with [data-lp] receive a `longpress` CustomEvent
 *  - tab rows: [data-row][data-tabs]  entering one focuses its current tab (`.active`), and a tab
 *    reached with left/right is opened by itself after a short pause (no OK needed);
 *    [data-noauto] items (toggles) still need OK
 */
type Dir = 'up' | 'down' | 'left' | 'right';

const KEY_DIR: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const lastInRow = new WeakMap<Element, HTMLElement>();
let backHandler: () => boolean = () => false;
let keyInterceptor: ((e: KeyboardEvent) => boolean) | null = null;
let smooth = true;

export function setBackHandler(fn: () => boolean) {
  backHandler = fn;
}
/** player etc. can take over raw keys (return true = handled) */
export function setKeyInterceptor(fn: ((e: KeyboardEvent) => boolean) | null) {
  keyInterceptor = fn;
}
export function setSmoothScroll(v: boolean) {
  smooth = v;
}

function visible(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.closest('[inert]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function currentScope(): HTMLElement {
  const scopes = document.querySelectorAll<HTMLElement>('[data-scope]');
  for (let i = scopes.length - 1; i >= 0; i--) if (visible(scopes[i])) return scopes[i];
  return document.body;
}

function focusables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-f]')).filter(visible);
}

export function focusEl(el: HTMLElement | null | undefined, scroll = true) {
  if (!el) return;
  el.focus({ preventScroll: true });
  const row = el.closest('[data-row]');
  if (row) lastInRow.set(row, el);
  if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
}

export function focusFirst(root: Element = currentScope()) {
  const auto = root.querySelector<HTMLElement>('[data-autofocus]');
  if (auto && visible(auto)) return focusEl(auto);
  const list = focusables(root);
  if (list.length) focusEl(list[0]);
}

/** current tab of a tab row */
function currentTab(row: Element): HTMLElement | null {
  const el = row.querySelector<HTMLElement>('[data-f].active:not([data-noauto])');
  return el && visible(el) ? el : null;
}

let autoTimer: number | null = null;
/** a tab focused with the remote opens after a short pause (passing over tabs doesn't load each) */
function autoSelect(el: HTMLElement) {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = null;
  if (!el.closest('[data-tabs]') || el.hasAttribute('data-noauto') || el.classList.contains('active')) return;
  autoTimer = window.setTimeout(() => {
    autoTimer = null;
    if (document.activeElement === el && el.isConnected) el.click();
  }, 350);
}

function center(r: DOMRect) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function best(from: HTMLElement, cands: HTMLElement[], dir: Dir): HTMLElement | null {
  const a = from.getBoundingClientRect();
  const ac = center(a);
  let bestEl: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of cands) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const bc = center(b);
    let primary: number;
    let secondary: number;
    switch (dir) {
      case 'right':
        if (b.left < a.right - 4 && bc.x <= ac.x + 1) continue;
        primary = Math.max(0, b.left - a.right);
        secondary = Math.abs(bc.y - ac.y);
        break;
      case 'left':
        if (b.right > a.left + 4 && bc.x >= ac.x - 1) continue;
        primary = Math.max(0, a.left - b.right);
        secondary = Math.abs(bc.y - ac.y);
        break;
      case 'down':
        if (b.top < a.bottom - 4 && bc.y <= ac.y + 1) continue;
        primary = Math.max(0, b.top - a.bottom);
        secondary = Math.abs(bc.x - ac.x);
        break;
      case 'up':
        if (b.bottom > a.top + 4 && bc.y >= ac.y - 1) continue;
        primary = Math.max(0, a.top - b.bottom);
        secondary = Math.abs(bc.x - ac.x);
        break;
    }
    const score = primary + secondary * (dir === 'up' || dir === 'down' ? 0.5 : 2);
    if (score < bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }
  return bestEl;
}

export function move(dir: Dir): boolean {
  const scope = currentScope();
  const active = document.activeElement as HTMLElement | null;
  if (!active || !scope.contains(active) || !active.hasAttribute('data-f')) {
    focusFirst(scope);
    return true;
  }
  const row = active.closest('[data-row]');
  // 1. horizontal moves stay inside the row
  if (row && (dir === 'left' || dir === 'right')) {
    const inRow = focusables(row);
    const t = best(active, inRow, dir);
    if (t) {
      focusEl(t);
      autoSelect(t);
      return true;
    }
    if (row.hasAttribute('data-row-lock')) return true;
  }
  const all = focusables(scope);
  const others = row && (dir === 'up' || dir === 'down') ? all.filter((e) => !row.contains(e)) : all;
  let target = best(active, others, dir);
  // a tab row lying between here and the target is never skipped (the closest wins)
  if (target && (dir === 'up' || dir === 'down')) {
    const a = active.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    let gap = Infinity;
    for (const r of scope.querySelectorAll<HTMLElement>('[data-row][data-tabs]')) {
      if (r === row || r.contains(target) || !visible(r)) continue;
      const rr = r.getBoundingClientRect();
      const between = dir === 'up' ? rr.bottom <= a.top + 4 && rr.top >= t.bottom - 4 : rr.top >= a.bottom - 4 && rr.bottom <= t.top + 4;
      const d = dir === 'up' ? a.top - rr.bottom : rr.top - a.bottom;
      const el = between && d < gap ? currentTab(r) || best(active, focusables(r), dir) : null;
      if (el) (gap = d), (target = el);
    }
  }
  // 2. entering a row: restore its remembered item
  if (target) {
    const trow = target.closest('[data-row]');
    const cur = trow && trow !== row && trow.hasAttribute('data-tabs') ? currentTab(trow) : null;
    if (cur) target = cur;
    else if (trow && trow !== row && (dir === 'up' || dir === 'down')) {
      const remembered = lastInRow.get(trow);
      if (remembered && remembered.isConnected && visible(remembered)) {
        const rr = remembered.getBoundingClientRect();
        if (rr.right > 0 && rr.left < innerWidth) target = remembered;
      }
    }
  }
  if (target) {
    focusEl(target);
    return true;
  }
  return false;
}

const isTextInput = (el: Element | null) =>
  !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes((el as HTMLInputElement).type)));

let lpTimer: number | null = null;
let lpFired = false;
let lastLp = 0;
/** fire a longpress once (touch long-press triggers both our timer and `contextmenu`) */
function fireLp(el: HTMLElement) {
  if (Date.now() - lastLp < 800) return;
  lastLp = Date.now();
  lpFired = true;
  el.dispatchEvent(new CustomEvent('longpress', { bubbles: true }));
}

function onKeyDown(e: KeyboardEvent) {
  if (keyInterceptor && keyInterceptor(e)) {
    e.preventDefault();
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const dir = KEY_DIR[e.key];
  if (dir) {
    if (isTextInput(active) && (dir === 'left' || dir === 'right')) {
      const inp = active as HTMLInputElement;
      const atEdge = dir === 'left' ? inp.selectionStart === 0 : inp.selectionEnd === inp.value.length;
      if (!atEdge) return;
    }
    if (move(dir)) e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && active?.hasAttribute('data-lp')) {
    e.preventDefault();
    if (e.repeat) return;
    lpFired = false;
    lpTimer = window.setTimeout(() => {
      lpTimer = null;
      fireLp(active);
    }, 600);
    return;
  }
  if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !isTextInput(active))) {
    if (backHandler()) e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key !== 'Enter') return;
  const active = document.activeElement as HTMLElement | null;
  if (!active?.hasAttribute('data-lp')) return;
  if (lpTimer) {
    clearTimeout(lpTimer);
    lpTimer = null;
    if (!lpFired) active.click();
  }
}

/** pointer long-press for touch/mouse */
function onPointerDown(e: PointerEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-lp]');
  if (!el) return;
  lpFired = false;
  const sx = e.clientX;
  const sy = e.clientY;
  const timer = window.setTimeout(() => {
    fireLp(el);
    navigator.vibrate?.(20);
  }, 550);
  const cancel = (ev: PointerEvent) => {
    if (ev.type === 'pointermove' && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 10) return;
    clearTimeout(timer);
    window.removeEventListener('pointerup', cancel);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('pointermove', cancel);
  };
  window.addEventListener('pointerup', cancel);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('pointermove', cancel);
}

function onClickCapture(e: MouseEvent) {
  if (lpFired) {
    lpFired = false;
    if ((e.target as HTMLElement).closest('[data-lp]')) {
      e.stopPropagation();
      e.preventDefault();
    }
  }
}

function onContextMenu(e: MouseEvent) {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-lp]');
  if (!el) return;
  e.preventDefault();
  fireLp(el);
}

export function installSpatialNav() {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('click', onClickCapture, true);
  window.addEventListener('contextmenu', onContextMenu);
}
