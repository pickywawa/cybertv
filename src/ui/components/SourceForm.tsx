import { useState } from 'react';
import { t, fmtDate } from '@/core/i18n';
import type { Source, SourceType } from '@/core/types';
import { credsFromM3uUrl } from '@/core/sources/xtream';
import { dataWorker } from '@/core/workers';
import { normServer, serverLabel } from '@/core/sources/servers';
import type { ServerTest } from '@/core/sync/sync';
import { IcClose, IcPlus } from '../icons';

export interface SourceDraft {
  type: SourceType;
  label: string;
  url: string;
  username: string;
  password: string;
  epg: string;
  /** backup servers (Xtream) or playlists (M3U), tried in order on failure */
  backups: string[];
  /** server currently in use when it isn't the main one (failover / "Test") */
  active?: string;
}

export const emptyDraft = (): SourceDraft => ({ type: 'xtream', label: '', url: '', username: '', password: '', epg: '', backups: [] });

export function draftFromSource(s: Source, password = ''): SourceDraft {
  const servers = s.servers?.length ? s.servers : [s.url];
  return {
    type: s.type, label: s.label, url: servers[0], backups: servers.slice(1), active: s.url !== servers[0] ? s.url : undefined,
    username: s.username || '', password, epg: (s.epgUrls || []).join('\n'),
  };
}

/** fields for saveSource() */
export function draftInput(d: SourceDraft) {
  return {
    type: d.type, label: d.label, url: d.url, backups: d.backups.filter((u) => u.trim()), active: d.active,
    username: d.username, password: d.password, epgUrls: d.epg.split(/\s+/).map((x) => x.trim()).filter(Boolean),
  };
}

export function draftValid(d: SourceDraft): boolean {
  if (d.type === 'm3u') return /^https?:\/\/.+/i.test(d.url.trim());
  return !!d.url.trim() && !!d.username.trim() && !!d.password;
}

export function SourceForm({ draft, onChange }: { draft: SourceDraft; onChange: (d: SourceDraft) => void }) {
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; msg?: string; tried?: ServerTest[] } | null>(null);
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
  const norm = (u: string) => normServer(draft.type, u);
  const servers = [draft.url, ...draft.backups].filter((u) => u.trim());
  const why = (m: string) => {
    if (m === 'auth') return t('sources.authRefused');
    if (m === 'notm3u') return t('sources.notM3u');
    const http = m.match(/^HTTP (\d+)/);
    if (http) return Number(http[1]) >= 500 ? t('sources.unreachable') : `HTTP ${http[1]}`;
    if (/fetch|network|timeout|abort/i.test(m)) return t('sources.unreachable');
    return m;
  };
  const runTest = async () => {
    setTest({ busy: true });
    // same order as the app: the server in use first, then the others
    const r = await dataWorker().testSource(
      { type: draft.type, url: norm(draft.active || draft.url), servers: servers.map(norm), username: draft.username.trim() },
      draft.password,
    );
    let msg = r.ok
      ? `${t('onboard.testOk')}${r.account?.expiresAt ? ' · ' + t('onboard.expires', { date: fmtDate(r.account.expiresAt) }) : ''}`
      : t('onboard.testKo', { msg: why(r.message) });
    if (r.ok && r.server) {
      const main = norm(draft.url);
      // a backup answered: switch to it (saved with the source, kept at next start)
      if (r.server !== main) msg = `${t('sources.switched', { host: serverLabel(r.server) })} · ${msg}`;
      onChange({ ...draft, active: r.server !== main ? r.server : undefined });
    }
    setTest({ ok: r.ok, msg, tried: r.tried.length > 1 ? r.tried : undefined });
  };
  const isActive = (u: string) => !!u.trim() && norm(u) === norm(draft.active || draft.url) && servers.length > 1;
  const setBackup = (i: number, v: string) => set({ backups: draft.backups.map((b, k) => (k === i ? v : b)) });
  const backupsUi = (
    <div className="backups">
      {draft.backups.map((b, i) => (
        <div key={i} className="field">
          <label>{t('sources.backup', { n: i + 1 })} {isActive(b) && <ActiveBadge />}</label>
          <div className="backup-row" data-row>
            <input
              className="input"
              data-f
              inputMode="url"
              value={b}
              onChange={(e) => setBackup(i, e.target.value)}
              placeholder={draft.type === 'xtream' ? 'http://secours.exemple.com:8080' : 'https://…/playlist-secours.m3u'}
              autoCapitalize="off"
              spellCheck={false}
            />
            <button className="icon-btn" data-f onClick={() => set({ backups: draft.backups.filter((_, k) => k !== i), active: draft.active && norm(draft.active) === norm(b) ? undefined : draft.active })} aria-label={t('common.delete')}>
              <IcClose />
            </button>
          </div>
        </div>
      ))}
      <button className="btn small ghost add-backup" data-f onClick={() => set({ backups: [...draft.backups, ''] })}>
        <IcPlus /> {t('sources.addBackup')}
      </button>
      {draft.backups.length === 0 && <span className="small dim">{t('sources.backupHelp')}</span>}
    </div>
  );
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
          <label>{t('onboard.m3uUrl')} {isActive(draft.url) && <ActiveBadge />}</label>
          <input className="input" data-f inputMode="url" value={draft.url} onChange={(e) => onM3uUrl(e.target.value)} placeholder="https://…/playlist.m3u" autoCapitalize="off" spellCheck={false} />
          {backupsUi}
        </div>
      ) : (
        <>
          <div className="field">
            <label>{t('onboard.server')} {isActive(draft.url) && <ActiveBadge />}</label>
            <input className="input" data-f inputMode="url" value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="http://exemple.com:8080" autoCapitalize="off" spellCheck={false} />
          </div>
          {backupsUi}
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
      {test?.tried && (
        <ul className="tried">
          {test.tried.map((x) => (
            <li key={x.server} className={x.ok ? 'msg-ok' : 'msg-ko'}>
              {x.ok ? '✓' : '✗'} {serverLabel(x.server)}
              {!x.ok && <span className="dim"> · {why(x.message)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActiveBadge() {
  return <span className="active-badge">{t('sources.inUse')}</span>;
}
