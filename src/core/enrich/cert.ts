/**
 * Age ratings → minimum age (0 = all audiences). Covers the systems TMDB returns most:
 * FR (CNC/CSA), US (MPAA + TV Parental Guidelines), GB (BBFC), DE (FSK).
 */
const TABLE: Record<string, Record<string, number>> = {
  FR: { U: 0, TP: 0, '0': 0, '10': 10, '12': 12, '16': 16, '18': 18, '-10': 10, '-12': 12, '-16': 16, '-18': 18 },
  US: { G: 0, PG: 10, 'PG-13': 13, R: 17, 'NC-17': 18, NR: 0, 'TV-Y': 0, 'TV-Y7': 7, 'TV-G': 0, 'TV-PG': 10, 'TV-14': 14, 'TV-MA': 17 },
  GB: { U: 0, PG: 8, '12A': 12, '12': 12, '15': 15, '18': 18, R18: 18 },
  DE: { '0': 0, '6': 6, '12': 12, '16': 16, '18': 18 },
};

export function certToAge(country: string, cert: string): number | undefined {
  const c = cert.trim().toUpperCase();
  const t = TABLE[country];
  if (t && c in t) return t[c];
  const n = parseInt(c.replace(/^-/, ''), 10);
  return Number.isFinite(n) && n >= 0 && n <= 21 ? n : undefined;
}

/** "-12" style label, the French convention, whatever the source system */
export function ageLabel(certAge?: number, cert?: string): string | undefined {
  if (certAge === undefined) return cert || undefined;
  return certAge === 0 ? 'Tous publics' : `-${certAge}`;
}
