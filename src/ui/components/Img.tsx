import { memo, useState } from 'react';
import { cleanName, hashColor, initials } from '@/core/util/text';
import { imgUrl } from '@/core/images';

interface Props {
  srcs: (string | undefined | null)[];
  alt?: string;
  label?: string;
  className?: string;
  contain?: boolean;
  eager?: boolean;
}

/**
 * Lazy image with a fallback chain and a generated placeholder (never an empty box).
 * Keyed by the url list: when an item gets enriched (TMDB poster arrives after a provider
 * poster failed), the fallback index resets instead of staying stuck on the placeholder.
 */
export const Img = memo(function Img(p: Props) {
  const list = p.srcs.filter(Boolean) as string[];
  return <ImgInner key={list.join('|')} {...p} list={list} />;
});

function ImgInner({ list, alt = '', label, className, contain, eager }: Props & { list: string[] }) {
  const [i, setI] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const src = list[i];
  if (!src) {
    const l = label || alt || '?';
    // logo slots (contain) get a designed name tile instead of a generic placeholder
    if (contain) return <NameTile name={l} />;
    return (
      <div className="ph" style={{ background: hashColor(l) }}>
        <div>
          <div className="ini">{initials(l)}</div>
          {label && <div className="lbl clamp2">{label}</div>}
        </div>
      </div>
    );
  }
  return (
    <img
      key={src}
      className={className}
      src={imgUrl(src)}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      style={{ objectFit: contain ? 'contain' : undefined, opacity: loaded ? 1 : 0, transition: 'opacity .2s' }}
      onLoad={() => setLoaded(true)}
      onError={() => {
        setLoaded(false);
        setI((x) => x + 1);
      }}
    />
  );
}

/** Typographic stand-in for a missing channel logo */
export function NameTile({ name }: { name: string }) {
  const clean = cleanName(name);
  return (
    <div className="name-tile" style={{ ['--tile-hue' as string]: hashColor(clean).replace('45% 32%', '55% 42%') }} title={clean}>
      <span className="mono">{initials(clean)}</span>
      <span className="nm">{clean}</span>
    </div>
  );
}
