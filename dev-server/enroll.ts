import type { Plugin } from 'vite';
import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Dev stand-in for the Android EnrollServer, so the QR flow works in the browser:
 *   GET  /enroll-api/start            → { url } (Mac LAN address, reachable by a phone on the same Wi-Fi)
 *   GET  /enroll-api/poll?token=…     → { payload? }
 *   GET  /enroll/<token>              → the phone form (public/enroll.html)
 *   GET  /enroll/<token>/ping         → { ok }
 *   POST /enroll/<token>              → stores the settings
 */
const sessions = new Map<string, { payload?: string; at: number }>();

function lanIp(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && /^(10|172|192)\./.test(a.address)) return a.address;
  }
  return 'localhost';
}

/** `htmlPath`: the phone page (public/enroll.html in dev, dist/enroll.html in the desktop app) */
export function enrollDevPlugin(htmlPath?: string): Plugin {
  return {
    name: 'cybertv-enroll-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url || '', 'http://x');
        const cors = () => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Headers', 'content-type');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        };
        const json = (code: number, body: unknown) => {
          cors();
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };
        if (url.pathname === '/enroll-api/start') {
          const token = randomBytes(18).toString('hex');
          sessions.set(token, { at: Date.now() });
          const port = server.config.server.port || 5173;
          return json(200, { url: `http://${lanIp()}:${port}/enroll/${token}`, token });
        }
        if (url.pathname === '/enroll-api/poll') {
          const s = sessions.get(url.searchParams.get('token') || '');
          const payload = s?.payload;
          if (s) s.payload = undefined;
          return json(200, payload ? { payload } : {});
        }
        const m = url.pathname.match(/^\/enroll\/([a-f0-9]{36})(\/ping)?$/);
        if (!m) return next();
        const s = sessions.get(m[1]);
        if (req.method === 'OPTIONS') return (cors(), (res.statusCode = 204), res.end());
        if (!s || Date.now() - s.at > 15 * 60000) return json(404, { ok: false });
        if (m[2]) return json(200, { ok: true, app: 'CyberIPTV' });
        if (req.method === 'GET') {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          return res.end(readFileSync(htmlPath || new URL('../public/enroll.html', import.meta.url)));
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            if (body.length > 256 * 1024 || !body.trim().startsWith('{')) return json(400, { ok: false });
            s.payload = body;
            json(200, { ok: true });
          });
          return;
        }
        next();
      });
    },
  };
}
