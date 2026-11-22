/**
 * CyberIPTV desktop (Electron).
 * A local Node server (127.0.0.1, random port) serves the built app (dist/) and the same proxy
 * as the dev server (/proxy: CORS, VLC user agent, HLS rewriting; /xhr: OpenSubtitles relay;
 * /enroll*: QR set-up from a phone). The page runs the web player (hls.js / mpegts.js / <video>).
 */
import { app, BrowserWindow, shell, Menu } from 'electron';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { handle as proxyHandle, relay } from '../dev-server/proxy';
import { timeshiftHandle } from '../dev-server/timeshift';
import { enrollDevPlugin } from '../dev-server/enroll';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.txt': 'text/plain',
};

type Mw = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

function startServer(root: string): Promise<number> {
  const middlewares: Mw[] = [];
  let port = 0;
  // reuse the dev-server's QR enrolment middleware as is
  enrollDevPlugin(join(root, 'enroll.html')).configureServer!({
    middlewares: { use: (fn: Mw) => middlewares.push(fn) },
    config: { server: { get port() { return port; } } },
  } as never);

  const server = createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/tsh/')) {
      return void timeshiftHandle(req, res, (u) => `/proxy?u=${encodeURIComponent(u)}`);
    }
    if (url.startsWith('/proxy')) {
      req.url = url.slice('/proxy'.length) || '/';
      return void proxyHandle(req, res);
    }
    if (url.startsWith('/xhr')) {
      req.url = url.slice('/xhr'.length) || '/';
      return void relay(req, res);
    }
    let i = 0;
    const next = () => {
      const mw = middlewares[i++];
      if (mw) return mw(req, res, next);
      serveStatic(root, url, res);
    };
    next();
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      ok(port);
    }),
  );
}

function serveStatic(root: string, url: string, res: ServerResponse) {
  const path = decodeURIComponent(url.split('?')[0]);
  let file = normalize(join(root, path));
  if (!file.startsWith(root)) return void ((res.statusCode = 403), res.end());
  // SPA: unknown paths serve index.html
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream');
  if (/\/assets\//.test(file)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  createReadStream(file).pipe(res);
}

async function createWindow() {
  const root = join(__dirname, '..', 'dist');
  const port = await startServer(root);
  const win = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0b0b0d',
    title: 'CyberIPTV',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // links (release page, TMDB…) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(() => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  void createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && void createWindow());
});
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
