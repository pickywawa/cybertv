import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { t } from '@/core/i18n';
import { isNative } from '@/core/platform';
import { CyberNative } from '@/core/native';
import { parsePayload, pollEnroll, startEnroll, stopEnroll, type EnrollPayload } from '@/core/enroll';
import { serverLabel } from '@/core/sources/servers';
import { IcCheck } from '../icons';
import { Toggle } from './Overlay';

/** QR code as an SVG path (white quiet zone, dark modules) */
export function QrCode({ text, size = 240 }: { text: string; size?: number }) {
  const { n, d } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { n, d };
  }, [text]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n + 8} ${n + 8}`} shapeRendering="crispEdges" role="img" aria-label={text}>
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

/**
 * TV side of the QR enrolment: shows the code, waits for the phone, then asks for confirmation.
 * `onImport(payload, withPrefs)` applies it; the local server stops when the panel closes.
 */
export function EnrollPanel({ onImport, onCancel }: { onImport: (p: EnrollPayload, withPrefs: boolean) => void | Promise<void>; onCancel?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<EnrollPayload | null>(null);
  const [withPrefs, setWithPrefs] = useState(true);
  const [busy, setBusy] = useState(false);
  const waiting = useRef(true);

  useEffect(() => {
    let alive = true;
    void startEnroll().then(
      (u) => alive && setUrl(u),
      (e) => alive && setError((e as Error).message),
    );
    const got = (p: EnrollPayload | null) => {
      if (p && waiting.current) {
        waiting.current = false;
        setPayload(p);
      }
    };
    const timer = window.setInterval(() => void pollEnroll().then(got, () => {}), 1500);
    const sub = isNative ? CyberNative.addListener('enrollReceived', (e) => got(parsePayload(e.payload))) : null;
    return () => {
      alive = false;
      clearInterval(timer);
      void sub?.then((h) => h.remove());
      void stopEnroll();
    };
  }, []);

  if (error) return <div className="enroll"><p className="msg-ko">{t('enroll.noNetwork')}</p></div>;

  if (payload) {
    return (
      <div className="enroll received" data-scope>
        <h2><IcCheck /> {t('enroll.received')}</h2>
        <ul className="enroll-list">
          {payload.sources.map((s, i) => (
            <li key={i}>
              <b>{s.label || serverLabel(s.url)}</b>
              <span className="small muted">
                {s.type.toUpperCase()} · {serverLabel(s.url)}
                {s.username ? ` · ${s.username}` : ''}
                {s.backups?.length ? ` · +${s.backups.length} ${t('enroll.backups')}` : ''}
              </span>
            </li>
          ))}
          {payload.tmdb && <li><b>TMDB</b><span className="small muted">{t('enroll.tmdbIncluded')}</span></li>}
        </ul>
        {payload.prefs && <Toggle label={t('enroll.withPrefs')} on={withPrefs} onChange={setWithPrefs} />}
        <div className="btn-row" data-row>
          <button
            className="btn primary"
            data-f
            data-autofocus
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onImport(payload, withPrefs);
              setBusy(false);
            }}
          >
            {t('enroll.import')}
          </button>
          <button className="btn" data-f onClick={() => ((waiting.current = true), setPayload(null))}>{t('enroll.reject')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="enroll" data-scope>
      <div className="enroll-qr">{url ? <QrCode text={url} /> : <div className="spinner big" />}</div>
      <div className="enroll-steps">
        <h2>{t('enroll.title')}</h2>
        <ol>
          <li>{t('enroll.step1')}</li>
          <li>{t('enroll.step2')}</li>
          <li>{t('enroll.step3')}</li>
        </ol>
        {url && <p className="small dim enroll-url">{url.replace(/\/[ae][a-z]*\/[a-f0-9]+$/, '/…')}</p>}
        <p className="small dim">{t('enroll.lanOnly')}</p>
        {onCancel && <button className="btn" data-f data-autofocus onClick={onCancel}>{t('common.cancel')}</button>}
      </div>
    </div>
  );
}
