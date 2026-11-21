import { Component, type ReactNode } from 'react';
import { t } from '@/core/i18n';

/**
 * Last-resort guard: a rendering error in one screen shows a message and a way out
 * instead of a black screen (e.g. data cached by an older version of the app).
 */
export class ErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[screen]', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" style={{ paddingTop: '20vh' }}>
        <h3>{t('error.title')}</h3>
        <p className="muted">{t('error.text')}</p>
        <div className="btn-row" style={{ justifyContent: 'center' }}>
          <button
            className="btn primary"
            data-f
            data-autofocus
            onClick={() => {
              this.props.onReset?.();
              this.setState({ error: null });
            }}
          >
            {t('error.retry')}
          </button>
          <button className="btn" data-f onClick={() => location.reload()}>{t('error.reload')}</button>
        </div>
      </div>
    );
  }
}
