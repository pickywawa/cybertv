import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/core/db';
import { t } from '@/core/i18n';
import { useApp } from '@/state/store';
import { applyEnroll, buildPhonePayload, pingTv, sendToTv } from '@/core/enroll';
import { serverLabel } from '@/core/sources/servers';
import { runSync, startEnrichment } from '@/app/services';
import { applyTheme } from '@/state/store';
import { setLang } from '@/core/i18n';
import { PageHeader } from '../components/BackButton';
import { EnrollPanel } from '../components/EnrollPanel';
import { Toggle } from '../components/Overlay';
import { IcCheck } from '../icons';

/** TV: add sources from a phone (Settings → Sources) */
export function EnrollScreen() {
  const profile = useApp((s) => s.profile)!;
  const pop = useApp((s) => s.pop);
  const toast = useApp((s) => s.toast);
  return (
    <div className="settings">
      <PageHeader title={t('enroll.fromPhone')} />
      <div style={{ marginTop: 16 }}>
        <EnrollPanel
          onCancel={() => pop()}
          onImport={async (p, withPrefs) => {
            await applyEnroll(profile.id, p, { prefs: withPrefs });
            const fresh = (await db.profiles.get(profile.id))!;
            useApp.getState().patchProfile(fresh);
            if (withPrefs && p.prefs?.lang) setLang(fresh.lang);
            applyTheme(fresh.theme, fresh.accent, useApp.getState().settings.performance);
            toast(t('enroll.imported', { n: p.sources.length }));
            pop();
            void runSync(profile.id).then(() => startEnrichment(fresh));
          }}
        />
      </div>
    </div>
  );
}

/** Phone (CyberIPTV app opened from the TV's page): send this profile's settings to the TV */
export function SendToTv({ target }: { target?: string }) {
  const profile = useApp((s) => s.profile)!;
  const pop = useApp((s) => s.pop);
  const sources = useLiveQuery(() => db.sources.where('profileId').equals(profile.id).sortBy('priority'), [profile.id]);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [withTmdb, setWithTmdb] = useState(true);
  const [withPrefs, setWithPrefs] = useState(true);
  const [reach, setReach] = useState<'checking' | 'ok' | 'ko'>('checking');
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle');

  useEffect(() => {
    if (sources && !picked) setPicked(new Set(sources.map((s) => s.id)));
  }, [sources, picked]);
  useEffect(() => {
    if (target) void pingTv(target).then((ok) => setReach(ok ? 'ok' : 'ko'));
  }, [target]);

  if (!target) {
    return (
      <div className="settings">
        <PageHeader title={t('enroll.sendTitle')} />
        <ol className="send-help">
          <li>{t('enroll.sendHelp1')}</li>
          <li>{t('enroll.sendHelp2')}</li>
          <li>{t('enroll.sendHelp3')}</li>
        </ol>
      </div>
    );
  }
  const send = async () => {
    setState('busy');
    try {
      const payload = await buildPhonePayload(profile, [...(picked || [])], withTmdb, withPrefs);
      setState((await sendToTv(target, payload)) ? 'sent' : 'error');
    } catch {
      setState('error');
    }
  };
  return (
    <div className="settings send-tv">
      <PageHeader title={t('enroll.sendTitle')} />
      {state === 'sent' ? (
        <div className="empty">
          <IcCheck width={48} height={48} color="var(--accent)" />
          <h3>{t('enroll.sent')}</h3>
          <p>{t('enroll.sentText')}</p>
          <button className="btn primary" data-f onClick={() => pop()}>{t('common.close')}</button>
        </div>
      ) : (
        <div className="form" style={{ marginTop: 12 }}>
          <p className={reach === 'ko' ? 'msg-ko' : 'muted'}>
            {reach === 'checking' ? t('enroll.checking') : reach === 'ok' ? t('enroll.tvFound', { host: serverLabel(target) }) : t('enroll.tvNotFound')}
          </p>
          <h2>{t('settings.sources')}</h2>
          <div className="list">
            {(sources || []).map((s) => (
              <Toggle
                key={s.id}
                label={s.label}
                sub={`${s.type.toUpperCase()} · ${serverLabel(s.url)}${(s.servers?.length || 0) > 1 ? ` · ${s.servers!.length} serveurs` : ''}`}
                on={!!picked?.has(s.id)}
                onChange={(v) => {
                  const n = new Set(picked);
                  if (v) n.add(s.id);
                  else n.delete(s.id);
                  setPicked(n);
                }}
              />
            ))}
          </div>
          {profile.hasTmdb && <Toggle label={t('enroll.sendTmdb')} on={withTmdb} onChange={setWithTmdb} />}
          <Toggle label={t('enroll.sendPrefs')} sub={t('enroll.sendPrefsSub')} on={withPrefs} onChange={setWithPrefs} />
          <p className="small dim">{t('enroll.lanOnly')}</p>
          <div className="btn-row">
            <button className="btn primary" data-f disabled={!picked?.size || state === 'busy' || reach === 'ko'} onClick={() => void send()}>
              {state === 'busy' ? <span className="spinner" /> : t('enroll.send')}
            </button>
            {state === 'error' && <span className="msg-ko">{t('enroll.tvNotFound')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
