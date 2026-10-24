/* Caches the app shell so SynthScope opens fast and works on flaky connections.
   Live prices always come from Deriv over WebSocket, which this does not touch. */
const CACHE = 'synthscope-v1.0.0';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/indicators.js', 'js/strategies.js', 'js/deriv.js', 'js/app.js',
  'vendor/lightweight-charts.standalone.production.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first so updates show up, cache as fallback
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => list.length ? list[0].focus() : self.clients.openWindow('./')));
});
