import type { ReactNode } from 'react';

export function Rail({ title, onSeeAll, seeAllLabel, children, id, className }: { title?: ReactNode; onSeeAll?: () => void; seeAllLabel?: string; children: ReactNode; id?: string; className?: string }) {
  return (
    <section className={`rail ${className || ''}`} id={id}>
      {(title || onSeeAll) && (
        <div className="rail-head">
          <h2 className="section-title">{title}</h2>
          {onSeeAll && (
            <button data-f onClick={onSeeAll}>
              {seeAllLabel}
            </button>
          )}
        </div>
      )}
      <div className="rail-track" data-row>
        {children}
      </div>
    </section>
  );
}
