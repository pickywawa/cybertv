import { norm } from './util/text';

export interface SearchDoc {
  kind: 'live' | 'movie' | 'series';
  id: string;
  groupKey: string;
  title: string;
  extra?: string;
  /** precomputed normalized text */
  n?: string;
}

export interface SearchHit extends SearchDoc {
  score: number;
}

/** Tiny in-memory search: accent/case-insensitive, word-prefix matching, scored */
export class SearchIndex {
  private docs: SearchDoc[] = [];

  load(docs: SearchDoc[]) {
    const seen = new Set<string>();
    this.docs = [];
    for (const d of docs) {
      const k = d.kind + d.groupKey;
      if (seen.has(k)) continue;
      seen.add(k);
      d.n = ' ' + norm(d.title + ' ' + (d.extra || '')) + ' ';
      this.docs.push(d);
    }
  }

  get size() {
    return this.docs.length;
  }

  search(q: string, limit = 120): SearchHit[] {
    const tokens = norm(q).split(' ').filter(Boolean);
    if (!tokens.length) return [];
    const nq = ' ' + tokens.join(' ');
    const out: SearchHit[] = [];
    for (const d of this.docs) {
      const n = d.n!;
      let score = 0;
      let ok = true;
      for (const t of tokens) {
        const i = n.indexOf(' ' + t);
        if (i >= 0) score += i === 0 ? 30 : 10;
        else if (t.length >= 3 && n.includes(t)) score += 3;
        else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const nt = ' ' + norm(d.title);
      if (nt === nq) score += 100;
      else if (nt.startsWith(nq)) score += 50;
      score -= nt.length / 20;
      out.push({ ...d, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }
}
