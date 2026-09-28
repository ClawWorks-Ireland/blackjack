/**
 * Service worker: makes the game work offline once it has loaded.
 *
 * Network first, cache as fallback: online you always get the latest
 * files (so an update is never hidden behind a stale cache), and offline
 * the last copy is served. The static files are cached on install.
 */
'use strict';

const CACHE = 'blackjack-v7';
const FILES = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './format.js', './prefs.js', './a11y.js', './betting.js', './sidebets.js', './blackjack.js',
  './stats.js', './sound.js', './strategy.js', './counting.js', './chart.js', './drill.js', './ev-data.js', './ev.js', './rules.js', './bankroll.js', './report.js', './sim-worker.js', './app.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(fetch(req)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })
    .catch(() => caches.match(req, { ignoreSearch: true })
      .then((hit) => hit || caches.match('./index.html'))));
});
