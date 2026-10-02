/**
 * The service workers' map cache — `public/sw.js` and `public/way/sw.js` under
 * `node --test`.
 *
 * Both workers keep ONE pool (`home-map-v1`) of the basemap host's bytes, and
 * the pool is the heaviest thing either map loads: a z14 vector tile measured
 * 271 KB on 2026-10-02, against a style of ~43 KB. The hosts' own
 * `Cache-Control` is generous, but that is the BROWSER cache — per-profile, and
 * on a phone evicted long before Cache Storage is — so the workers keep their
 * own copy and are the thing this file holds to behavior.
 *
 * No server, no browser (unlike `npm run smoke` section 16, which reads the
 * served files): each worker's SOURCE is loaded into a bare `self` with fake
 * caches and a counting fetch, then driven through its real fetch listener, so
 * a red here means the policy actually changed, not that a string moved. That
 * matters for the exclusions above all — a worker that starts caching a
 * document or an API response is the failure this whole arrangement exists to
 * prevent, and it is invisible from the outside.
 *
 * Each case runs against BOTH files because the scope rule makes the narrower
 * worker win for a /way/ URL: one file breaking policy is enough to break it,
 * and the two are edited by hand.
 *
 * Run: `npm test`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ORIGIN = 'https://home.example'
const POOL = 'home-map-v1'
const FILES = [
  { name: 'public/sw.js', own: 'home-v3' },
  { name: 'public/way/sw.js', own: 'way-assets-v3' },
].map((f) => ({ ...f, src: readFileSync(new URL(`../${f.name}`, import.meta.url), 'utf8') }))

const TILE = 'https://tiles.openfreemap.org/planet/20260927_080001_pt/14/10355/9068.pbf'
const STYLE = 'https://tiles.openfreemap.org/styles/positron'
const TILEJSON = 'https://tiles.openfreemap.org/planet'
const GLYPH = 'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf'
const OTHER_HOST = 'https://example.com/photo.png'

// ─── The bare worker environment ────────────────────────────────────

const keyOf = (req) => (typeof req === 'string' ? req : req.url)

function fakeCache() {
  const store = new Map()
  return {
    store,
    async match(req) {
      const hit = store.get(keyOf(req))
      return hit ? hit.clone() : undefined
    },
    async put(req, res) {
      store.set(keyOf(req), res.clone())
    },
    async delete(req) {
      return store.delete(keyOf(req))
    },
    async keys() {
      // Insertion order, as the real Cache Storage returns them.
      return [...store.keys()].map((url) => new Request(url))
    },
  }
}

function fakeCaches(names = []) {
  const store = new Map(names.map((n) => [n, fakeCache()]))
  return {
    store,
    async open(name) {
      if (!store.has(name)) store.set(name, fakeCache())
      return store.get(name)
    },
    async keys() {
      return [...store.keys()]
    },
    async delete(name) {
      return store.delete(name)
    },
  }
}

/** Load one worker's source into a bare `self`. Nothing else of Node leaks in
 *  that the worker could be accidentally right about — `self`, `caches` and
 *  `fetch` are the only injected names, so a worker reaching for another one
 *  fails loudly instead of passing by accident. */
function loadWorker(file, { failFetch = false } = {}) {
  const listeners = {}
  const self = {
    addEventListener(type, fn) {
      ;(listeners[type] ||= []).push(fn)
    },
    location: { origin: ORIGIN },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  }
  const caches = fakeCaches()
  const fetched = []
  const fetch = async (req) => {
    fetched.push(keyOf(req))
    if (failFetch) throw new TypeError('network down')
    return new Response(`bytes:${fetched.length}`, { status: 200 })
  }
  new Function('self', 'caches', 'fetch', file.src)(self, caches, fetch)
  return { file: file.name, listeners, caches, fetched }
}

/** A request shape the fetch handler can read: `Request` cannot carry a
 *  `destination` or navigate `mode`, and the guards judge both, so these are
 *  plain objects with exactly the fields the handler touches. */
const makeReq = (url, extra = {}) => ({
  url,
  method: 'GET',
  mode: 'cors',
  destination: '',
  headers: new Headers(),
  ...extra,
})

/** Deliver one request and collect what the handler decided. */
async function deliver(worker, request) {
  const waits = []
  let answer = null
  const event = {
    request,
    respondWith(promise) {
      answer = promise
    },
    waitUntil(promise) {
      waits.push(promise)
    },
  }
  for (const fn of worker.listeners.fetch || []) fn(event)
  return {
    responded: answer !== null,
    response: answer ? await answer : null,
    waits,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// ─── Tiles: cache-first ─────────────────────────────────────────────

test('a tile is served off disk the second time, with no network at all', async () => {
  for (const file of FILES) {
    const worker = loadWorker(file)
    const first = await deliver(worker, makeReq(TILE))
    assert.equal(first.response.status, 200, `${file.name}: the first tile read must reach the network`)
    const body = await first.response.text()
    await settle()

    const before = worker.fetched.length
    const second = await deliver(worker, makeReq(TILE))
    assert.equal(await second.response.text(), body, `${file.name}: the cached tile must be the bytes that were stored`)
    assert.equal(worker.fetched.length, before, `${file.name}: a cached tile was re-fetched — 271 KB to prove it did not change`)
    assert.equal(second.waits.length, 0, `${file.name}: a cache-first tile must not queue a background refresh`)
  }
})

test('a tile never seen before is stored under the shared pool name', async () => {
  for (const file of FILES) {
    const worker = loadWorker(file)
    await deliver(worker, makeReq(TILE))
    await settle()
    assert.ok(
      worker.caches.store.has(POOL),
      `${file.name}: the map bytes must land in ${POOL} — a per-worker name means /live and /way/ each pay for the same tile`
    )
    assert.ok(
      worker.caches.store.get(POOL).store.has(TILE),
      `${file.name}: the tile fetched was not the tile stored`
    )
  }
})

test('a failed fetch answers 504 and stores nothing', async () => {
  for (const file of FILES) {
    const worker = loadWorker(file, { failFetch: true })
    const result = await deliver(worker, makeReq(TILE))
    assert.equal(result.response.status, 504, `${file.name}: an offline miss must be an empty 504, not a rejected fetch`)
    assert.equal(worker.caches.store.get(POOL)?.store.size || 0, 0, `${file.name}: a failed response was cached as if it were bytes`)
  }
})

// ─── Style/TileJSON/glyphs: stale-while-revalidate ──────────────────

test('style, TileJSON and glyphs answer from cache and refresh behind it', async () => {
  for (const file of FILES) {
    const worker = loadWorker(file)
    for (const url of [STYLE, TILEJSON, GLYPH]) {
      const cold = await deliver(worker, makeReq(url))
      assert.equal(cold.response.status, 200, `${file.name}: ${url} must be fetched on first sight`)
      await settle()

      const before = worker.fetched.length
      const warm = await deliver(worker, makeReq(url))
      assert.equal(warm.response.status, 200, `${file.name}: ${url} must answer from cache`)
      assert.equal(worker.fetched.length, before + 1, `${file.name}: ${url} was not revalidated in the background`)
      assert.equal(warm.waits.length, 1, `${file.name}: ${url}'s background refresh is not kept alive, so it can be killed mid-flight`)
    }
  }
})

// ─── What must never be intercepted ─────────────────────────────────

test('navigations and documents are never served from (or written to) cache', async () => {
  for (const file of FILES) {
    const worker = loadWorker(file)
    // A document at the map host itself, and at our own origin: neither may be
    // answered by the worker. This is the shared-device rule (smoke §16).
    for (const url of [STYLE, `${ORIGIN}/way/index.html`]) {
      const nav = await deliver(worker, makeReq(url, { mode: 'navigate', destination: 'document' }))
      assert.equal(nav.responded, false, `${file.name}: ${url} was intercepted as a navigation`)
      const doc = await deliver(worker, makeReq(url, { destination: 'document' }))
      assert.equal(doc.responded, false, `${file.name}: ${url} was intercepted as a document`)
    }
  }
})

test('a range request is left to the network', async () => {
  for (const file of FILES) {
    const worker = loadWorker(file)
    const ranged = await deliver(worker, makeReq(TILE, { headers: new Headers({ range: 'bytes=0-1023' }) }))
    assert.equal(ranged.responded, false, `${file.name}: a partial request was answered with a whole cached body`)
  }
})

test('session-gated API paths stay untouched in both workers', async () => {
  const gated = {
    'public/sw.js': ['/api/budget', '/way/api/history', '/laoka/api/state', '/ws'],
    'public/way/sw.js': ['/way/api/history', '/ws', '/ulogger/logger'],
  }
  for (const file of FILES) {
    const worker = loadWorker(file)
    for (const path of gated[file.name]) {
      const result = await deliver(worker, makeReq(`${ORIGIN}${path}`))
      assert.equal(result.responded, false, `${file.name}: ${path} was intercepted — dynamic data must always hit the network fresh`)
    }
  }
})

test('another host is left to the network', async () => {
  for (const file of FILES) {
    const worker = loadWorker(file)
    const result = await deliver(worker, makeReq(OTHER_HOST))
    assert.equal(result.responded, false, `${file.name}: ${OTHER_HOST} was intercepted`)
  }
})

// ─── The host list is the page's own, and both workers agree ───────

test('every basemap host the pages declare is one both workers cache', async () => {
  const window = {}
  new Function('window', readFileSync(new URL('../public/shared/basemaps.js', import.meta.url), 'utf8'))(window)
  const hosts = [...new Set(Object.values(window.HomeBasemaps || {}).map((key) => {
    const url = key.style || key.url || ''
    return (url.match(/^https:\/\/([^/]+)\//) || [])[1]
  }).filter(Boolean))]
  assert.ok(hosts.length > 0, 'no basemap host could be read from /shared/basemaps.js — the guard below judges nothing')

  for (const file of FILES) {
    const worker = loadWorker(file)
    for (const host of hosts) {
      const result = await deliver(worker, makeReq(`https://${host}/planet/0/0/0.pbf`))
      assert.equal(
        result.responded, true,
        `${file.name}: ${host} is declared in /shared/basemaps.js but this worker does not cache it — its tiles are re-downloaded on every visit`
      )
    }
  }
})

test('an update keeps the shared pool and deletes only its own stale caches', async () => {
  for (const file of FILES) {
    const worker = loadWorker(file)
    worker.caches.store.set(file.own, fakeCache())
    worker.caches.store.set(POOL, fakeCache())
    worker.caches.store.set('some-old-cache-v1', fakeCache())
    const waits = []
    for (const fn of worker.listeners.activate || []) fn({ waitUntil: (p) => waits.push(p) })
    await Promise.all(waits)
    assert.ok(worker.caches.store.has(POOL), `${file.name}: activate deleted the map pool — every tile would be re-downloaded`)
    assert.ok(worker.caches.store.has(file.own), `${file.name}: activate deleted its own asset cache`)
    assert.equal(worker.caches.store.has('some-old-cache-v1'), false, `${file.name}: activate left a stale cache behind`)
  }
})

// ─── The pool is bounded ────────────────────────────────────────────

test('the pool trims oldest-first instead of growing without bound', async () => {
  const urlAt = (i) => `https://tiles.openfreemap.org/planet/20260927_080001_pt/14/${10000 + i}/9068.pbf`
  for (const file of FILES) {
    const worker = loadWorker(file)
    for (let i = 0; i < 233; i++) {
      await deliver(worker, makeReq(urlAt(i)))
    }
    await settle()
    await settle()
    const pool = worker.caches.store.get(POOL)
    assert.ok(pool.store.size > 0, `${file.name}: nothing was stored at all`)
    assert.ok(pool.store.size <= 200, `${file.name}: the pool grew to ${pool.store.size} entries — the trim never ran`)
    assert.equal(pool.store.has(urlAt(232)), true, `${file.name}: the trim threw away the tiles just fetched`)
    assert.equal(pool.store.has(urlAt(0)), false, `${file.name}: the oldest tiles must be the ones evicted, not the newest`)
  }
})
