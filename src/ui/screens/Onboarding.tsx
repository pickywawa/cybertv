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
  const [step, setStep] = useState(0);
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
  const [profile, setProfile] = useState<Profile | null>(null);
  // TV: the phone is the easiest way to enter credentials, so it is offered first
  const [qr, setQr] = useState(false);
  const [phonePrefs, setPhonePrefs] = useState<EnrollPayload['prefs'] | undefined>();
  const fromPhone = (p: EnrollPayload, withPrefs: boolean) => {
    setDrafts((d) => [
      ...d,
      ...p.sources.map((s) => ({
        type: s.type, label: s.label, url: s.url, backups: s.backups || [], username: s.username || '', password: s.password || '',
        epg: (s.epgUrls || []).join('\n'),
      })),
    ]);
    if (p.tmdb) setToken(p.tmdb);
    if (withPrefs && p.prefs) {
      setPhonePrefs(p.prefs);
      if (p.prefs.lang) changeLang(p.prefs.lang);
    }
    setDraft(emptyDraft());
    setQr(false);
    setStep(2);
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

  const finish = async () => {
    const p = await createProfile({ name, emoji, color, lang });
    if (phonePrefs) {
      const patch = Object.fromEntries(Object.entries(phonePrefs).filter(([k, v]) => v !== undefined && k !== 'lang')) as Partial<Profile>;
      if (Object.keys(patch).length) await updateProfile(p.id, patch);
    }
    for (const d of allDrafts) {
      await saveSource(p.id, draftInput(d));
    }
    if (token.trim()) await setTmdbToken(p.id, token.trim());
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

        {step === 0 && (
          <div className="form">
            <h2>{t('onboard.step.profile')}</h2>
            <div className="field">
              <label>{t('profiles.name')}</label>
              <input className="input" data-f data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" maxLength={24} />
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
              <button className="btn primary" data-f disabled={!name.trim()} onClick={() => setStep(1)}>{t('common.next')}</button>
            </div>
          </div>
        )}

        {step === 1 && qr && <EnrollPanel onImport={fromPhone} onCancel={() => setQr(false)} />}

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

function SyncStep({ profile }: { profile: Profile }) {
  const sync = useApp((s) => s.sync);
  // counts per source, summed per step
  const [bySource, setBySource] = useState<Record<string, number>>({});
  useEffect(() => {
    const p = sync.progress;
    if (p?.count !== undefined && (p.step === 'live' || p.step === 'vod' || p.step === 'series')) setBySource((s) => ({ ...s, [`${p.step}|${p.sourceId}`]: p.count! }));
    if (p?.step === 'epg' && p.count) setBySource((s) => ({ ...s, 'epg|': (s['epg|'] || 0) + p.count! }));
  }, [sync.progress]);
  const seen: Record<string, number> = {};
  for (const [k, v] of Object.entries(bySource)) {
    const step = k.split('|')[0];
    seen[step] = (seen[step] || 0) + v;
  }
  const ready = seen.live !== undefined || (!sync.running && sync.progress);
  const steps = ['live', 'vod', 'series', 'epg'] as const;
  return (
    <div className="form">
      <h2>{t('onboard.syncing')}</h2>
      <div className="list">
        {steps.map((s) => {
          const active = sync.running && sync.progress?.step === s;
          const done = seen[s] !== undefined && !active;
          return (
            <div key={s} className="list-item">
              {active ? <span className="spinner" /> : done ? <IcCheck width={20} height={20} color="var(--ok)" /> : <span style={{ width: 18 }} />}
              <span className="grow">{t(`sync.${s}` as 'sync.live')}</span>
              <span className="muted">{seen[s] ?? ''}</span>
            </div>
          );
        })}
      </div>
      {sync.lastError && <p className="msg-ko">{sync.lastError}</p>}
      {sync.progress?.message && sync.running && <p className="small dim ellipsis">{sync.progress.message}</p>}
      <button className="btn primary" data-f data-autofocus disabled={!ready} onClick={() => void selectProfile(profile)}>
        {t('onboard.start')}
      </button>
    </div>
  );
}
