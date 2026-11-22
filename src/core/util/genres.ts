/**
 * Sub-categories of the movie / series screens ("Drame", "Comédie", "Action"…). A title belongs to
 * one through its TMDB genres (once enriched) or its provider category name ("COMEDIE [FR]",
 * "ACTION [EN]", "KOMEDIE [NL]"…), so they work before enrichment too.
 */
export interface GenreDef {
  key: string;
  fr: string;
  en: string;
  re: RegExp;
}

export const GENRES: GenreDef[] = [
  { key: 'action', fr: 'Action', en: 'Action', re: /\b(action|actie|azione|acci[oó]n|aksiyon|akcja|actionfilm)/i },
  { key: 'comedy', fr: 'Comédie', en: 'Comedy', re: /(com[eé]d|komedi|comedy|commedia|humou?r|komödie)/i },
  { key: 'drama', fr: 'Drame', en: 'Drama', re: /(drame|drama|dramma|dramat)/i },
  { key: 'thriller', fr: 'Thriller & policier', en: 'Thriller & crime', re: /(thriller|crime|polic|polar|krimi|crimin|myst[eè]re|mystery|suspense)/i },
  { key: 'horror', fr: 'Horreur', en: 'Horror', re: /(horr|griezel|terror|[eé]pouvante|grusel)/i },
  { key: 'scifi', fr: 'Science-fiction', en: 'Sci-fi', re: /(science.?fiction|sci.?fi|\bsf\b|ciencia ficci)/i },
  { key: 'fantasy', fr: 'Fantastique', en: 'Fantasy', re: /(fantas)/i },
  { key: 'adventure', fr: 'Aventure', en: 'Adventure', re: /(aventur|adventure|abenteuer|avventura)/i },
  { key: 'animation', fr: 'Animation', en: 'Animation', re: /(anim|cartoon|dessin|manga|crtani|bajki)/i },
  { key: 'family', fr: 'Famille & jeunesse', en: 'Family & kids', re: /(famil|kids|enfant|jeunesse|kinder|ni[ñn]os|barn|b[øo]rn|lasten|krakka)/i },
  { key: 'romance', fr: 'Romance', en: 'Romance', re: /(romanc|romanti|liebe|amour)/i },
  { key: 'docs', fr: 'Documentaire', en: 'Documentary', re: /(docu|dokument|dokus|dokumental)/i },
  { key: 'war', fr: 'Guerre & histoire', en: 'War & history', re: /(guerre|\bwar\b|histo|krieg|guerra)/i },
  { key: 'western', fr: 'Western', en: 'Western', re: /western/i },
  { key: 'music', fr: 'Musique', en: 'Music', re: /(musi|concert)/i },
  { key: 'christmas', fr: 'Noël', en: 'Christmas', re: /(christmas|no[eë]l|weihnacht|navidad|natale|świąt)/i },
];

/** genre keys of a title (TMDB genres first, then its provider category name) */
export function genreKeys(item: { genres?: string[] }, categoryName?: string): string[] {
  const text = [...(item.genres || []), categoryName || ''].join(' | ');
  if (!text.trim()) return [];
  return GENRES.filter((g) => g.re.test(text)).map((g) => g.key);
}
