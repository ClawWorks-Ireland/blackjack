/**
 * Service worker: makes the game work offline once it has loaded.
 *
 * Network first, cache as fallback: online you always get the latest
 * files (so an update is never hidden behind a stale cache), and offline
 * the last copy is served. The static files are cached on install.
 */
'use strict';

const CACHE = 'blackjack-v10';
const FILES = [
  './', './index.html', './style.css', './manifest.webmanifest',
  '../engine/format.js', './prefs.js', './a11y.js', '../engine/betting.js', '../engine/sidebets.js', '../engine/blackjack.js',
  '../engine/stats.js', './sound.js', '../engine/strategy.js', '../engine/counting.js', '../engine/chart.js', '../engine/drill.js', '../engine/ev-data.js', '../engine/ev.js', '../engine/rules.js', '../engine/bankroll.js', '../engine/report.js', '../engine/replay.js', './sim-worker.js', './app.js',
  './lobby.html', './table.html', './poker.html', './players.html', './live.css', './live.js', './poker.js',
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
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Live tables (server/server.js): table states and the event stream must never be cached.
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(req)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })
    .catch(() => caches.match(req, { ignoreSearch: true })
      .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./lobby.html') : hit))));
});
