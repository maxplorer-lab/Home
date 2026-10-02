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
// Cached, beyond the icons above: the map's own bytes (MAP_CACHE), the same
// pool the root worker keeps, because Cache Storage is per-ORIGIN and not
// per-scope. The size is why — 271 KB for one z14 tile, measured 2026-10-02.
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
      // MAP_CACHE is kept too: an update must not throw away the map bytes
      // the whole point is to not download twice.
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== MAP_CACHE).map((k) => caches.delete(k))))
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
