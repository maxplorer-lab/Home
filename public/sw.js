// ─── Home service worker (app-wide) ──────────────────────────────
// Registered from BOTH hosts (Layout pages and ModuleShell tabs), so the
// app is installable and the shell still opens with no connection.
//
// What it deliberately does NOT do: cache HTML or API responses. Every
// page here is server-rendered for ONE signed-in person, and this is a
// household app on possibly shared devices — a cache that remembers
// "/budget" or "/way/index.html" would hand one person another person's
// page (or a stale one) the moment the network blinked. Navigations and
// API calls therefore go straight to the network, always.
//
// Cached: static assets only (icons, images, CSS, fonts, scripts), which
// are identical for everyone and are exactly what makes a cold start on
// a phone feel instant.
const CACHE = 'home-v2';
const PRECACHE = [
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon-32.png',
  '/favicon.svg',
  '/icon-64.png',
  '/icon-128.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

// Paths that are session-gated server-rendered documents, never cached.
const NEVER = ['/api/', '/way/api/', '/laoka/api/', '/ws'];

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
  if (NEVER.some((p) => url.pathname.startsWith(p))) return;

  // Documents are the app itself: never served from, or written to, cache.
  // (destination is '' for some same-origin fetches, so also check the
  // request mode — an in-app navigation must always hit the Worker.)
  if (req.mode === 'navigate' || req.destination === 'document') return;

  const cacheable = ['image', 'style', 'script', 'font'].includes(req.destination);
  if (!cacheable) return;

  // Stale-while-revalidate: instant from cache, refreshed in the background
  // so the next load already has the new build. An offline miss answers 504
  // rather than rejecting the fetch (a rejected respondWith shows the
  // browser's own error page for an asset).
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
