const CACHE_NAME = 'gathersync-v2';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/models.js',
  './js/calendar.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // ネットワーク優先で常に最新のHTML/JSを取得
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
