// Offline-first: the game always opens instantly from the cache.
// Any new version is fetched quietly in the background and used on the next launch —
// it never blocks you from playing.
const CACHE = 'dryspace-solitaire-v1.4.0';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'nearby.js',
  'vendor/peerjs.min.js', 'vendor/qrcode.js', 'vendor/jsQR.js',
  'logo.png', 'logo-white.png', 'wordmark-white.png', 'card-back.png',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png'
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so a new version gets fresh files
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('dryspace-solitaire-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// lets the page ask which version is installed
self.addEventListener('message', e => {
  if (e.data === 'version' && e.ports[0]) e.ports[0].postMessage({ version: CACHE });
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const key = req.mode === 'navigate' ? 'index.html' : req;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(key, { ignoreSearch: true });
      const refresh = fetch(req).then(res => {
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      }).catch(() => cached);
      if (cached) { e.waitUntil(refresh); return cached; }
      return refresh;
    })
  );
});
