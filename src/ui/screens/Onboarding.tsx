import { useEffect, useState } from 'react';
import { t, setLang } from '@/core/i18n';
import type { Lang, Profile } from '@/core/types';
import { COLORS, EMOJIS, createProfile, saveSource, setTmdbToken } from '@/core/profiles';
import { dataWorker } from '@/core/workers';
import { useApp } from '@/state/store';
import { runSync, selectProfile } from '@/app/services';
import { Logo } from '@/app/App';
import { SourceForm, draftInput, draftValid, emptyDraft, type SourceDraft } from '../components/SourceForm';
import { focusFirst } from '../spatial';
import { IcCheck, IcTrash } from '../icons';
import { db } from '@/core/db';
import { EnrollPanel } from '../components/EnrollPanel';
import { isTvMode } from '@/core/platform';
import { updateProfile } from '@/core/profiles';
import { canEnroll, type EnrollPayload } from '@/core/enroll';

const DEV_TMDB = (import.meta.env.DEV && (import.meta.env.VITE_DEV_TMDB_TOKEN as string)) || '';

export function Onboarding({ onDone }: { onDone?: () => void }) {
  const firstProfile = useApp((s) => s.screen) === 'onboarding';
  // a phone that installed the app here already created the profile: straight to its download
  const importedProfile = useApp((s) => s.importedProfile);
  const [step, setStep] = useState(importedProfile ? 3 : 0);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(EMOJIS[0]);
  const [color, setColor] = useState(COLORS[0]);
  const [lang, setLangState] = useState<Lang>(() => {
    const l: Lang = navigator.language.startsWith('fr') ? 'fr' : 'en';
    setLang(l);
    return l;
  });
  const [drafts, setDrafts] = useState<SourceDraft[]>([]);
  const [draft, setDraft] = useState<SourceDraft>(emptyDraft());
  const [token, setToken] = useState(DEV_TMDB);
  const [tokenState, setTokenState] = useState<'idle' | 'busy' | 'ok' | 'ko'>('idle');
  const [profile, setProfile] = useState<Profile | null>(importedProfile || null);
  // TV: the phone is the easiest way to enter credentials, so it is offered first
  const [qr, setQr] = useState(false);
  const [phonePrefs, setPhonePrefs] = useState<EnrollPayload['prefs'] | undefined>();
  /** sources came from the phone (web form, no profile): only the name is left to type */
  const [imported, setImported] = useState(false);
  const fromPhone = async (p: EnrollPayload, withPrefs: boolean) => {
    const phoneDrafts: SourceDraft[] = p.sources.map((s) => ({
      type: s.type, label: s.label, url: s.url, backups: s.backups || [], username: s.username || '', password: s.password || '',
      epg: (s.epgUrls || []).join('\n'),
    }));
    // the phone sent its profile: everything is created at once and the download starts
    if (p.profile) {
      if (p.prefs?.lang) changeLang(p.prefs.lang);
      await finishWith({
        name: p.profile.name, emoji: p.profile.emoji, color: p.profile.color, lang: p.prefs?.lang || lang,
        prefs: withPrefs ? p.prefs : undefined, drafts: [...drafts, ...phoneDrafts], token: p.tmdb || token,
      });
      setQr(false);
      return;
    }
    setImported(true);
    setDrafts((d) => [...d, ...phoneDrafts]);
    if (p.tmdb) setToken(p.tmdb);
    if (withPrefs && p.prefs) {
      setPhonePrefs(p.prefs);
      if (p.prefs.lang) changeLang(p.prefs.lang);
    }
    setDraft(emptyDraft());
    setQr(false);
    // a name is still needed when the phone (web form) didn't send a profile; the rest is done
    setStep(0);
  };

  const changeLang = (l: Lang) => {
    setLang(l);
    setLangState(l);
  };
  useEffect(() => {
    requestAnimationFrame(() => focusFirst(document.querySelector('.onboard') || document.body));
  }, [step, qr]);

  const allDrafts = draftValid(draft) ? [...drafts, draft] : drafts;

  const addAnother = () => {
    if (!draftValid(draft)) return;
    setDrafts([...drafts, draft]);
    setDraft(emptyDraft());
  };

  const useDemo = () =>
    setDraft({ type: 'xtream', label: 'Démo', url: `${location.origin}/mock-xtream`, username: 'demo', password: 'demo', epg: '', backups: [] });

  const testToken = async () => {
    setTokenState('busy');
    setTokenState((await dataWorker().validateTmdb(token.trim())) ? 'ok' : 'ko');
  };

  const finish = () =>
    finishWith({ name, emoji, color, lang, prefs: phonePrefs, drafts: allDrafts, token });

  const finishWith = async (o: { name: string; emoji: string; color: string; lang: Lang; prefs?: EnrollPayload['prefs']; drafts: SourceDraft[]; token: string }) => {
    const p = await createProfile({ name: o.name.trim(), emoji: o.emoji, color: o.color, lang: o.lang });
    if (o.prefs) {
      const patch = Object.fromEntries(Object.entries(o.prefs).filter(([k, v]) => v !== undefined && k !== 'lang')) as Partial<Profile>;
      if (Object.keys(patch).length) await updateProfile(p.id, patch);
    }
    for (const d of o.drafts) {
      await saveSource(p.id, draftInput(d));
    }
    if (o.token.trim()) await setTmdbToken(p.id, o.token.trim());
    const fresh = (await db.profiles.get(p.id))!;
    setProfile(fresh);
    setStep(3);
    void runSync(p.id);
  };

  return (
    <div className="center-screen" style={{ justifyContent: 'flex-start' }}>
      <div className="onboard" data-scope>
        <Logo size={1.3} />
        {firstProfile && step === 0 && (
          <>
            <h1 style={{ fontSize: '2rem', margin: '24px 0 8px' }}>{t('onboard.title')}</h1>
            <p className="muted">{t('onboard.subtitle')}</p>
          </>
        )}
        <div className="steps">
          {[0, 1, 2, 3].map((i) => <i key={i} className={i <= step ? 'on' : ''} />)}
        </div>

        {step === 0 && qr && <EnrollPanel auto onImport={fromPhone} onCancel={() => setQr(false)} />}

        {step === 0 && !qr && (
          <div className="form">
            {/* TV: the phone is the easiest way to set everything up (profile, sources, preferences) */}
            {canEnroll && (
              <button className={`btn ${isTvMode() ? 'primary' : ''} qr-cta`} data-f data-autofocus={isTvMode() || undefined} onClick={() => setQr(true)}>
                📱 {t('enroll.importAll')}
              </button>
            )}
            <h2>{t('onboard.step.profile')}</h2>
            <div className="field">
              <label>{t('profiles.name')}</label>
              <input className="input" data-f data-autofocus={!isTvMode() || undefined} value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" maxLength={24} />
            </div>
            <div className="emoji-grid" data-row>
              {EMOJIS.map((e) => (
                <button key={e} data-f className={emoji === e ? 'on' : ''} onClick={() => setEmoji(e)}>{e}</button>
              ))}
            </div>
            <div className="swatches" data-row>
              {COLORS.map((c) => (
                <button key={c} data-f className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
              ))}
            </div>
            <div className="field">
              <label>{t('settings.language')}</label>
              <div className="seg" data-row>
                {(['fr', 'en'] as const).map((l) => (
                  <button key={l} data-f className={lang === l ? 'on' : ''} onClick={() => changeLang(l)}>{l === 'fr' ? 'Français' : 'English'}</button>
                ))}
              </div>
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              {onDone && <button className="btn ghost" data-f onClick={onDone}>{t('common.cancel')}</button>}
              <button className="btn primary" data-f disabled={!name.trim()} onClick={() => (imported ? void finish() : setStep(1))}>{t('common.next')}</button>
            </div>
          </div>
        )}

        {step === 1 && qr && <EnrollPanel auto onImport={fromPhone} onCancel={() => setQr(false)} />}

        {step === 1 && !qr && (
          <div className="form">
            <h2>{t('onboard.step.source')}</h2>
            {canEnroll && (
              <button className={`btn ${isTvMode() ? 'primary' : ''} qr-cta`} data-f data-autofocus={isTvMode() || undefined} onClick={() => setQr(true)}>
                📱 {t('enroll.qrButton')}
              </button>
            )}
            {drafts.length > 0 && (
              <div className="list">
                {drafts.map((d, i) => (
                  <div key={i} className="list-item">
                    <IcCheck width={20} height={20} color="var(--ok)" />
                    <span className="grow ellipsis">{d.label || d.url} <span className="dim small">· {d.type.toUpperCase()}</span></span>
                    <button className="icon-btn" data-f onClick={() => setDrafts(drafts.filter((_, k) => k !== i))} aria-label={t('common.delete')}><IcTrash /></button>
                  </div>
                ))}
              </div>
            )}
            <SourceForm draft={draft} onChange={setDraft} />
            <div className="btn-row">
              <button className="btn" data-f disabled={!draftValid(draft)} onClick={addAnother}>+ {t('onboard.addAnother')}</button>
              {import.meta.env.DEV && <button className="btn ghost" data-f onClick={useDemo}>{t('onboard.demo')}</button>}
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn ghost" data-f onClick={() => setStep(0)}>{t('common.back')}</button>
              <button className="btn primary" data-f disabled={!allDrafts.length} onClick={() => setStep(2)}>{t('common.next')}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="form">
            <h2>{t('onboard.tmdbTitle')}</h2>
            <p className="muted" style={{ lineHeight: 1.5 }}>{t('onboard.tmdbText')}</p>
            <div className="field">
              <label>{t('onboard.tmdbToken')}</label>
              <input className="input" data-f data-autofocus type="password" value={token} onChange={(e) => (setToken(e.target.value), setTokenState('idle'))} autoComplete="off" spellCheck={false} />
              <span className="small dim">{t('onboard.tmdbHelp')}</span>
            </div>
            <div className="btn-row">
              <button className="btn" data-f disabled={!token.trim() || tokenState === 'busy'} onClick={() => void testToken()}>
                {tokenState === 'busy' ? t('common.testing') : t('common.test')}
              </button>
              {tokenState === 'ok' && <span className="msg-ok">{t('onboard.tmdbOk')}</span>}
              {tokenState === 'ko' && <span className="msg-ko">{t('onboard.tmdbKo')}</span>}
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn ghost" data-f onClick={() => setStep(1)}>{t('common.back')}</button>
              <button className="btn" data-f onClick={() => (setToken(''), void finish())}>{t('common.skip')}</button>
              <button className="btn primary" data-f disabled={!token.trim() || tokenState === 'ko'} onClick={() => void finish()}>{t('common.next')}</button>
            </div>
          </div>
        )}

        {step === 3 && profile && <SyncStep profile={profile} />}
      </div>
    </div>
  );
}

interface StepProgress {
  done?: number;
  total?: number;
  /** first time items were counted (rate → time left) */
  since?: number;
  sinceDone?: number;
  count?: number;
}

const fmtSecs = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
};

/**
 * First download, step by step: items saved out of the list size, time left (from the speed of
 * the current step), elapsed time — the first sync of a big catalogue takes minutes on a TV.
 */
function SyncStep({ profile }: { profile: Profile }) {
  const sync = useApp((s) => s.sync);
  const [steps, setSteps] = useState<Record<string, StepProgress>>({});
  const [startedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tm = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tm);
  }, []);
  useEffect(() => {
    const p = sync.progress;
    if (!p || !['live', 'vod', 'series', 'epg'].includes(p.step)) return;
    setSteps((all) => {
      const cur = { ...(all[p.step] || {}) };
      if (p.total !== undefined) {
        cur.total = p.total;
        cur.done = p.done ?? 0;
        if (cur.since === undefined || (p.done ?? 0) === 0) {
          cur.since = Date.now();
          cur.sinceDone = p.done ?? 0;
        }
      }
      if (p.step === 'epg' && p.count) cur.count = (cur.count || 0) + p.count;
      else if (p.count !== undefined) cur.count = (cur.count || 0) + p.count;
      return { ...all, [p.step]: cur };
    });
  }, [sync.progress]);
  const active = sync.running ? sync.progress?.step : undefined;
  const order = ['live', 'vod', 'series', 'epg'] as const;
  const activeIdx = order.indexOf(active as (typeof order)[number]);
  const ready = steps.live?.count !== undefined || (!sync.running && sync.progress);
  const nf = new Intl.NumberFormat();
  return (
    <div className="form sync-step">
      <h2>{t('onboard.syncing')}</h2>
      <p className="small muted">{t('sync.elapsed', { t: fmtSecs((now - startedAt) / 1000) })}</p>
      <div className="list">
        {order.map((s, i) => {
          const st = steps[s] || {};
          const isActive = s === active;
          const done = !isActive && (st.count !== undefined || (activeIdx > i && activeIdx >= 0) || (!sync.running && !!sync.progress));
          let detail = '';
          let left = '';
          let pct: number | undefined;
          if (isActive && st.total) {
            pct = Math.min(1, (st.done || 0) / st.total);
            detail = `${nf.format(st.done || 0)} / ${nf.format(st.total)}`;
            const elapsed = (Date.now() - (st.since || Date.now())) / 1000;
            const rate = elapsed > 2 ? ((st.done || 0) - (st.sinceDone || 0)) / elapsed : 0;
            if (rate > 0) left = t('sync.left', { t: fmtSecs((st.total - (st.done || 0)) / rate) });
          } else if (isActive && s === 'epg' && st.count) detail = t('sync.programs', { n: nf.format(st.count) });
          else if (isActive) detail = t('sync.downloading');
          else if (done && st.count !== undefined) detail = nf.format(st.count);
          return (
            <div key={s} className={`list-item sync-row ${isActive ? 'on' : ''}`}>
              {isActive ? <span className="spinner" /> : done ? <IcCheck width={20} height={20} color="var(--ok)" /> : <span style={{ width: 20 }} />}
              <span className="grow">
                <span className="sync-row-top">
                  <span>{t(`sync.${s}` as 'sync.live')}</span>
                  <span className="muted small">{detail}</span>
                </span>
                {pct !== undefined && (
                  <span className="sync-bar">
                    <i style={{ width: `${Math.max(2, pct * 100)}%` }} />
                  </span>
                )}
                {left && <span className="small dim">{left}</span>}
              </span>
            </div>
          );
        })}
      </div>
      {sync.lastError && <p className="msg-ko">{sync.lastError}</p>}
      <p className="small dim">{t('sync.longHint')}</p>
      <button className="btn primary" data-f data-autofocus disabled={!ready} onClick={() => (useApp.setState({ importedProfile: undefined }), void selectProfile(profile))}>
        {t('onboard.start')}
      </button>
    </div>
  );
}
