import { useEffect, useState } from 'react';
import { t } from '@/core/i18n';
import { CyberNative, type TvDevice, type TvInstallEvent } from '@/core/native';
import { proxify } from '@/core/net/http';
import { IcCheck, IcRefresh, IcTv } from '../icons';
import { useApp } from '@/state/store';
import { db } from '@/core/db';
import { buildPhonePayload, importLink } from '@/core/enroll';
import { Toggle } from '../components/Overlay';

/**
 * Settings › Install on a TV (Android phone): 1. turn on the TV's developer options and network
 * debugging, 2. pick the TV on the Wi-Fi network, 3. download + send + install (the TV asks once
 * to allow this phone), 4. done, with the advice to turn debugging off again.
 */
type Step = 'intro' | 'pick' | 'install' | 'done';

async function latestApkUrl(): Promise<string> {
  // test builds only: a local APK instead of the published one
  const dbg = import.meta.env.VITE_DEBUG ? (window as unknown as { __tviApk?: string }).__tviApk : undefined;
  if (dbg) return dbg;
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
  /** also hand this phone's profile and sources to the TV (opened with them right after the install) */
  const [withConfig, setWithConfig] = useState(true);

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
      {step === 'pick' && <Pick onPick={(d) => (setTv(d), setStep('install'))} onBack={() => setStep('intro')} withConfig={withConfig} setWithConfig={setWithConfig} />}
      {step === 'install' && tv && (
        <Install
          tv={tv}
          withConfig={withConfig}
          onDone={(m) => (setModel(m), setStep('done'))}
          onBack={() => setStep('pick')}
        />
      )}
      {step === 'done' && <Done name={model || tv?.name || tv?.ip} withConfig={withConfig} />}
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
        <p>{t('tvi.how2Wireless')}</p>
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

function Pick({ onPick, onBack, withConfig, setWithConfig }: { onPick: (d: TvDevice) => void; onBack: () => void; withConfig: boolean; setWithConfig: (v: boolean) => void }) {
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
  const m = manual.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?$/);
  const ipOk = !!m;
  const manualDevice = (): TvDevice => (m?.[2] && m[2] !== '5555' ? { ip: m[1], adb: false, tlsPort: Number(m[2]) } : { ip: m![1], adb: true });
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
          <button key={d.ip} className="list-item" data-f disabled={!d.adb && !d.tlsPort} onClick={() => onPick(d)}>
            <IcTv />
            <span className="grow">
              <div style={{ fontWeight: 700 }}>{d.name || t('tvi.unnamed')}</div>
              <div className="small muted">
                {d.ip}
                {d.adb ? '' : d.tlsPort ? ` · ${t('tvi.wireless')}` : ` · ${t('tvi.noDebug')}`}
              </div>
            </span>
          </button>
        ))}
      </div>
      <Toggle label={t('tvi.withConfig')} sub={t('tvi.withConfigHint')} on={withConfig} onChange={setWithConfig} />
      <div className="field" style={{ marginTop: 16 }}>
        <label>{t('tvi.manual')}</label>
        <div className="btn-row" style={{ marginTop: 0 }}>
          <input className="input" data-f inputMode="decimal" placeholder="192.168.1.50" value={manual} onChange={(e) => setManual(e.target.value)} style={{ flex: 1 }} />
          <button className="btn" data-f disabled={!ipOk} onClick={() => onPick(manualDevice())}>
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

/** this phone's profile + enabled sources (+ TMDB key), opened by the TV right after the install */
async function configLink(): Promise<string | undefined> {
  const profile = useApp.getState().profile;
  if (!profile) return undefined;
  const sources = (await db.sources.where('profileId').equals(profile.id).toArray()).filter((s) => s.enabled);
  if (!sources.length) return undefined;
  return importLink(await buildPhonePayload(profile, sources.map((s) => s.id), true, true));
}

function Install({ tv, withConfig, onDone, onBack }: { tv: TvDevice; withConfig: boolean; onDone: (model?: string) => void; onBack: () => void }) {
  const [ev, setEv] = useState<TvInstallEvent>({ step: 'download', pct: 0 });
  const [error, setError] = useState<string | null>(null);
  const [needPair, setNeedPair] = useState(false);
  const [run, setRun] = useState(0);
  const port = tv.adb ? 5555 : tv.tlsPort || 5555;
  useEffect(() => {
    let off = false;
    setError(null);
    setNeedPair(false);
    setEv({ step: 'download', pct: 0 });
    const h = CyberNative.addListener('tvInstall', (e) => !off && setEv(e));
    void (async () => {
      try {
        const url = await latestApkUrl();
        const launch = withConfig ? await configLink() : undefined;
        const r = await CyberNative.tvInstall({ ip: tv.ip, port, url, launch });
        if (!off) onDone(r.model);
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        // wireless debugging that doesn't know this phone yet: pairing with the TV's code
        if (!off && /not paired/i.test(msg)) setNeedPair(true);
        else if (!off) setError(msg);
      }
    })();
    return () => {
      off = true;
      void h.then((x) => x.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tv.ip, run]);
  const order: TvInstallEvent['step'][] = ['download', 'connect', 'approve', 'upload', 'install', 'launch'];
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
      {needPair && <PairForm tv={tv} onPaired={() => setRun((n) => n + 1)} />}
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

/** wireless debugging: the 6-digit code shown by the TV (port found on the network, or typed) */
function PairForm({ tv, onPaired }: { tv: TvDevice; onPaired: () => void }) {
  const [code, setCode] = useState('');
  const [port, setPort] = useState(tv.pairPort ? String(tv.pairPort) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = /^\d{6}$/.test(code.trim());
  const pair = async () => {
    setBusy(true);
    setErr(null);
    try {
      await CyberNative.tvPair({ ip: tv.ip, code: code.trim(), port: Number(port) || undefined });
      onPaired();
    } catch (e) {
      const m = String((e as Error)?.message || e);
      setErr(/wrong code/i.test(m) ? t('tvi.err.code') : /no pairing port/i.test(m) ? t('tvi.err.pairPort') : /unsupported/i.test(m) ? t('tvi.err.pairOld') : `${t('tvi.err.pair')} (${m.slice(0, 120)})`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tvi-howto">
      <h3>{t('tvi.pairTitle')}</h3>
      <p>{t('tvi.pairText')}</p>
      <div className="field">
        <label>{t('tvi.pairCode')}</label>
        <input className="input tvi-code" data-f data-autofocus inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
      </div>
      <div className="field">
        <label>{t('tvi.pairPort')}</label>
        <input className="input" data-f inputMode="numeric" placeholder={t('tvi.pairPortAuto')} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} />
        <span className="small dim">{t('tvi.pairPortHelp')}</span>
      </div>
      <div className="btn-row">
        <button className="btn primary" data-f disabled={!ok || busy} onClick={() => void pair()}>
          {busy ? <span className="spinner" /> : null} {t('tvi.pairGo')}
        </button>
        {err && <span className="msg-ko">{err}</span>}
      </div>
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

function Done({ name, withConfig }: { name?: string; withConfig: boolean }) {
  const pop = useApp((s) => s.pop);
  return (
    <div className="form">
      <div className="tvi-success">
        <IcCheck />
        <h2>{t('tvi.success', { name: name || 'TV' })}</h2>
        <p>{t(withConfig ? 'tvi.successConfig' : 'tvi.successText')}</p>
      </div>
      <div className="tvi-howto">
        <h3>{t('tvi.disable')}</h3>
        <p>{t('tvi.disableText')}</p>
      </div>
      <div className="btn-row">
        <button className="btn primary" data-f data-autofocus onClick={() => pop()}>
          {t('tvi.finish')}
        </button>
      </div>
    </div>
  );
}
