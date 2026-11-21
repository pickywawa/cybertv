import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/core/db';
import { t, setLang } from '@/core/i18n';
import type { Profile } from '@/core/types';
import { COLORS, EMOJIS, deleteProfile, updateProfile } from '@/core/profiles';
import { useApp, applyTheme } from '@/state/store';
import { selectProfile } from '@/app/services';
import { COUNTRIES, LANGUAGES } from '@/core/util/lang';
import { langPrefs, profileCountry, subMode } from '@/core/prefs';
import { Logo } from '@/app/App';
import { Onboarding } from './Onboarding';
import { PinPad } from '../components/PinPad';
import { Toggle } from '../components/Overlay';
import { PageHeader } from '../components/BackButton';
import { focusFirst } from '../spatial';
import { IcChevronRight, IcLock, IcPlus } from '../icons';

export function ProfilePicker() {
  const profiles = useLiveQuery(() => db.profiles.toArray(), []);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const [adding, setAdding] = useState(false);
  const [locked, setLocked] = useState<Profile | null>(null);

  useEffect(() => {
    if (profiles) requestAnimationFrame(() => focusFirst(document.querySelector('.profiles') || document.body));
  }, [profiles, adding]);

  if (adding) return <Onboarding onDone={() => setAdding(false)} />;
  if (!profiles) return null;

  const pick = (p: Profile) => {
    if (p.pin) return setLocked(p);
    go(p);
  };
  const go = (p: Profile) => {
    update({ defaultProfileId: p.id });
    void selectProfile(p);
  };

  return (
    <div className="center-screen">
      <Logo size={1.4} />
      <h1 style={{ fontSize: 'clamp(1.6rem,3vw,2.6rem)', marginTop: 30 }}>{t('profiles.who')}</h1>
      <div className="profiles" data-row>
        {profiles.map((p) => (
          <button key={p.id} className="profile-tile" data-f data-autofocus={p.id === settings.defaultProfileId || undefined} onClick={() => pick(p)}>
            <span className="avatar" style={{ background: p.color }}>{p.emoji}</span>
            <span className="name">
              {p.pin && <IcLock width={14} height={14} style={{ verticalAlign: -2, marginRight: 4 }} />}
              {p.name}
            </span>
          </button>
        ))}
        <button className="profile-tile" data-f onClick={() => setAdding(true)}>
          <span className="avatar" style={{ background: 'var(--surface-2)' }}>
            <IcPlus width={40} height={40} />
          </span>
          <span className="name">{t('profiles.add')}</span>
        </button>
      </div>
      <div style={{ width: 'min(420px, 100%)' }}>
        <Toggle label={t('profiles.dontAsk')} on={!settings.askProfile} onChange={(v) => update({ askProfile: !v })} />
      </div>
      {locked && <PinPad expected={locked.pin} onOk={() => go(locked)} onClose={() => setLocked(null)} />}
    </div>
  );
}

export function ProfilesManage() {
  const profiles = useLiveQuery(() => db.profiles.toArray(), []);
  const current = useApp((s) => s.profile);
  const push = useApp((s) => s.push);
  const [locked, setLocked] = useState<Profile | null>(null);
  const switchTo = (p: Profile) => {
    if (p.id === current?.id) return;
    if (p.pin) return setLocked(p);
    useApp.getState().updateSettings({ defaultProfileId: p.id });
    void selectProfile(p);
  };
  return (
    <div className="settings">
      <PageHeader title={t('settings.profiles')} />
      <div className="list" style={{ marginTop: 16 }}>
        {(profiles || []).map((p) => (
          <div key={p.id} className="list-item" data-row>
            <span className="avatar" style={{ background: p.color }}>{p.emoji}</span>
            <span className="grow">
              <div style={{ fontWeight: 600 }}>{p.name}</div>
              {p.id === current?.id && <div className="small muted">✓</div>}
            </span>
            {p.id !== current?.id && (
              <button className="btn small" data-f onClick={() => switchTo(p)}>{t('profiles.switch')}</button>
            )}
            <button className="btn small" data-f onClick={() => push({ name: 'profile-edit', profileId: p.id })}>{t('common.edit')}</button>
          </div>
        ))}
        <button className="list-item" data-f onClick={() => useApp.setState({ screen: 'profiles' })}>
          <IcPlus width={22} height={22} />
          <span className="grow">{t('profiles.add')}</span>
          <IcChevronRight className="chev" />
        </button>
      </div>
      {locked && (
        <PinPad
          expected={locked.pin}
          onOk={() => {
            useApp.getState().updateSettings({ defaultProfileId: locked.id });
            void selectProfile(locked);
          }}
          onClose={() => setLocked(null)}
        />
      )}
    </div>
  );
}

export function ProfileEdit({ profileId }: { profileId?: string }) {
  const current = useApp((s) => s.profile)!;
  const id = profileId || current.id;
  const p = useLiveQuery(() => db.profiles.get(id), [id]);
  const pop = useApp((s) => s.pop);
  const [pinMode, setPinMode] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  if (!p) return null;
  const patch = async (x: Partial<Profile>) => {
    await updateProfile(p.id, x);
    if (p.id === current.id) {
      useApp.getState().patchProfile(x);
      if (x.audioLangs || x.subLangs || x.country) useApp.getState().bumpCatalog();
      if (x.lang) setLang(x.lang);
      if (x.theme || x.accent !== undefined) applyTheme(x.theme || current.theme, x.accent ?? current.accent, useApp.getState().settings.performance);
    }
  };
  return (
    <div className="settings">
      <PageHeader title={p.name} />
      <div className="form" style={{ marginTop: 16 }}>
        <div className="field">
          <label>{t('profiles.name')}</label>
          <input className="input" data-f defaultValue={p.name} onBlur={(e) => void patch({ name: e.target.value.trim() || p.name })} maxLength={24} />
        </div>
        <div className="emoji-grid" data-row>
          {EMOJIS.map((e) => <button key={e} data-f className={p.emoji === e ? 'on' : ''} onClick={() => void patch({ emoji: e })}>{e}</button>)}
        </div>
        <div className="swatches" data-row>
          {COLORS.map((c) => <button key={c} data-f className={`swatch ${p.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => void patch({ color: c })} aria-label={c} />)}
        </div>
        <Toggle label={t('profiles.pin')} sub={p.pin ? '••••' : undefined} on={!!p.pin} onChange={(v) => (v ? setPinMode(true) : void patch({ pin: undefined }))} />

        <h2>{t('profiles.country')}</h2>
        <div className="field">
          <select className="select input" data-f value={profileCountry(p)} onChange={(e) => void patch({ country: e.target.value })}>
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.flag}  {c.name}</option>)}
          </select>
          <span className="small dim">{t('profiles.countryHelp')}</span>
        </div>

        <h2>{t('profiles.audio')}</h2>
        <LangPair
          value={langPrefs(p).audio}
          onChange={(v) => void patch({ audioLangs: v })}
        />
        <span className="small dim">{t('profiles.langHelp')}</span>

        <h2>{t('profiles.subtitles')}</h2>
        <LangPair value={langPrefs(p).subs} onChange={(v) => void patch({ subLangs: v })} />
        <div className="field">
          <label>{t('profiles.subMode')}</label>
          <div className="seg" data-row style={{ flexWrap: 'wrap' }}>
            {(['off', 'auto', 'always'] as const).map((m) => (
              <button key={m} data-f className={subMode(p) === m ? 'on' : ''} onClick={() => void patch({ subMode: m })}>{t(`profiles.subMode.${m}`)}</button>
            ))}
          </div>
        </div>
        <div className="btn-row" style={{ marginTop: 20 }}>
          {confirmDel ? (
            <>
              <span>{t('profiles.deleteConfirm', { name: p.name })}</span>
              <button className="btn danger" data-f onClick={async () => {
                await deleteProfile(p.id);
                if (p.id === current.id) location.reload();
                else pop();
              }}>{t('common.delete')}</button>
              <button className="btn" data-f onClick={() => setConfirmDel(false)}>{t('common.cancel')}</button>
            </>
          ) : (
            <button className="btn danger" data-f onClick={() => setConfirmDel(true)}>{t('common.delete')}</button>
          )}
        </div>
      </div>
      {pinMode && <PinPad setMode title={t('profiles.pin')} onOk={(pin) => (void patch({ pin }), setPinMode(false))} onClose={() => setPinMode(false)} />}
    </div>
  );
}

/** primary + optional secondary language pickers */
function LangPair({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [a, b] = value;
  return (
    <div className="lang-pair">
      <div className="field">
        <label>{t('profiles.primaryLang')}</label>
        <select className="select input" data-f value={a} onChange={(e) => onChange([e.target.value, ...(b && b !== e.target.value ? [b] : [])])}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag}  {l.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>{t('profiles.secondaryLang')}</label>
        <select className="select input" data-f value={b || ''} onChange={(e) => onChange(e.target.value ? [a, e.target.value] : [a])}>
          <option value="">{t('profiles.none')}</option>
          {LANGUAGES.filter((l) => l.code !== a).map((l) => <option key={l.code} value={l.code}>{l.flag}  {l.name}</option>)}
        </select>
      </div>
    </div>
  );
}
