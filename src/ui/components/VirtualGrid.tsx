import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/**
 * Row-virtualized responsive grid. Scrolls with the nearest `.page` / `.stack-page` container,
 * so thousands of channels / movies stay smooth on low-end TV boxes.
 */
export function VirtualGrid<T>({
  items,
  minWidth,
  aspect,
  extraHeight,
  render,
  getKey,
  gap = 16,
  className = '',
}: {
  items: T[];
  minWidth: number;
  /** width / height of the thumbnail */
  aspect: number;
  /** meta text height under the thumbnail */
  extraHeight: number;
  render: (item: T, index: number) => ReactNode;
  getKey: (item: T) => string;
  gap?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current!;
    setScrollEl(el.closest<HTMLElement>('.stack-page, .page'));
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!scrollEl || !ref.current) return;
    const a = ref.current.getBoundingClientRect().top;
    const b = scrollEl.getBoundingClientRect().top;
    setOffset(a - b + scrollEl.scrollTop);
  }, [scrollEl, width, items.length]);

  const cols = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  const colW = width ? (width - gap * (cols - 1)) / cols : minWidth;
  const rowH = colW / aspect + extraHeight + gap;
  const rows = Math.ceil(items.length / cols);

  const v = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowH,
    overscan: 3,
    scrollMargin: offset,
  });

  useEffect(() => {
    v.measure();
  }, [rowH, v]);

  return (
    <div ref={ref} className={className} style={{ position: 'relative', height: rows * rowH }}>
      {width > 0 &&
        v.getVirtualItems().map((r) => (
          <div
            key={r.key}
            data-row
            style={{
              position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${r.start - offset}px)`,
              display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap,
            }}
          >
            {items.slice(r.index * cols, r.index * cols + cols).map((it, k) => (
              <div key={getKey(it)} style={{ minWidth: 0 }}>
                {render(it, r.index * cols + k)}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
