import { useEffect, useState } from 'react';
import { t } from '@/core/i18n';
import { CyberNative, type TvDevice, type TvInstallEvent } from '@/core/native';
import { proxify } from '@/core/net/http';
import { IcCheck, IcRefresh, IcTv } from '../icons';

/**
 * Settings › Install on a TV (Android phone): 1. turn on the TV's developer options and network
 * debugging, 2. pick the TV on the Wi-Fi network, 3. download + send + install (the TV asks once
 * to allow this phone), 4. done, with the advice to turn debugging off again.
 */
type Step = 'intro' | 'pick' | 'install' | 'done';

async function latestApkUrl(): Promise<string> {
  if (!__UPDATE_URL__) throw new Error('no update url');
  const res = await fetch(proxify(`${__UPDATE_URL__}?t=${Date.now()}`), { cache: 'no-store' });
  const m = (await res.json()) as { apk?: string };
  if (!m.apk) throw new Error('no apk');
  return m.apk;
}

export function TvInstall() {
  const [step, setStep] = useState<Step>('intro');
  const [tv, setTv] = useState<TvDevice | null>(null);
  const [model, setModel] = useState<string | undefined>();

  return (
    <div className="tvi">
      <ol className="tvi-steps">
        {(['intro', 'pick', 'install', 'done'] as Step[]).map((s, i) => (
          <li key={s} className={s === step ? 'on' : (['intro', 'pick', 'install', 'done'] as Step[]).indexOf(step) > i ? 'past' : ''}>
            <span>{i + 1}</span>
            {t(`tvi.step.${s}` as 'tvi.step.intro')}
          </li>
        ))}
      </ol>
      {step === 'intro' && <Intro onNext={() => setStep('pick')} />}
      {step === 'pick' && <Pick onPick={(d) => (setTv(d), setStep('install'))} onBack={() => setStep('intro')} />}
      {step === 'install' && tv && (
        <Install
          tv={tv}
          onDone={(m) => (setModel(m), setStep('done'))}
          onBack={() => setStep('pick')}
        />
      )}
      {step === 'done' && <Done name={model || tv?.name || tv?.ip} onAgain={() => setStep('pick')} />}
    </div>
  );
}

function Intro({ onNext }: { onNext: () => void }) {
  return (
    <div className="form">
      <p className="muted" style={{ lineHeight: 1.5 }}>{t('tvi.intro')}</p>
      <div className="tvi-howto">
        <h3>{t('tvi.how1')}</h3>
        <p>{t('tvi.how1Text')}</p>
        <h3>{t('tvi.how2')}</h3>
        <p>{t('tvi.how2Text')}</p>
        <p className="small dim">{t('tvi.howNote')}</p>
      </div>
      <div className="btn-row">
        <button className="btn primary" data-f data-autofocus onClick={onNext}>
          {t('tvi.done')}
        </button>
      </div>
    </div>
  );
}

function Pick({ onPick, onBack }: { onPick: (d: TvDevice) => void; onBack: () => void }) {
  const [list, setList] = useState<TvDevice[] | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setBusy(true);
    setList(null);
    try {
      const r = await CyberNative.tvScan();
      setList(r.devices);
    } catch {
      setList([]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => void scan(), []);
  const ipOk = /^\d{1,3}(\.\d{1,3}){3}$/.test(manual.trim());
  return (
    <div className="form">
      <p className="muted">{t('tvi.pickText')}</p>
      {busy && (
        <div className="tvi-scan">
          <span className="spinner" /> {t('tvi.scanning')}
        </div>
      )}
      {list && list.length === 0 && <p className="msg-ko">{t('tvi.none')}</p>}
      <div className="list">
        {(list || []).map((d) => (
          <button key={d.ip} className="list-item" data-f disabled={!d.adb} onClick={() => onPick(d)}>
            <IcTv />
            <span className="grow">
              <div style={{ fontWeight: 700 }}>{d.name || t('tvi.unnamed')}</div>
              <div className="small muted">
                {d.ip}
                {d.adb ? '' : ` · ${t('tvi.noDebug')}`}
              </div>
            </span>
          </button>
        ))}
      </div>
      <div className="field" style={{ marginTop: 16 }}>
        <label>{t('tvi.manual')}</label>
        <div className="btn-row" style={{ marginTop: 0 }}>
          <input className="input" data-f inputMode="decimal" placeholder="192.168.1.50" value={manual} onChange={(e) => setManual(e.target.value)} style={{ flex: 1 }} />
          <button className="btn" data-f disabled={!ipOk} onClick={() => onPick({ ip: manual.trim(), adb: true })}>
            {t('tvi.use')}
          </button>
        </div>
        <span className="small dim">{t('tvi.manualHelp')}</span>
      </div>
      <div className="btn-row">
        <button className="btn" data-f onClick={onBack}>
          {t('tvi.back')}
        </button>
        <button className="btn" data-f disabled={busy} onClick={() => void scan()}>
          <IcRefresh /> {t('tvi.rescan')}
        </button>
      </div>
    </div>
  );
}

function Install({ tv, onDone, onBack }: { tv: TvDevice; onDone: (model?: string) => void; onBack: () => void }) {
  const [ev, setEv] = useState<TvInstallEvent>({ step: 'download', pct: 0 });
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  useEffect(() => {
    let off = false;
    setError(null);
    setEv({ step: 'download', pct: 0 });
    const h = CyberNative.addListener('tvInstall', (e) => !off && setEv(e));
    void (async () => {
      try {
        const url = await latestApkUrl();
        const r = await CyberNative.tvInstall({ ip: tv.ip, url });
        if (!off) onDone(r.model);
      } catch (e) {
        if (!off) setError(String((e as Error)?.message || e));
      }
    })();
    return () => {
      off = true;
      void h.then((x) => x.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tv.ip, run]);
  const order: TvInstallEvent['step'][] = ['download', 'connect', 'approve', 'upload', 'install'];
  const cur = order.indexOf(ev.step);
  const label = (s: TvInstallEvent['step']) => t(`tvi.p.${s}` as 'tvi.p.download');
  return (
    <div className="form">
      <p className="muted">
        {t('tvi.to')} <strong>{tv.name || tv.ip}</strong>
      </p>
      <ul className="tvi-progress">
        {order.map((s, i) =>
          s === 'approve' && ev.step !== 'approve' && cur < i ? null : (
            <li key={s} className={i < cur ? 'ok' : i === cur ? (error ? 'ko' : 'on') : ''}>
              {i < cur ? <IcCheck /> : i === cur && !error ? <span className="spinner" /> : <span className="dot" />}
              <span>
                {label(s)}
                {i === cur && (s === 'download' || s === 'upload') && !error ? ` · ${ev.pct} %` : ''}
              </span>
            </li>
          ),
        )}
      </ul>
      {ev.step === 'approve' && !error && <div className="tvi-approve">{t('tvi.approve')}</div>}
      {error && (
        <>
          <p className="msg-ko">{explain(error)}</p>
          <div className="btn-row">
            <button className="btn primary" data-f data-autofocus onClick={() => setRun((n) => n + 1)}>
              {t('common.retry')}
            </button>
            <button className="btn" data-f onClick={onBack}>
              {t('tvi.back')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function explain(e: string): string {
  if (/not approved|timed out|timeout/i.test(e)) return t('tvi.err.approve');
  if (/refused|ECONNREFUSED|connect|unreachable|No route/i.test(e)) return t('tvi.err.connect');
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures/i.test(e)) return t('tvi.err.signature');
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/i.test(e)) return t('tvi.err.storage');
  if (/HTTP|download|no apk/i.test(e)) return t('tvi.err.download');
  if (/unsupported/i.test(e)) return t('tvi.err.unsupported');
  return `${t('tvi.err.other')} (${e.slice(0, 160)})`;
}

function Done({ name, onAgain }: { name?: string; onAgain: () => void }) {
  return (
    <div className="form">
      <div className="tvi-success">
        <IcCheck />
        <h2>{t('tvi.success', { name: name || 'TV' })}</h2>
        <p>{t('tvi.successText')}</p>
      </div>
      <div className="tvi-howto">
        <h3>{t('tvi.disable')}</h3>
        <p>{t('tvi.disableText')}</p>
      </div>
      <div className="btn-row">
        <button className="btn" data-f onClick={onAgain}>
          {t('tvi.another')}
        </button>
      </div>
    </div>
  );
}
