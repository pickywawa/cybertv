import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { rewriteM3u8, isM3u8 } from '../src/core/net/m3u8Rewrite.ts';

/**
 * Dev-only CORS proxy: GET /proxy?u=<encoded absolute url>
 * - streams the upstream body (playlists of 100+ MB, video segments, images)
 * - forwards Range for VOD seeking
 * - rewrites HLS playlists so every segment also goes through the proxy
 */
const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';
const proxify = (u: string) => `/proxy?u=${encodeURIComponent(u)}`;

export function devProxyPlugin(): Plugin {
  return {
    name: 'cybertv-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/proxy', (req, res) => {
        void handle(req, res);
      });
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  const qs = new URL(req.url || '', 'http://x').searchParams;
  const target = qs.get('u');
  if (!target || !/^https?:\/\//i.test(target)) {
    res.statusCode = 400;
    return res.end('missing or invalid u');
  }
  const headers: Record<string, string> = { 'user-agent': qs.get('ua') || DEFAULT_UA, accept: '*/*' };
  if (req.headers.range) headers.range = String(req.headers.range);
  const ac = new AbortController();
  req.on('close', () => ac.abort());
  try {
    const up = await fetch(target, { headers, redirect: 'follow', signal: ac.signal });
    res.statusCode = up.status;
    const ct = up.headers.get('content-type');
    for (const h of ['content-type', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'cache-control']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (isM3u8(up.url || target, ct)) {
      const text = await up.text();
      const out = rewriteM3u8(text, up.url || target, proxify);
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.end(out);
    }
    const len = up.headers.get('content-length');
    // fetch() transparently decompresses; only forward length when not encoded
    if (len && !up.headers.get('content-encoding')) res.setHeader('content-length', len);
    if (!up.body) return res.end();
    Readable.fromWeb(up.body as any)
      .on('error', () => res.destroy())
      .pipe(res);
  } catch (e) {
    if (ac.signal.aborted) return;
    res.statusCode = 502;
    res.end(`proxy error: ${(e as Error).message}`);
  }
}
