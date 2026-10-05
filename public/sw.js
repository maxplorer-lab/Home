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
// Cached: static assets only (icons, images, CSS, fonts, scripts) — plus the
// map host's own bytes (MAP_CACHE below), which are identical for everyone too
// and are the largest thing the share fetches: one z14 vector tile measured
// 271 KB on 2026-10-02.
// Bump this whenever a cached asset's BEHAVIOUR changes in place — a /shared/*.js
// module rewritten at the same URL, say. Entries are keyed by URL, so a new file
// evicts itself and a rewrite does not: without a bump the load right after such
// a change runs the previous module, and the one after it is correct.
const CACHE = 'home-v3';
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

// ─── The map's own bytes ──────────────────────────────────────────
// Both maps draw OpenFreeMap (see /shared/basemaps.js), and its vector tiles
// are the heaviest thing either page fetches: one z14 tile over Antananarivo
// measured 271 KB on 2026-10-02. The host serves them with a ten-year
// Cache-Control, but that is the BROWSER cache — per-profile, and evicted long
// before Cache Storage is on a phone. These bytes are session-free (no cookie,
// no query, identical for every viewer), so unlike a document they are safe to
// keep, and both workers keep them in ONE pool: Cache Storage is per-ORIGIN,
// so a tile /live paid for is a tile /way/ gets off disk.
const MAP_CACHE = 'home-map-v1';
// A basemap host is a dependency (the two provider blocks in /shared/basemaps.js
// say why). A declared host missing from this list is simply never cached, so
// smoke §16 reads the list and that file together; adding a raster key means
// adding its host HERE, in both workers.
const MAP_HOSTS = ['tiles.openfreemap.org'];
// Tiles live under a versioned path upstream rotates (a new planet version is a
// new URL), so they are cache-first: re-fetching 271 KB to prove it did not
// change is exactly the cost this cache removes. Style, TileJSON, glyphs and
// sprites sit at stable URLs with a day-to-week cache upstream, so those are
// revalidated in the background while the stored copy answers.
const MAP_METADATA = /^\/(?:styles|fonts|sprites)\//;
const MAP_MAX_ENTRIES = 200;

let mapPuts = 0;
async function trimMapCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAP_MAX_ENTRIES) return;
  // Oldest first: keys come back in insertion order, and a re-fetched tile is
  // re-put without moving, so the head of the list is the coldest. Trim in one
  // pass, on every 32nd put rather than on every tile.
  await Promise.all(keys.slice(0, keys.length - 120).map((k) => cache.delete(k))).catch(() => {});
}
function mapKind(url) {
  if (!MAP_HOSTS.includes(url.hostname)) return null;
  if (url.pathname === '/planet') return 'metadata';
  if (MAP_METADATA.test(url.pathname)) return 'metadata';
  return 'tile';
}
async function mapBytes(event, req, kind) {
  const cache = await caches.open(MAP_CACHE);
  const hit = await cache.match(req);
  const load = () => fetch(req).then((response) => {
    if (response && response.status === 200) {
      cache.put(req, response.clone()).then(() => {
        mapPuts += 1;
        if (mapPuts % 32 === 0) trimMapCache(cache);
      }).catch(() => {});
    }
    return response;
  });
  if (hit) {
    if (kind === 'metadata') event.waitUntil(load().catch(() => {}));
    return hit;
  }
  return load().catch(() => new Response('', { status: 504, statusText: 'offline' }));
}

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

// A name this worker used before Home existed, purged on sight: the Sompitra
// build cached documents (`/` itself was in its precache), and a phone that
// installed back then still holds one.
const LEGACY = ['sompitra-v1'];

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Only this worker's own names — never "everything that is not mine".
      // Cache Storage is per-ORIGIN, not per-scope, so a `keys()` here also
      // lists the nested /way/ worker's `way-assets-*`, and deleting that is
      // every /way/ module re-downloaded on its next visit. MAP_CACHE must
      // survive the family rule too (`home-map-*` matches `home-`): throwing
      // away the map bytes is the exact cost the pool exists to remove.
      .then((keys) => Promise.all(
        keys
          .filter((k) => (k.startsWith('home-') || LEGACY.includes(k)) && k !== CACHE && k !== MAP_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ── The map's bytes (see MAP_CACHE): cross-origin, session-free, and the
  // heaviest thing on the page. Served BEFORE the same-origin rule below, which
  // is what would otherwise hand every tile to the network. A navigation is
  // never touched, and neither is a range request — a whole cached body is not
  // a partial answer.
  if (req.mode !== 'navigate' && req.destination !== 'document') {
    const kind = mapKind(url);
    if (kind && !req.headers.has('range')) {
      event.respondWith(mapBytes(event, req, kind));
      return;
    }
  }

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
