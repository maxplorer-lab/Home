// sw.js — minimal service worker (superapp build).
// Scoped to /way/ inside the family super app: the shell lives under
// /way/index.html and the other two apps (Sompitra at /, Laoka at
// /laoka/) must never be intercepted by this worker.
//
// Its jobs:
//   1. Make WAY installable (Chrome requires a fetch handler + valid manifest).
//   2. Cache the static shell (index, manifest, icons) for a fast start and
//      a basic offline fallback.
// Dynamic data (/way/api/*, /ws, /ulogger) is deliberately NEVER cached --
// those must always hit the network fresh.

const CACHE = 'way-shell-v2-superapp';
const SHELL = ['/way/', '/way/index.html', '/way/manifest.json', '/way/icon-512.png', '/way/icon-maskable-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
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
  const url = new URL(req.url);

  // Same-origin GETs only; leave cross-origin (Leaflet CDN, tiles, fonts,
  // Nominatim) and all dynamic data to the browser's normal network path.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/way/')) return; // scope guard: Sompitra (/) and Laoka (/laoka/) are other apps
  if (url.pathname.startsWith('/way/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ulogger')) return;

  // Network-first for the shell, so a freshly-deployed Worker always wins;
  // fall back to cache (then to the cached index) when offline.
  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return resp;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/way/index.html')))
  );
});
