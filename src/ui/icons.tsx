import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const S = (d: string, fill = false) =>
  function Icon(p: P) {
    return (
      <svg viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
        <path d={d} />
      </svg>
    );
  };

export const IcHome = S('M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z');
export const IcSearch = S('M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.6-4.6');
export const IcTv = S('M3 5h18v12H3zM8 21h8M12 17v4');
export const IcGrid = S('M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z');
export const IcMore = S('M5 12h.01M12 12h.01M19 12h.01');
export const IcPlay = S('M7 4.5v15l13-7.5z', true);
export const IcPause = S('M6 4h4v16H6zM14 4h4v16h-4z', true);
export const IcBack10 = S('M3 12a9 9 0 1 0 3-6.7M3 4v5h5M10 15V9l-2 1M15 9a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2z');
export const IcFwd10 = S('M21 12a9 9 0 1 1-3-6.7M21 4v5h-5M10 15V9l-2 1M15 9a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2z');
export const IcRestart = S('M4 4v6h6M4.5 15a8 8 0 1 0 1.9-8.3L4 10');
export const IcClose = S('M6 6l12 12M18 6 6 18');
export const IcChevronRight = S('M9 6l6 6-6 6');
export const IcChevronLeft = S('M15 6l-6 6 6 6');
export const IcArrowLeft = S('M19 12H5M11 6l-6 6 6 6');
export const IcMic = S('M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3');
export const IcCalendar = S('M4 6h16v14H4zM4 10h16M8 3v5M16 3v5');
export const IcHeart = S('M12 20s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z');
export const IcHeartFill = S('M12 20s-7-4.4-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.6-9 9-9 9z', true);
export const IcPlus = S('M12 5v14M5 12h14');
export const IcCheck = S('M5 12l5 5 9-10');
export const IcSettings = S('M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z');
export const IcSubtitles = S('M3 5h18v14H3zM7 13h4M13 13h4M7 16h7');
export const IcAudio = S('M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14');
export const IcHd = S('M3 5h18v14H3zM7 9v6M7 12h4M11 9v6M14 9h2a3 3 0 0 1 0 6h-2z');
export const IcFullscreen = S('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5');
export const IcExitFullscreen = S('M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5');
export const IcPip = S('M3 5h18v14H3zM12 12h7v5h-7z');
export const IcList = S('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01');
export const IcHistory = S('M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3');
export const IcInfo = S('M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01');
export const IcRefresh = S('M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5');
export const IcTrash = S('M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3');
export const IcUp = S('M12 19V5M6 11l6-6 6 6');
export const IcDown = S('M12 5v14M6 13l6 6 6-6');
export const IcLock = S('M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4');
export const IcCast = S('M3 18a3 3 0 0 1 3 3M3 14a7 7 0 0 1 7 7M3 10a11 11 0 0 1 11 11M3 6V4h18v16h-5');
export const IcDownload = S('M12 3v12M6 11l6 6 6-6M4 21h16');
export const IcSpeed = S('M12 14l4-4M3.3 17A10 10 0 1 1 20.7 17');
export const IcAspect = S('M3 6h18v12H3zM7 10v4M17 10v4');
export const IcStar = S('M12 3l2.7 5.6 6.3.9-4.5 4.4 1 6.1L12 17l-5.5 3 1-6.1L3 9.5l6.3-.9z', true);
export const IcFilm = S('M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4');
export const IcSeries = S('M4 8h16v12H4zM8 4l4 4 4-4M9 12.5v4l3.5-2z');
export const IcKids = S('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14.5s1.2 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01');
export const IcGlobe = S('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18');
export const IcLive = S('M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8');
export const IcVolume = S('M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13');
export const IcVolumeOff = S('M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6');
export const IcLibrary = S('M4 5h11v14H4zM18 5v14M21 7v10M8 9.5v5l4-2.5z');
