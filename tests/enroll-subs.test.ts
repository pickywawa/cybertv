import { describe, expect, it } from 'vitest';
import { parseSubtitles, cuesAt, sanitize } from '../src/core/subs/parse';
import { computeHash } from '../src/core/subs/hash';
import { buildQuery, rankSubs, type SubResult } from '../src/core/subs/opensubtitles';
import { enrollTarget, parsePayload } from '../src/core/enroll';

describe('subtitles', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>there</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n<script>x</script>Line\r\ntwo\r\n';
  it('parses SRT and escapes markup except i/b/u', () => {
    const c = parseSubtitles(srt);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ start: 1, end: 2.5, text: 'Hello <i>there</i>' });
    expect(c[1].text).toBe('&lt;script&gt;x&lt;/script&gt;Line\ntwo');
    expect(sanitize('<font color="red">a</font>')).toBe('a');
  });
  it('parses WebVTT and finds the cue at a time', () => {
    const c = parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000\nA\n\n01:00:00.000 --> 01:00:01.000\nB\n');
    expect(cuesAt(c, 1.5).map((x) => x.text)).toEqual(['A']);
    expect(cuesAt(c, 3600.5).map((x) => x.text)).toEqual(['B']);
    expect(cuesAt(c, 10)).toEqual([]);
  });
  it('computes the OpenSubtitles hash (size + 64-bit word sums, wrapping)', () => {
    const zero = new ArrayBuffer(65536);
    expect(computeHash(131072, zero, zero)).toBe('0000000000020000');
    const ones = new ArrayBuffer(65536);
    new DataView(ones).setBigUint64(0, 0xffffffffffffffffn, true);
    expect(computeHash(1, ones, zero)).toBe('0000000000000000'); // wraps around 2^64
  });
  it('builds a sorted lowercase query', () => {
    expect(buildQuery({ kind: 'episode', parentTmdbId: 1399, season: 1, episode: 2, langs: ['fr', 'en'] })).toBe(
      'episode_number=2&languages=fr,en&parent_tmdb_id=1399&season_number=1&type=episode',
    );
  });
  it('ranks the preferred language first, then exact file matches', () => {
    const r = (x: Partial<SubResult>): SubResult => ({ fileId: 1, lang: 'en', release: '', downloads: 0, hashMatch: false, hearingImpaired: false, machine: false, ...x });
    const list = [r({ fileId: 1, lang: 'en', downloads: 900 }), r({ fileId: 2, lang: 'fr', downloads: 10 }), r({ fileId: 3, lang: 'en', hashMatch: true }), r({ fileId: 4, lang: 'fr', machine: true, downloads: 5000 })];
    expect(rankSubs(list, ['fr', 'en']).map((x) => x.fileId)).toEqual([2, 4, 3, 1]);
    expect(rankSubs([r({ fileId: 5, lang: 'fr' }), r({ fileId: 6, lang: 'fr', hashMatch: true })], ['fr']).map((x) => x.fileId)).toEqual([6, 5]);
  });
});

describe('QR enrolment', () => {
  it('accepts valid settings and drops anything unexpected', () => {
    const p = parsePayload(JSON.stringify({
      v: 1, from: 'form', tmdb: 'abc',
      sources: [
        { type: 'xtream', label: 'Main', url: 'host.tv:8080', username: 'u', password: 'p', backups: ['b.tv', 'javascript:alert(1)'] },
        { type: 'xtream', url: 'http://x.tv' }, // no credentials
        { type: 'm3u', url: 'ftp://nope' },
        { type: 'evil', url: 'http://a' },
      ],
    }));
    expect(p?.sources).toHaveLength(1);
    expect(p?.sources[0]).toMatchObject({ url: 'http://host.tv:8080', backups: ['http://b.tv'], username: 'u' });
    expect(parsePayload('not json')).toBeNull();
    expect(parsePayload(JSON.stringify({ v: 1, sources: [] }))).toBeNull();
  });
  it('only sends phone settings to a TV on the local network', () => {
    const tok = 'a'.repeat(36);
    expect(enrollTarget(`cyberiptv://enroll?target=${encodeURIComponent(`http://192.168.1.20:4321/e/${tok}`)}`)).toBe(`http://192.168.1.20:4321/e/${tok}`);
    expect(enrollTarget(`cyberiptv://enroll?target=${encodeURIComponent(`http://evil.com/e/${tok}`)}`)).toBeNull();
    expect(enrollTarget(`cyberiptv://enroll?target=${encodeURIComponent('http://192.168.1.20/e/short')}`)).toBeNull();
  });
});
