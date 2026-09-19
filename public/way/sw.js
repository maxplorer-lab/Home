// sw.js — Home's service worker, scoped to /way/ (superapp build).
//
// It exists for two reasons: Chrome/Brave refuse to offer "Install app" without
// a manifest AND a fetch handler, and a cold start on a phone should not wait on
// the network for a pin icon.
//
// What it deliberately does NOT do: cache HTML or API responses. That is the
// app-wide policy (`public/sw.js`), and it is a security rule rather than a
// style choice — every document here is server-rendered for ONE signed-in
// person, on a device that may be shared. A cached `/way/index.html` would be
// handed to the next person (or to an offline visitor) as though it were
// theirs. This file used to precache the shell and fall back to it offline;
// `way-assets-v3` is the cache that no longer exists, and the name change is
// what purges it from phones that already installed v2.
//
// Dynamic data (/way/api/*, /ws, /ulogger) is never touched either — it must
// always hit the network fresh.
//
// This worker is nested inside Home's root one (scope `/way/` vs `/`): a
// narrower scope wins for a /way/ URL, so BOTH files must keep this policy or
// the stricter one is pointless.

const CACHE = 'way-assets-v3';
const PRECACHE = [
  '/way/manifest.json',
  '/way/icon-64.png',
  '/way/icon-512.png',
  '/way/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One bad URL must not fail the whole install: add them individually.
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Scope guard: Sompitra (/) and Laoka (/laoka/) are other apps.
  if (!url.pathname.startsWith('/way/')) return;
  if (url.pathname.startsWith('/way/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ulogger')) return;

  // Documents are the app itself — the Worker's session-gated render, never a
  // cache entry. `destination` is '' for some same-origin fetches, so the
  // navigation mode is checked too.
  if (req.mode === 'navigate' || req.destination === 'document') return;

  const cacheable = ['image', 'style', 'script', 'font'].includes(req.destination);
  if (!cacheable) return;

  // Stale-while-revalidate: instant from cache, refreshed in the background so
  // the next load already has the new build. An offline miss answers 504 rather
  // than rejecting the fetch (a rejected respondWith shows the browser's own
  // error page for an asset).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const refresh = fetch(req).then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        cache.put(req, response.clone()).catch(() => {});
      }
      return response;
    });
    if (hit) {
      event.waitUntil(refresh.catch(() => {}));
      return hit;
    }
    return refresh.catch(() => new Response('', { status: 504, statusText: 'offline' }));
  })());
});
