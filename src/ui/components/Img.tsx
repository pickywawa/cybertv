import { memo, useState } from 'react';
import { cleanName, hashColor, initials } from '@/core/util/text';
import { analysableLogoUrl, analyseLogo, imgUrl, knownTone, type LogoTone } from '@/core/images';

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

/**
 * Session memory of image urls: already decoded ones render instantly (no lazy-load delay, no fade)
 * when a tab is revisited; broken ones are skipped straight to the fallback instead of being retried.
 */
const LOADED = new Set<string>();
const FAILED = new Set<string>();

function ImgInner({ list: all, alt = '', label, className, contain, eager }: Props & { list: string[] }) {
  const list = all.filter((u) => !FAILED.has(u));
  // failed urls leave `list`, so the current candidate is always the first one
  const [, rerender] = useState(0);
  const [loaded, setLoaded] = useState(() => !!list[0] && LOADED.has(list[0]));
  const src = list[0];
  const known = !!src && LOADED.has(src);
  // logos: brightness check (dark logos are lightened on dark themes)
  const corsUrl = contain && src ? analysableLogoUrl(src) : null;
  const [tone, setTone] = useState<LogoTone | undefined>(() => (src ? knownTone(src) : undefined));
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
      className={[className, tone && tone !== 'ok' ? `logo-${tone}` : ''].filter(Boolean).join(' ') || undefined}
      src={corsUrl || imgUrl(src)}
      crossOrigin={corsUrl ? 'anonymous' : undefined}
      alt={alt}
      loading={eager || known ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      style={{ objectFit: contain ? 'contain' : undefined, opacity: loaded || known ? 1 : 0, transition: known ? undefined : 'opacity .2s' }}
      onLoad={(e) => {
        LOADED.add(src);
        if (corsUrl && tone === undefined) setTone(analyseLogo(src, e.currentTarget));
        setLoaded(true);
      }}
      onError={() => {
        FAILED.add(src);
        setLoaded(false);
        rerender((x) => x + 1);
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
