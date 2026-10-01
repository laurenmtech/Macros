// Offline support: cache the app shell and food database; always go to the network for food APIs.
const CACHE = 'ironbyte-v15';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'data/usda-foods.json', 'vendor/zxing.min.js',
];

self.addEventListener('install', (e) => {
  // Bypass the HTTP cache so a new version never installs with old files.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate for same-origin files: instant from cache, refreshed in the background.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Google Fonts never change at a given URL, so keep them once fetched and they work offline too.
  if (req.method === 'GET' && /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req)
        .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => hit);
      if (hit) { e.waitUntil(net); return hit; }
      return net;
    }),
  );
});
