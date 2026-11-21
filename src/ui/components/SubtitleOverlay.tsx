import { useEffect, useRef, useState } from 'react';
import { cuesAt, type Cue } from '@/core/subs/parse';

/**
 * Renders external subtitles above the video, for both engines.
 * `getTime` returns the playhead in seconds (video.currentTime on the web; on Android the native
 * position, interpolated between its 500 ms updates). `offset` shifts every cue.
 */
export function SubtitleOverlay({ cues, offset, getTime, raised }: { cues: Cue[]; offset: number; getTime: () => number; raised: boolean }) {
  const [html, setHtml] = useState('');
  const last = useRef('');
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = cuesAt(cues, getTime() - offset);
      const next = now.map((c) => c.text.replace(/\n/g, '<br/>')).join('<br/>');
      if (next !== last.current) {
        last.current = next;
        setHtml(next);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cues, offset, getTime]);
  if (!html) return null;
  // cue text is sanitised by the parser (only <i>, <b>, <u> survive)
  return (
    <div className={`ext-subs ${raised ? 'raised' : ''}`} aria-live="off">
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
