import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getMeta, setMeta } from '@/core/db';
import { t, fmtDate, fmtTime, setLang } from '@/core/i18n';
import type { Category, Profile, ThemeId } from '@/core/types';
import { moveSource, removeSource, setTmdbToken, updateProfile } from '@/core/profiles';
import { secureGet, tmdbKey } from '@/core/secure';
import { dataWorker, proxyCb } from '@/core/workers';
import { loadSecrets } from '@/core/repo';
import { useApp, applyTheme, type SettingsSection } from '@/state/store';
import { runSync, startEnrichment } from '@/app/services';
import { setSmoothScroll } from '../spatial';
import { isNative } from '@/core/platform';
import { CyberNative } from '@/core/native';
import { Toggle } from '../components/Overlay';
import { PageHeader } from '../components/BackButton';
import { PinPad } from '../components/PinPad';
import { IcChevronRight, IcDown, IcRefresh, IcTrash, IcUp } from '../icons';

const SECTIONS: SettingsSection[] = ['sources', 'services', 'appearance', 'player', 'parental', 'sync', 'categories', 'about'];

export function Settings() {
  const profile = useApp((s) => s.profile)!;
  const push = useApp((s) => s.push);
  return (
    <div className="settings">
      <h1>{t('settings.title')}</h1>
      <button className="list-item" data-f data-autofocus onClick={() => push({ name: 'profile-edit' })}>
        <span className="avatar" style={{ background: profile.color }}>{profile.emoji}</span>
        <span className="grow">
          <div style={{ fontWeight: 700 }}>{profile.name}</div>
          <div className="small muted">{t('settings.profile')}</div>
        </span>
        <IcChevronRight className="chev" />
      </button>
      <div className="list" style={{ marginTop: 8 }}>
        <button className="list-item" data-f onClick={() => push({ name: 'profiles' })}>
          <span className="grow">{t('settings.profiles')}</span>
          <IcChevronRight className="chev" />
        </button>
        {SECTIONS.map((s) => (
          <button key={s} className="list-item" data-f onClick={() => push({ name: 'settings-section', section: s })}>
            <span className="grow">{t(`settings.${s}` as 'settings.sources')}</span>
            <IcChevronRight className="chev" />
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingsSectionView({ section }: { section: SettingsSection }) {
  return (
    <div className="settings">
      <PageHeader title={t(`settings.${section}` as 'settings.sources')} />
      <div style={{ marginTop: 16 }}>
        {section === 'sources' && <SourcesSection />}
        {section === 'services' && <ServicesSection />}
        {section === 'appearance' && <AppearanceSection />}
        {section === 'player' && <PlayerSection />}
        {section === 'parental' && <ParentalSection />}
        {section === 'sync' && <SyncSection />}
        {section === 'categories' && <CategoriesSection />}
        {section === 'about' && <AboutSection />}
      </div>
    </div>
  );
}

function SourcesSection() {
  const profile = useApp((s) => s.profile)!;
  const push = useApp((s) => s.push);
  const toast = useApp((s) => s.toast);
  const sources = useLiveQuery(() => db.sources.where('profileId').equals(profile.id).sortBy('priority'), [profile.id]);
  const [busy, setBusy] = useState<string | null>(null);
  const syncOne = async (id: string) => {
    setBusy(id);
    const secrets = await loadSecrets(profile.id, true);
    const r = await dataWorker().syncSource(id, secrets[id], proxyCb(() => {}));
    setBusy(null);
    useApp.getState().bumpCatalog();
    toast(r?.status === 'ok' ? t('sync.done') : `${t('sync.error')} : ${r?.lastError || ''}`);
  };
  return (
    <div className="list">
      {(sources || []).map((s, i) => (
        <div key={s.id} className="card-box">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }} className="ellipsis">{s.label} <span className="dim small">· {s.type.toUpperCase()} · {t('settings.priority', { n: i + 1 })}</span></div>
              <div className={`status ${s.status}`}>{t(`settings.status.${s.status}` as 'settings.status.ok')}{s.lastSyncAt ? ` · ${fmtDate(s.lastSyncAt, { day: 'numeric', month: 'short' })} ${fmtTime(s.lastSyncAt)}` : ''}</div>
              {s.counts && <div className="small muted">{s.counts.live} {t('sync.live').toLowerCase()} · {s.counts.vod} {t('sync.vod').toLowerCase()} · {s.counts.series} {t('sync.series').toLowerCase()}</div>}
              {s.account?.expiresAt && <div className="small muted">{t('onboard.expires', { date: fmtDate(s.account.expiresAt) })}{s.account.maxConn ? ` · ${s.account.maxConn} conn.` : ''}</div>}
              {s.lastError && <div className="small msg-ko clamp2">{s.lastError}</div>}
            </div>
          </div>
          <div className="btn-row" data-row style={{ marginTop: 12 }}>
            <button className="btn small" data-f onClick={() => push({ name: 'source-edit', sourceId: s.id })}>{t('common.edit')}</button>
            <button className="btn small" data-f disabled={busy === s.id} onClick={() => void syncOne(s.id)}>
              {busy === s.id ? <span className="spinner" /> : <IcRefresh />} {t('sync.now')}
            </button>
            <button className="icon-btn" data-f disabled={i === 0} onClick={() => void moveSource(profile.id, s.id, -1).then(() => useApp.getState().bumpCatalog())} aria-label={t('settings.moveUp')}><IcUp /></button>
            <button className="icon-btn" data-f disabled={i === (sources?.length || 0) - 1} onClick={() => void moveSource(profile.id, s.id, 1).then(() => useApp.getState().bumpCatalog())} aria-label={t('settings.moveDown')}><IcDown /></button>
            <button className="btn small" data-f onClick={() => void db.sources.update(s.id, { enabled: !s.enabled }).then(() => useApp.getState().bumpCatalog())}>
              {s.enabled ? '✓ ' : ''}{t('settings.enabled')}
            </button>
            <button className="icon-btn" data-f onClick={() => void removeSource(s.id).then(() => useApp.getState().bumpCatalog())} aria-label={t('common.delete')}><IcTrash /></button>
          </div>
        </div>
      ))}
      <button className="btn primary" data-f onClick={() => push({ name: 'source-edit' })}>+ {t('settings.addSource')}</button>
    </div>
  );
}

function ServicesSection() {
  const profile = useApp((s) => s.profile)!;
  const [token, setToken] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'ko'>('idle');
  const save = async () => {
    setState('busy');
    const ok = await dataWorker().validateTmdb(token.trim());
    setState(ok ? 'ok' : 'ko');
    if (!ok) return;
    await setTmdbToken(profile.id, token.trim());
    useApp.getState().patchProfile({ hasTmdb: true });
    setToken('');
    await startEnrichment({ ...profile, hasTmdb: true });
  };
  const remove = async () => {
    await setTmdbToken(profile.id, null);
    useApp.getState().patchProfile({ hasTmdb: false });
    await startEnrichment({ ...profile, hasTmdb: false });
  };
  return (
    <div className="form">
      <p className="muted" style={{ lineHeight: 1.5 }}>{t('onboard.tmdbText')}</p>
      <div className={`status ${profile.hasTmdb ? 'ok' : ''}`}>{profile.hasTmdb ? t('settings.tmdbSet') : t('settings.tmdbMissing')}</div>
      <div className="field">
        <label>{t('onboard.tmdbToken')}</label>
        <input className="input" data-f type="password" value={token} onChange={(e) => (setToken(e.target.value), setState('idle'))} placeholder={profile.hasTmdb ? '••••••••••••' : ''} autoComplete="off" />
        <span className="small dim">{t('onboard.tmdbHelp')}</span>
      </div>
      <div className="btn-row">
        <button className="btn primary" data-f disabled={!token.trim() || state === 'busy'} onClick={() => void save()}>{state === 'busy' ? t('common.testing') : t('common.save')}</button>
        {profile.hasTmdb && <button className="btn danger" data-f onClick={() => void remove()}>{t('settings.tmdbRemove')}</button>}
        {state === 'ok' && <span className="msg-ok">{t('onboard.tmdbOk')}</span>}
        {state === 'ko' && <span className="msg-ko">{t('onboard.tmdbKo')}</span>}
      </div>
    </div>
  );
}

const ACCENTS = ['#4fe3a8', '#ff2e4d', '#ff7a00', '#f5c518', '#00b3ff', '#4f8cff', '#a855f7', '#ff4fd8'];

function AppearanceSection() {
  const profile = useApp((s) => s.profile)!;
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const patch = async (x: Partial<Profile>) => {
    await updateProfile(profile.id, x);
    useApp.getState().patchProfile(x);
    const p = { ...profile, ...x };
    applyTheme(p.theme, p.accent, settings.performance);
    if (x.lang) {
      setLang(x.lang);
      void startEnrichment(p);
    }
  };
  return (
    <div className="form">
      <h2>{t('settings.theme')}</h2>
      <div className="seg" data-row style={{ flexWrap: 'wrap' }}>
        {(['night', 'oled', 'midnight', 'light'] as ThemeId[]).map((th) => (
          <button key={th} data-f className={profile.theme === th ? 'on' : ''} onClick={() => void patch({ theme: th })}>{t(`theme.${th}` as 'theme.night')}</button>
        ))}
      </div>
      <h2>{t('settings.accent')}</h2>
      <div className="swatches" data-row>
        {ACCENTS.map((c) => (
          <button key={c} data-f className={`swatch ${(profile.accent || '#4fe3a8') === c ? 'on' : ''}`} style={{ background: c }} onClick={() => void patch({ accent: c === '#4fe3a8' ? undefined : c })} aria-label={c} />
        ))}
      </div>
      <h2>{t('settings.language')}</h2>
      <div className="seg" data-row>
        {(['fr', 'en'] as const).map((l) => (
          <button key={l} data-f className={profile.lang === l ? 'on' : ''} onClick={() => void patch({ lang: l })}>{l === 'fr' ? 'Français' : 'English'}</button>
        ))}
      </div>
      <div style={{ height: 8 }} />
      <Toggle
        label={t('settings.performance')}
        on={settings.performance}
        onChange={(v) => {
          update({ performance: v });
          setSmoothScroll(!v);
          applyTheme(profile.theme, profile.accent, v);
        }}
      />
    </div>
  );
}

const LANGS = [
  ['fr', 'Français'], ['en', 'English'], ['es', 'Español'], ['de', 'Deutsch'], ['it', 'Italiano'], ['ar', 'العربية'], ['pt', 'Português'],
] as const;

function PlayerSection() {
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const hh = Math.floor(settings.tonightStartMin / 60);
  const mm = settings.tonightStartMin % 60;
  return (
    <div className="form">
      <div className="field">
        <label>{t('settings.preferredAudio')}</label>
        <select className="select input" data-f value={settings.preferredAudio} onChange={(e) => update({ preferredAudio: e.target.value })}>
          {LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div className="field">
        <label>{t('settings.preferredSubs')}</label>
        <select className="select input" data-f value={settings.preferredSubs} onChange={(e) => update({ preferredSubs: e.target.value })}>
          <option value="off">{t('player.off')}</option>
          {LANGS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      <div className="field">
        <label>{t('settings.tonightStart')}</label>
        <input className="input" data-f type="time" value={`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`} onChange={(e) => {
          const [h, m] = e.target.value.split(':').map(Number);
          if (!isNaN(h)) update({ tonightStartMin: h * 60 + (m || 0) });
        }} />
      </div>
    </div>
  );
}

function ParentalSection() {
  const profile = useApp((s) => s.profile)!;
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const [pinFor, setPinFor] = useState<'set' | 'disable' | null>(null);
  const patch = async (x: Partial<Profile>) => {
    await updateProfile(profile.id, x);
    useApp.getState().patchProfile(x);
  };
  return (
    <div className="form">
      <Toggle
        label={t('settings.parentalOn')}
        on={profile.parental.enabled}
        onChange={(v) => setPinFor(v ? 'set' : 'disable')}
      />
      <Toggle label={t('settings.hideAdult')} on={settings.hideAdult} onChange={(v) => (profile.parental.enabled && !v ? setPinFor('disable') : update({ hideAdult: v }))} />
      {pinFor === 'set' && (
        <PinPad setMode title={t('settings.parentalPin')} onClose={() => setPinFor(null)} onOk={(pin) => (void patch({ parental: { enabled: true, pin } }), setPinFor(null))} />
      )}
      {pinFor === 'disable' && (
        <PinPad
          expected={profile.parental.pin}
          onClose={() => setPinFor(null)}
          onOk={() => {
            void patch({ parental: { enabled: false } });
            update({ hideAdult: false });
            setPinFor(null);
          }}
        />
      )}
    </div>
  );
}

function SyncSection() {
  const profile = useApp((s) => s.profile)!;
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const sync = useApp((s) => s.sync);
  const [epgAt, setEpgAt] = useState<number | undefined>();
  useEffect(() => void getMeta<number>(`epg:last:${profile.id}`).then(setEpgAt), [profile.id, sync.running]);
  const counts = useLiveQuery(async () => ({
    ch: await db.channels.where('profileId').equals(profile.id).count(),
    mv: await db.movies.where('profileId').equals(profile.id).count(),
    sr: await db.series.where('profileId').equals(profile.id).count(),
    pg: await db.programs.count(),
  }), [profile.id, sync.running]);
  return (
    <div className="form">
      <div className="card-box">
        <div>{t('sync.last', { date: profile.lastSyncAt ? `${fmtDate(profile.lastSyncAt)} ${fmtTime(profile.lastSyncAt)}` : t('time.never') })}</div>
        {epgAt && <div className="small muted">{t('sync.epg')} : {fmtDate(epgAt)} {fmtTime(epgAt)}</div>}
        {counts && <div className="small muted" style={{ marginTop: 6 }}>{counts.ch} · {counts.mv} · {counts.sr} · {counts.pg} EPG</div>}
        {sync.running && <div className="small" style={{ marginTop: 6 }}><span className="spinner" style={{ display: 'inline-block', verticalAlign: -4, marginRight: 8 }} />{sync.progress?.message || t('sync.running')}</div>}
        {sync.lastError && <div className="small msg-ko">{sync.lastError}</div>}
      </div>
      <div className="btn-row">
        <button className="btn primary" data-f disabled={sync.running} onClick={() => void runSync(profile.id)}><IcRefresh /> {t('sync.now')}</button>
      </div>
      <h2>{t('settings.syncInterval')}</h2>
      <div className="seg" data-row>
        {[6, 12, 24, 48].map((h) => (
          <button key={h} data-f className={settings.syncIntervalH === h ? 'on' : ''} onClick={() => update({ syncIntervalH: h })}>{t('settings.every', { n: h })}</button>
        ))}
      </div>
    </div>
  );
}

function CategoriesSection() {
  const profile = useApp((s) => s.profile)!;
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<Category['kind']>('live');
  useEffect(() => void getMeta<string[]>(`hiddenCats:${profile.id}`).then((l) => setHidden(new Set(l || []))), [profile.id]);
  const cats = useLiveQuery(() => db.categories.where('[profileId+kind]').equals([profile.id, kind]).sortBy('order'), [profile.id, kind]);
  const toggle = async (id: string) => {
    const n = new Set(hidden);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setHidden(n);
    await setMeta(`hiddenCats:${profile.id}`, [...n]);
    useApp.getState().bumpCatalog();
  };
  return (
    <div className="form">
      <p className="muted">{t('settings.categoriesHelp')}</p>
      <div className="seg" data-row>
        {(['live', 'vod', 'series'] as const).map((k) => (
          <button key={k} data-f className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'live' ? t('sync.live') : k === 'vod' ? t('sync.vod') : t('sync.series')}</button>
        ))}
      </div>
      <div className="list">
        {(cats || []).map((c) => (
          <Toggle key={c.id} label={c.name} sub={t(`universe.${c.universe}` as 'universe.sport')} on={!hidden.has(c.id)} onChange={() => void toggle(c.id)} />
        ))}
      </div>
    </div>
  );
}

function AboutSection() {
  return (
    <div className="form">
      <p style={{ lineHeight: 1.6 }}>{t('settings.aboutText')}</p>
      <p className="small muted">CyberIPTV 0.1.0 · Media3 / hls.js / mpegts.js · TMDB</p>
      <button className="btn" data-f onClick={async () => {
        if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
        if (isNative) await CyberNative.clearImageCache().catch(() => {});
        useApp.getState().toast('OK');
      }}>{t('settings.clearCache')}</button>
    </div>
  );
}

export async function hasTmdb(profileId: string) {
  return !!(await secureGet(tmdbKey(profileId)));
}
