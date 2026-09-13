// Offline shell. The library, the guides and the crop data must survive a
// dead 3G bar in the middle of an orchard; only the model call needs network.
const CACHE = 'chajra-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'js/app.js',
  'js/i18n.js',
  'js/store.js',
  'js/knowledge.js',
  'js/gemini.js',
  'js/capture.js',
  'js/guide.js',
  'data/demo.json',
  'data/crops/olive.json',
  'data/crops/orange.json',
  'data/crops/lemon.json',
  'data/crops/avocado.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Never cache the model API: responses are per-request and carry the key.
  if (url.hostname.endsWith('googleapis.com')) return;

  e.respondWith(
    caches.match(e.request).then(hit => {
      const live = fetch(e.request).then(res => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || live;
    })
  );
});
