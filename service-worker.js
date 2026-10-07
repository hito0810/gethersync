const CACHE_NAME = 'gathersync-v13';
const ASSETS = [
  './',
  './index.html',
  './mobile.html',
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
  // ネットワーク優先で常に最新のHTML/JSを取得し、オフライン時にキャッシュを使用
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
