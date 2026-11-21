import { describe, expect, it } from 'vitest';
import { M3uParser, classifyEntry, type M3uEntry } from '../src/core/sources/m3u';
import { parseXmltv, parseXmltvDate } from '../src/core/epg/xmltv';
import { cleanName, parseTitleYear, parseEpisode, detectQuality, detectUniverse, channelGroupKey } from '../src/core/util/text';
import { rewriteM3u8 } from '../src/core/net/m3u8Rewrite';
import { catchupUrl } from '../src/core/sources/urls';
import { SearchIndex } from '../src/core/search';
import type { Channel, Source } from '../src/core/types';

const PLAYLIST = `#EXTM3U url-tvg="http://epg/a.xml.gz,http://epg/b.xml"
#EXTINF:-1 tvg-id="TF1.fr" tvg-name="TF1 FHD" tvg-logo="http://l/tf1.png" group-title="FR | Généralistes" catchup="default" catchup-days="7" catchup-source="http://cu/tf1?s={utc}&e={utcend}",TF1, la une FHD
http://h:8080/live/u/p/101.ts
#EXTINF:-1 group-title="VOD",FR - Dune (2021) 4K
http://h:8080/movie/u/p/5000.mkv
#EXTINF:-1 group-title="Séries",Lupin S02 E05
http://h:8080/series/u/p/9000.mp4
#EXTINF:0,No group
#EXTVLCOPT:http-user-agent=X
http://h/stream.m3u8
`;

describe('M3U', () => {
  it('parses entries, attrs, header and classification', () => {
    const out: M3uEntry[] = [];
    const p = new M3uParser((e) => out.push(e));
    PLAYLIST.split('\n').forEach((l) => p.push(l));
    expect(p.header.epgUrls).toEqual(['http://epg/a.xml.gz', 'http://epg/b.xml']);
    expect(out).toHaveLength(4);
    expect(out[0].name).toBe('TF1, la une FHD');
    expect(out[0].attrs['tvg-id']).toBe('TF1.fr');
    expect(out[0].attrs['group-title']).toBe('FR | Généralistes');
    expect(out.map(classifyEntry)).toEqual(['live', 'movie', 'episode', 'live']);
    expect(out[3].url).toBe('http://h/stream.m3u8');
  });
});

describe('text utils', () => {
  it('cleans provider names', () => {
    expect(cleanName('FR: TF1 FHD')).toBe('TF1');
    expect(cleanName('|FR| Canal+ Sport HD')).toBe('Canal+ Sport');
    expect(parseTitleYear('FR - Dune (2021) 4K')).toEqual({ title: 'Dune', year: 2021 });
    expect(parseTitleYear('Matrix (1999)')).toEqual({ title: 'Matrix', year: 1999 });
    expect(parseEpisode('Lupin S02 E05')).toEqual({ show: 'Lupin', season: 2, episode: 5 });
    expect(parseEpisode('The Office (US) S1E3')?.season).toBe(1);
    expect(detectQuality('TF1 FHD')).toBe('FHD');
    expect(detectQuality('TF1 4K')).toBe('4K');
    expect(detectUniverse('FR | Sport')).toBe('sport');
    expect(detectUniverse('Kids Planet')).toBe('kids');
    expect(channelGroupKey('FR: TF1 FHD')).toBe(channelGroupKey('TF1 HD'));
  });
});

describe('XMLTV', () => {
  it('parses dates with offsets', () => {
    expect(parseXmltvDate('20240101120000 +0100')).toBe(Date.UTC(2024, 0, 1, 11, 0, 0));
    expect(parseXmltvDate('20240101120000')).toBe(Date.UTC(2024, 0, 1, 12, 0, 0));
  });
  it('streams programmes with channel mapping', async () => {
    const xml = `<?xml version="1.0"?><tv>
      <channel id="TF1.fr"><display-name>TF1</display-name><icon src="http://i/tf1.png"/></channel>
      <channel id="other"><display-name>Other</display-name></channel>
      <programme start="20240101120000 +0000" stop="20240101130000 +0000" channel="TF1.fr"><title>Journal</title><desc>News &amp; météo</desc><icon src="http://i/p.jpg"/></programme>
      <programme start="20240101130000 +0000" stop="20240101140000 +0000" channel="other"><title>Skip</title></programme>
    </tv>`;
    const chunks = [xml.slice(0, 50), xml.slice(50, 200), xml.slice(200)];
    const stream = new ReadableStream<string>({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } });
    const progs: any[] = [];
    const r = await parseXmltv(stream, {
      from: 0, to: Infinity,
      onChannels: (chs) => { expect(chs).toHaveLength(2); return new Map([['TF1.fr', 'tf1.fr']]); },
      onPrograms: (b) => { progs.push(...b); },
    });
    expect(r.programs).toBe(1);
    expect(progs[0]).toMatchObject({ epgId: 'tf1.fr', title: 'Journal', desc: 'News & météo', icon: 'http://i/p.jpg' });
  });
});

describe('HLS rewrite', () => {
  it('proxifies segments and URI attributes', () => {
    const body = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nseg1.ts\nhttp://cdn/x/seg2.ts\n';
    const out = rewriteM3u8(body, 'http://h/live/a/index.m3u8', (u) => `/p?u=${u}`);
    expect(out).toContain('URI="/p?u=http://h/live/a/key.bin"');
    expect(out).toContain('/p?u=http://h/live/a/seg1.ts');
    expect(out).toContain('/p?u=http://cdn/x/seg2.ts');
  });
});

describe('catch-up urls', () => {
  const base: Channel = {
    id: 'c', sourceId: 's', profileId: 'p', extId: '101', rawName: 'TF1', name: 'TF1', universe: 'general', catchupDays: 7,
    catchupMode: 'xc', quality: null, groupKey: 'ch:tf1', num: 1,
  };
  const start = Date.UTC(2024, 0, 1, 20, 50);
  const stop = Date.UTC(2024, 0, 1, 22, 50);
  it('xtream timeshift', () => {
    const src = { type: 'xtream', url: 'http://h:8080', username: 'u', account: { timezone: 'Europe/Paris' } } as Source;
    expect(catchupUrl(base, src, 'p', start, stop)).toBe('http://h:8080/timeshift/u/p/120/2024-01-01:21-50/101.ts');
  });
  it('m3u default template', () => {
    const ch = { ...base, catchupMode: 'default' as const, catchupSource: 'http://cu/tf1?s={utc}&d={duration}', url: 'http://h/1.ts' };
    expect(catchupUrl(ch, { type: 'm3u' } as Source, undefined, start, stop)).toBe(`http://cu/tf1?s=${start / 1000}&d=7200`);
  });
  it('m3u xc from url', () => {
    const ch = { ...base, url: 'http://h:8080/live/u/p/101.ts' };
    expect(catchupUrl(ch, { type: 'm3u' } as Source, undefined, start, stop)).toBe('http://h:8080/timeshift/u/p/120/2024-01-01:20-50/101.ts');
  });
});

describe('search', () => {
  it('finds accent-insensitive prefixes and dedups groups', () => {
    const idx = new SearchIndex();
    idx.load([
      { kind: 'movie', id: '1', groupKey: 'a', title: "Le Fabuleux Destin d'Amélie Poulain" },
      { kind: 'movie', id: '2', groupKey: 'a', title: "Le Fabuleux Destin d'Amélie Poulain" },
      { kind: 'movie', id: '3', groupKey: 'b', title: 'Amelia' },
      { kind: 'live', id: '4', groupKey: 'c', title: 'Arena Sport 1' },
    ]);
    expect(idx.size).toBe(3);
    expect(idx.search('amel').map((h) => h.id)).toEqual(['3', '1']);
    expect(idx.search('sport').map((h) => h.id)).toEqual(['4']);
  });
});
