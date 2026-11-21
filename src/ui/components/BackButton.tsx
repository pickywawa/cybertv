import { useApp } from '@/state/store';
import { t } from '@/core/i18n';
import { IcArrowLeft } from '../icons';

export function BackButton({ floating = true }: { floating?: boolean }) {
  const pop = useApp((s) => s.pop);
  return (
    <button className={`icon-btn ${floating ? 'back-btn' : ''}`} data-f onClick={() => pop()} aria-label={t('common.back')}>
      <IcArrowLeft />
    </button>
  );
}

export function PageHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 'calc(var(--nav-h) + 12px) var(--gutter) 8px' }} className="page-header">
      <BackButton floating={false} />
      <h1 className="section-title" style={{ flex: 1 }}>{title}</h1>
      {right}
    </div>
  );
}
