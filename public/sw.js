/* CyberIPTV image cache: cache-first for images, everything else untouched */
const CACHE = 'cyber-img-v1';
const MAX = 2500;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

let writes = 0;
async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.destination !== 'image') return;
  if (!/^https?:/.test(req.url)) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      let res;
      // CORS fetch when possible: readable responses don't get the opaque-response quota padding
      try {
        res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
      } catch {
        res = await fetch(req);
      }
      if (res && (res.ok || res.type === 'opaque')) {
        e.waitUntil(cache.put(req.url, res.clone()).then(() => (++writes % 100 === 0 ? trim(cache) : undefined)).catch(() => {}));
      }
      return res;
    })(),
  );
});
