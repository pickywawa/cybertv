import { useState } from 'react';
import { useApp } from '@/state/store';
import { t } from '@/core/i18n';
import { CyberNative } from '@/core/native';
import { installApk, installSilentNow } from '@/core/updater';
import { IcClose, IcDownload, IcRefresh } from '../icons';

/** "Update ready / available" banner: web bundles restart in place, APKs go to the system installer */
export function UpdateBanner() {
  const update = useApp((s) => s.update);
  const dismissed = useApp((s) => s.updateDismissed);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  if (update.kind === 'none' || dismissed) return null;
  const act = async () => {
    if (update.kind === 'web-ready') {
      await CyberNative.updateApplyWeb().catch(() => toast(t('update.failed')));
      return;
    }
    if (update.kind === 'desktop') {
      window.open(update.url, '_blank');
      return;
    }
    if (update.kind === 'apk-silent') {
      setBusy(true);
      await installSilentNow().catch(() => toast(t('update.failed')));
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const r = await installApk(update.url);
      if (r === 'permission') toast(t('update.permission'));
    } catch {
      toast(t('update.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="update-banner" role="status" data-row>
      <span className="ic">{update.kind === 'web-ready' ? <IcRefresh /> : <IcDownload />}</span>
      <span className="txt">
        <b>{update.kind === 'web-ready' || update.kind === 'apk-silent' ? t('update.webReady', { v: update.version }) : t('update.available', { v: update.version })}</b>
        <span className="small muted">{update.kind === 'web-ready' ? t('update.webReadySub') : update.kind === 'apk-silent' ? t('update.silentSub') : update.kind === 'desktop' ? t('update.desktopSub') : t('update.availableSub')}</span>
      </span>
      <button className="btn small primary" data-f disabled={busy} onClick={() => void act()}>
        {busy ? <span className="spinner" /> : update.kind === 'web-ready' ? t('update.restart') : update.kind === 'apk-silent' ? t('update.installNow') : update.kind === 'desktop' ? t('update.download') : t('update.install')}
      </button>
      <button className="icon-btn" data-f onClick={() => useApp.setState({ updateDismissed: true })} aria-label={t('common.close')}>
        <IcClose />
      </button>
    </div>
  );
}
