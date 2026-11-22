import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '@/state/store';
import { t } from '@/core/i18n';
import { CyberNative } from '@/core/native';
import { isAndroidApp, isTvMode } from '@/core/platform';
import { IcClose } from '../icons';

/**
 * A YouTube video in YouTube's own embedded player (full screen, landscape on phones like the
 * app's player). "Open in YouTube" hands it to the YouTube app / site when embedding is refused
 * or on a TV remote.
 */
export function YouTubePage({ id, title }: { id: string; title?: string }) {
  const pop = useApp((s) => s.pop);
  const lang = useApp((s) => s.profile?.lang || 'fr');
  useEffect(() => {
    if (!isAndroidApp || isTvMode()) return;
    void CyberNative.setOrientation({ mode: 'landscape' }).catch(() => {});
    void CyberNative.setImmersive({ on: true }).catch(() => {});
    return () => {
      void CyberNative.setOrientation({ mode: 'auto' }).catch(() => {});
      void CyberNative.setImmersive({ on: false }).catch(() => {});
    };
  }, []);
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0&modestbranding=1&hl=${lang}`;
  const openApp = () => window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, '_blank');
  // above everything (top bar included): rendered at document level
  return createPortal(
    <div className="yt-page" data-scope>
      <iframe
        className="yt-frame"
        src={src}
        title={title || 'YouTube'}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
      <div className="yt-bar" data-row>
        <button className="icon-btn yt-close" data-f onClick={() => pop()} aria-label={t('common.close')}>
          <IcClose />
        </button>
        <div className="yt-title ellipsis">{title}</div>
        <button className="btn small" data-f data-autofocus={isTvMode() || undefined} onClick={openApp}>
          {t('yt.open')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
