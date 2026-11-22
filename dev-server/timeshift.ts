import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, rmSync, writeFileSync, createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Local timeshift for live HLS (desktop app and dev server; Android has the same in LocalProxy.java):
 * a recorder follows the live playlists, keeps every segment on disk for up to `max` seconds and
 * serves them as a local live playlist with that whole window, so the player can pause and go back
 * even when the provider offers no catch-up.
 *
 *   GET /tsh/start/live.m3u8?u=<live url>&max=<seconds>  → local master playlist (or a redirect to the plain proxy)
 *   GET /tsh/<sid>/<track>.m3u8                          → local media playlist
 *   GET /tsh/<sid>/<track>/<seq>  /tsh/<sid>/<track>/init  /tsh/<sid>/key/<n>
 */
const VLC_UA = 'VLC/3.0.20 LibVLC/3.0.20';
const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ua = (url: string) => (/(^|\.)ftven\.fr$/i.test(new URL(url).hostname) ? BROWSER_UA : VLC_UA);
const ROOT = join(tmpdir(), 'cybertv-timeshift');
const IDLE_MS = 2 * 60000;

async function fetchText(url: string): Promise<{ text: string; url: string }> {
  const r = await fetch(url, { headers: { 'user-agent': ua(url) }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { text: await r.text(), url: r.url || url };
}
async function fetchBytes(url: string): Promise<Buffer> {
  const r = await fetch(url, { headers: { 'user-agent': ua(url) }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export function attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = line.slice(line.indexOf(':') + 1);
  for (const m of body.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2];
  return out;
}
const unq = (v?: string) => (v || '').replace(/^"|"$/g, '');

/** best variant up to 1080p, and its default audio rendition */
export function pickVariant(master: string, base: string): { video: string; audio?: string; inf: Record<string, string>; media?: Record<string, string> } | null {
  const lines = master.split(/\r?\n/);
  let best: { uri: string; inf: Record<string, string>; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const inf = attrs(lines[i]);
    const uri = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
    if (!uri) continue;
    const h = parseInt((inf.RESOLUTION || '').split('x')[1] || '0', 10);
    const bw = parseInt(inf.BANDWIDTH || '0', 10);
    const score = (h && h > 1080 ? -1e12 : 0) + bw;
    if (!best || score > best.score) best = { uri: uri.trim(), inf, score };
  }
  if (!best) return null;
  let media: Record<string, string> | undefined;
  const group = unq(best.inf.AUDIO);
  if (group) {
    const renditions = lines.filter((l) => l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/.test(l)).map(attrs).filter((a) => unq(a['GROUP-ID']) === group && a.URI);
    media = renditions.find((a) => a.DEFAULT === 'YES') || renditions[0];
  }
  return { video: new URL(best.uri, base).toString(), audio: media ? new URL(unq(media.URI), base).toString() : undefined, inf: best.inf, media };
}

interface Seg {
  seq: number;
  dur: number;
  file: string;
  disc: boolean;
  key: number;
}

class Track {
  segs: Seg[] = [];
  seq = 0;
  discSeq = 0;
  target = 6;
  map?: string;
  /** last upstream media sequence recorded */
  private lastUp: number | null = null;
  private forceDisc = false;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(private s: Session, readonly name: string, private url: string) {
    mkdirSync(join(s.dir, name), { recursive: true });
    this.ready = new Promise((r) => (this.resolveReady = r));
    void this.poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private failures = 0;

  private async poll() {
    if (this.stopped) return;
    let wait = Math.max(1000, (this.target * 1000) / 2);
    try {
      const { text, url } = await fetchText(this.url);
      this.url = url;
      await this.ingest(text, url);
      this.failures = 0;
    } catch {
      // refused (one-connection subscriptions answer 509 / 407…): back off, then give up
      if (++this.failures >= 8) {
        this.s.stop();
        sessions.delete(this.s.id);
        return;
      }
      wait = Math.min(15000, 1000 * 2 ** this.failures);
    }
    if (this.segs.length >= 2) this.resolveReady();
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), wait);
  }

  private async ingest(text: string, base: string) {
    const lines = text.split(/\r?\n/);
    const count = lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length;
    const msLine = lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE'));
    const first = msLine ? parseInt(msLine.split(':')[1], 10) || 0 : 0;
    const lastInList = first + count - 1;
    // segments are identified by their media sequence number (urls may change on every fetch)
    if (this.lastUp === null) this.lastUp = lastInList - Math.min(4, count); // fast start: the last few only
    else if (lastInList < this.lastUp - 2) {
      // the stream restarted its numbering: continue after a discontinuity
      this.lastUp = first - 1;
      this.forceDisc = true;
    }
    let dur = 0;
    let disc = false;
    let keyLine: string | null = null;
    let n = first;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('#EXT-X-TARGETDURATION')) this.target = parseFloat(l.split(':')[1]) || this.target;
      else if (l.startsWith('#EXT-X-KEY')) keyLine = l;
      else if (l.startsWith('#EXT-X-MAP') && !this.map) {
        const u = unq(attrs(l).URI);
        if (u) {
          const file = join(this.s.dir, this.name, 'init');
          writeFileSync(file, await fetchBytes(new URL(u, base).toString()));
          this.map = file;
        }
      } else if (l.startsWith('#EXTINF')) dur = parseFloat(l.slice(8)) || 0;
      else if (l.startsWith('#EXT-X-DISCONTINUITY') && !l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) disc = true;
      else if (!l.startsWith('#')) {
        const up = n++;
        if (up > this.lastUp) {
          const key = keyLine ? await this.s.key(keyLine, base) : -1;
          const seq = this.seq;
          const file = join(this.s.dir, this.name, String(seq));
          try {
            writeFileSync(file, await fetchBytes(new URL(l, base).toString()));
          } catch {
            return; // retried at the next poll, in order
          }
          this.seq++;
          this.lastUp = up;
          this.segs.push({ seq, dur, file, disc: disc || this.forceDisc, key });
          this.forceDisc = false;
          this.trim();
        }
        dur = 0;
        disc = false;
      }
    }
  }

  private trim() {
    let total = this.segs.reduce((a, x) => a + x.dur, 0);
    while (this.segs.length > 3 && total > this.s.max) {
      const old = this.segs.shift()!;
      total -= old.dur;
      if (old.disc) this.discSeq++;
      rmSync(old.file, { force: true });
    }
  }

  playlist(): string {
    const out = ['#EXTM3U', '#EXT-X-VERSION:6', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(this.target, ...this.segs.map((x) => x.dur)))}`];
    out.push(`#EXT-X-MEDIA-SEQUENCE:${this.segs[0]?.seq ?? 0}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${this.discSeq}`);
    if (this.map) out.push(`#EXT-X-MAP:URI="/tsh/${this.s.id}/${this.name}/init"`);
    let key = -2;
    for (const x of this.segs) {
      if (x.disc) out.push('#EXT-X-DISCONTINUITY');
      if (x.key !== key) {
        out.push(x.key < 0 ? '#EXT-X-KEY:METHOD=NONE' : this.s.keyLine(x.key));
        key = x.key;
      }
      out.push(`#EXTINF:${x.dur.toFixed(3)},`, `/tsh/${this.s.id}/${this.name}/${x.seq}`);
    }
    return out.join('\n') + '\n';
  }
}

class Session {
  readonly id = randomUUID().slice(0, 8);
  readonly dir: string;
  tracks = new Map<string, Track>();
  last = Date.now();
  master = '';
  private keys: { line: string; file: string }[] = [];
  private keyIndex = new Map<string, number>();
  private keyFiles = new Map<string, string>();

  constructor(readonly max: number, readonly url: string) {
    this.dir = join(ROOT, this.id);
    mkdirSync(this.dir, { recursive: true });
  }

  /** AES-128 keys are fetched once and served locally (the playlist line points to them) */
  async key(line: string, base: string): Promise<number> {
    const a = attrs(line);
    if (a.METHOD === 'NONE' || !a.URI) return -1;
    const abs = new URL(unq(a.URI), base).toString();
    const known = this.keyIndex.get(abs + (a.IV || ''));
    if (known !== undefined) return known;
    const n = this.keys.length;
    // one download per key url (the IV changes on every segment)
    let file = this.keyFiles.get(abs);
    if (!file) {
      file = join(this.dir, `key${this.keyFiles.size}`);
      writeFileSync(file, await fetchBytes(abs));
      this.keyFiles.set(abs, file);
    }
    const local = line.replace(/URI="[^"]*"/, `URI="/tsh/${this.id}/key/${n}"`);
    this.keys.push({ line: local, file });
    this.keyIndex.set(abs + (a.IV || ''), n);
    return n;
  }
  keyLine(n: number) {
    return this.keys[n].line;
  }
  keyFile(n: number) {
    return this.keys[n]?.file;
  }

  stop() {
    for (const t of this.tracks.values()) t.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** players poll live playlists even when paused: a session nobody asked for in a while is over */
const sessions = new Map<string, Session>();
const starting = new Map<string, Promise<Session>>();
setInterval(() => {
  for (const [id, s] of sessions) {
    if (Date.now() - s.last > IDLE_MS) {
      s.stop();
      sessions.delete(id);
    }
  }
}, 15000).unref();

/** the same live asked twice (player reload, zap back) reuses its recording */
function start(url: string, max: number): Promise<Session> {
  const known = [...sessions.values()].find((x) => x.url === url && x.max === max);
  if (known) {
    known.last = Date.now();
    return Promise.resolve(known);
  }
  let p = starting.get(url);
  if (!p) {
    p = create(url, max).finally(() => starting.delete(url));
    starting.set(url, p);
  }
  return p;
}

async function create(url: string, max: number): Promise<Session> {
  // one recording at a time: many subscriptions allow a single stream, the previous one must stop first
  stopTimeshift();
  const s = new Session(max, url);
  // a subscription limited to one stream refuses (407 / 509 / 429) until the previous one is released
  let got: { text: string; url: string } | null = null;
  for (let attempt = 0; !got; attempt++) {
    try {
      got = await fetchText(url);
    } catch (e) {
      if (attempt >= 4 || !/40[7]|509|429/.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  const { text, url: base } = got;
  if (!/^#EXTM3U/.test(text.trimStart())) throw new Error('not HLS');
  if (text.includes('#EXT-X-STREAM-INF')) {
    const v = pickVariant(text, base);
    if (!v) throw new Error('no variant');
    s.tracks.set('v', new Track(s, 'v', v.video));
    const inf = Object.entries(v.inf)
      .filter(([k]) => k !== 'SUBTITLES' && k !== 'AUDIO')
      .map(([k, val]) => `${k}=${val}`);
    const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
    if (v.audio && v.media) {
      s.tracks.set('a', new Track(s, 'a', v.audio));
      const name = v.media.NAME || '"Audio"';
      const lang = v.media.LANGUAGE ? `,LANGUAGE=${v.media.LANGUAGE}` : '';
      lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME=${name}${lang},DEFAULT=YES,AUTOSELECT=YES,URI="/tsh/${s.id}/a.m3u8"`);
      inf.push('AUDIO="a"');
    }
    lines.push(`#EXT-X-STREAM-INF:${inf.join(',')}`, `/tsh/${s.id}/v.m3u8`);
    s.master = lines.join('\n') + '\n';
  } else {
    // already a media playlist
    s.tracks.set('v', new Track(s, 'v', base));
    s.master = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-STREAM-INF:BANDWIDTH=4000000', `/tsh/${s.id}/v.m3u8`].join('\n') + '\n';
  }
  // wait for the first segments of every track (or give up after 20 s)
  try {
    await Promise.race([Promise.all([...s.tracks.values()].map((t) => t.ready)), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
  } catch (e) {
    s.stop();
    throw e;
  }
  sessions.set(s.id, s);
  return s;
}

const M3U8 = 'application/vnd.apple.mpegurl';

/** returns false when the path is not a timeshift one */
export async function timeshiftHandle(req: IncomingMessage, res: ServerResponse, rawProxy: (u: string) => string): Promise<boolean> {
  const u = new URL(req.url || '', 'http://x');
  if (!u.pathname.startsWith('/tsh/')) return false;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const parts = u.pathname.split('/').filter(Boolean); // tsh, ...
  try {
    if (parts[1] === 'stop') {
      stopTimeshift();
      res.statusCode = 204;
      res.end();
      return true;
    }
    if (parts[1] === 'start') {
      const target = u.searchParams.get('u') || '';
      const max = Math.min(4 * 3600, Math.max(60, parseInt(u.searchParams.get('max') || '1800', 10)));
      try {
        const s = await start(target, max);
        res.setHeader('Content-Type', M3U8);
        res.end(s.master);
      } catch {
        // not HLS / unreachable: plain playback through the proxy
        res.statusCode = 302;
        res.setHeader('Location', rawProxy(target));
        res.end();
      }
      return true;
    }
    const s = sessions.get(parts[1]);
    if (!s) {
      res.statusCode = 404;
      res.end('no session');
      return true;
    }
    s.last = Date.now();
    if (parts[2] === 'key') {
      const f = s.keyFile(parseInt(parts[3], 10));
      if (!f) throw new Error('key');
      createReadStream(f).pipe(res);
      return true;
    }
    if (parts[2]?.endsWith('.m3u8')) {
      const tr = s.tracks.get(parts[2].replace('.m3u8', ''));
      if (!tr) throw new Error('track');
      res.setHeader('Content-Type', M3U8);
      res.end(tr.playlist());
      return true;
    }
    const tr = s.tracks.get(parts[2]);
    const file = tr && (parts[3] === 'init' ? tr.map : tr.segs.find((x) => String(x.seq) === parts[3])?.file);
    if (!file || !existsSync(file)) {
      res.statusCode = 404;
      res.end('gone');
      return true;
    }
    createReadStream(file).pipe(res);
  } catch {
    res.statusCode = 500;
    res.end('error');
  }
  return true;
}

export function stopTimeshift() {
  for (const s of sessions.values()) s.stop();
  sessions.clear();
}
