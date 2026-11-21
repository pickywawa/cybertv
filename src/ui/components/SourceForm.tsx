import { useState } from 'react';
import { t, fmtDate } from '@/core/i18n';
import type { Source, SourceType } from '@/core/types';
import { credsFromM3uUrl, normalizeServer } from '@/core/sources/xtream';
import { dataWorker } from '@/core/workers';

export interface SourceDraft {
  type: SourceType;
  label: string;
  url: string;
  username: string;
  password: string;
  epg: string;
}

export const emptyDraft = (): SourceDraft => ({ type: 'xtream', label: '', url: '', username: '', password: '', epg: '' });

export function draftFromSource(s: Source, password = ''): SourceDraft {
  return { type: s.type, label: s.label, url: s.url, username: s.username || '', password, epg: (s.epgUrls || []).join('\n') };
}

export function draftValid(d: SourceDraft): boolean {
  if (d.type === 'm3u') return /^https?:\/\/.+/i.test(d.url.trim());
  return !!d.url.trim() && !!d.username.trim() && !!d.password;
}

export function SourceForm({ draft, onChange }: { draft: SourceDraft; onChange: (d: SourceDraft) => void }) {
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; msg?: string } | null>(null);
  const set = (p: Partial<SourceDraft>) => {
    setTest(null);
    onChange({ ...draft, ...p });
  };
  const onM3uUrl = (url: string) => {
    // an Xtream "get.php" link: switch to the richer Xtream API automatically
    const c = credsFromM3uUrl(url.trim());
    if (c) set({ type: 'xtream', url: c.server, username: c.username, password: c.password });
    else set({ url });
  };
  const runTest = async () => {
    setTest({ busy: true });
    const r = await dataWorker().testSource(
      { type: draft.type, url: draft.type === 'xtream' ? normalizeServer(draft.url) : draft.url.trim(), username: draft.username.trim() },
      draft.password,
    );
    const msg = r.ok
      ? `${t('onboard.testOk')}${r.account?.expiresAt ? ' · ' + t('onboard.expires', { date: fmtDate(r.account.expiresAt) }) : ''}`
      : t('onboard.testKo', { msg: r.message === 'auth' ? 'identifiants refusés' : r.message === 'notm3u' ? 'ce n’est pas une playlist M3U' : r.message });
    setTest({ ok: r.ok, msg });
  };
  return (
    <div className="form">
      <div className="seg" data-row>
        {(['xtream', 'm3u'] as const).map((k) => (
          <button key={k} data-f className={draft.type === k ? 'on' : ''} onClick={() => set({ type: k })}>
            {k === 'xtream' ? t('onboard.xtream') : t('onboard.m3u')}
          </button>
        ))}
      </div>
      <div className="field">
        <label>{t('onboard.label')}</label>
        <input className="input" data-f value={draft.label} onChange={(e) => set({ label: e.target.value })} placeholder="Ma source" />
      </div>
      {draft.type === 'm3u' ? (
        <div className="field">
          <label>{t('onboard.m3uUrl')}</label>
          <input className="input" data-f inputMode="url" value={draft.url} onChange={(e) => onM3uUrl(e.target.value)} placeholder="https://…/playlist.m3u" autoCapitalize="off" spellCheck={false} />
        </div>
      ) : (
        <>
          <div className="field">
            <label>{t('onboard.server')}</label>
            <input className="input" data-f inputMode="url" value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="http://exemple.com:8080" autoCapitalize="off" spellCheck={false} />
          </div>
          <div className="field">
            <label>{t('onboard.username')}</label>
            <input className="input" data-f value={draft.username} onChange={(e) => set({ username: e.target.value })} autoCapitalize="off" autoComplete="off" spellCheck={false} />
          </div>
          <div className="field">
            <label>{t('onboard.password')}</label>
            <input className="input" data-f type="password" value={draft.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
          </div>
        </>
      )}
      <div className="field">
        <label>{t('onboard.epg')}</label>
        <textarea className="input" data-f value={draft.epg} onChange={(e) => set({ epg: e.target.value })} rows={2} placeholder="https://xmltvfr.fr/xmltv/xmltv.xml.gz" spellCheck={false} />
      </div>
      <div className="btn-row">
        <button className="btn" data-f disabled={!draftValid(draft) || test?.busy} onClick={() => void runTest()}>
          {test?.busy ? t('common.testing') : t('common.test')}
        </button>
        {test?.msg && <span className={test.ok ? 'msg-ok' : 'msg-ko'}>{test.msg}</span>}
      </div>
    </div>
  );
}
