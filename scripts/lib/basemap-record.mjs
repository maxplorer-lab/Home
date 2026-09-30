// ─── The map background's upstream, as a RECORD ─────────────────────────
// The basemap checks in smoke §9 judge somebody else's files: a style JSON, its
// TileJSON, and one real tile. They used to fetch those live, which made the
// suite answer two questions at once — "is upstream still what we expect?" and
// "is the network up?" — and only the first one is about this repo. A red on a
// phone hotspot, a green that proved nothing because a fetch timed out, and a
// `wrangler dev` machine that happens to be offline all read the same.
//
// So the upstream is now a RECORD: `scripts/fixtures/basemaps/` holds a copy of
// every third-party byte the checks read, taken from the real servers by
// `npm run basemaps:record` (a Node script, no server, no database). The suite
// reads the record, so it is deterministic, needs no network, and can run in CI
// — and a refresh is a deliberate act whose diff is reviewable, because the
// index beside the bytes carries each URL's sha256, and the recorder prints what
// changed.
//
// Why the record is the SUBJECT and not a fallback. A guard that prefers the
// network answers a different question depending on the weather. This one always
// answers "does the upstream we recorded still satisfy the rules", and the day
// the answer needs to be "what does upstream serve RIGHT NOW" you ask for it out
// loud (`npm run audit:basemaps --live`, or `SMOKE_LIVE=1 npm run smoke`). The
// record is dated, and past `STALE_DAYS` a copy of somebody else's server is
// itself reported rather than silently judged: a guard about a copy has to know
// its copy is old.
//
// ONE walk, three callers, so nothing here can drift from itself:
//   scripts/basemap-record.mjs        records (npm run basemaps:record)
//   scripts/basemap-record-audit.mjs  judges the record offline (npm run audit:basemaps)
//   smoke §9 (scripts/smoke.mjs)      judges the record, or live with SMOKE_LIVE=1
// The walk is: a declared key's style -> its vector sources -> each source's
// TileJSON -> the template at the source's own deepest zoom -> one tile at the
// household's own centre, plus one over open water as the control.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RECORD_DIR = 'scripts/fixtures/basemaps'
export const RECORD_INDEX = 'index.json'

// Past this, the record is reported as stale by both doors (the audit treats it
// as a fault, an interactive smoke run as a note): a guard answered by a copy is
// only as good as the copy's age, and a copy nobody refreshes is decoration.
export const STALE_DAYS = 120

// The layers a street-level view is made of, at the household's OWN centre:
// `building` is what the flat-buildings change is about, `transportation` is the
// street the map is read on, `place` is how a viewer names it. A tile missing any
// of them is the blank-map fault, whatever its HTTP status was.
export const PAINT_REQUIRED = ['building', 'transportation', 'place']

// The control view: open Southern Indian Ocean, measured on 2026-09-30 as one
// `water` feature in 58 bytes — a tile with nothing in it, which the requirement
// above must NOT be satisfiable by.
export const EMPTY_VIEW = { lat: -30.0, lng: 80.0 }

// A source that declares no ceiling is sampled at OpenMapTiles' own 14, the depth
// OpenFreeMap's planet tiles have always carried.
export const FALLBACK_MAXZOOM = 14

// Hosts whose bytes this record covers. Used to REFUSE a live request while the
// suite is supposed to be reading the record: an accidental fetch is how "runs
// without network" quietly stops being true.
export const RECORDED_HOSTS = ['tiles.openfreemap.org', 'server.arcgisonline.com']

export const REFRESH_HINT = 'run `npm run basemaps:record` — it fetches the real servers and rewrites scripts/fixtures/basemaps/'

export const CONCERNS = ['labels', 'flat', 'paint', 'control']

// ── reading the declaration, wherever it came from ───────────────────────
// A caller with only the module's text (the recorder, the audit) gets the keys
// here; smoke passes what it already parsed to feed its eight other module-level
// checks. Both must agree — and the fixture lookup enforces it: a key whose URL
// this parser found and the recorder did not is a missing entry, not a pass.
export function declareKeys(moduleSource) {
  return [...moduleSource.matchAll(/([a-z]+):\s*\{([\s\S]*?)\n\s*\},/g)].map((m) => ({
    key: m[1],
    style: (m[2].match(/\bstyle:\s*'([^']+)'/) || [])[1] || '',
    raster: (m[2].match(/\burl:\s*'([^']+)'/) || [])[1] || '',
    dense: /dense:\s*true/.test(m[2]),
  }))
}

export function centreFrom(pageSource) {
  const m = pageSource.match(/MAP_DEFAULT_CENTER:\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]/)
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null
}

// The record only ever holds https URLs, so a slug strips the scheme and keeps
// the path readable in a directory listing: `tiles.openfreemap.org/styles/liberty`
// becomes `tiles_openfreemap_org_styles_liberty`. Tiles carry the release
// directory upstream chose, so a rotated release a NEW file rather than an
// overwritten one — the diff says which.
export const slugFor = (url) => url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
export const fileNameFor = (url, kind) => `${slugFor(url)}.${kind === 'tile' ? 'pbf' : 'json'}`

// ── tiles: where a view lands, and what is in it ─────────────────────────
export function tileAt({ lat, lng }, z) {
  const n = 2 ** z
  const latRad = (lat * Math.PI) / 180
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
  }
}

// The smallest reader that answers the only question here: which layers are in
// this tile, and does each of them have anything in it. A vector tile is protobuf
// — field 3 repeats Layer, whose field 1 is the name and whose field 2 repeats
// Feature — and reading further would be reading the wrong thing: the map draws
// the geometry, this only has to notice when there is none.
export function mvtLayers(buf) {
  const out = []
  for (const field of mvtFields(buf)) {
    if (field.field !== 3) continue
    const inner = mvtFields(field.bytes)
    const name = inner.find((f) => f.field === 1)
    out.push({ name: name ? name.bytes.toString('utf8') : '', features: inner.filter((f) => f.field === 2).length })
  }
  return out
}

function mvtVarint(buf, pos) {
  let n = 0
  let shift = 0
  let b
  do { b = buf[pos++]; n += (b & 0x7f) * 2 ** shift; shift += 7 } while (b & 0x80)
  return [n, pos]
}

function mvtFields(buf) {
  const out = []
  let pos = 0
  while (pos < buf.length) {
    const [key, afterKey] = mvtVarint(buf, pos)
    pos = afterKey
    const field = key >>> 3
    const wire = key & 7
    if (wire === 0) pos = mvtVarint(buf, pos)[1]
    else if (wire === 2) { const [len, start] = mvtVarint(buf, pos); pos = start; out.push({ field, bytes: buf.subarray(pos, pos + len) }); pos += len }
    else if (wire === 1) pos += 8
    else if (wire === 5) pos += 4
    else throw new Error(`field ${field} has wire type ${wire}`)
  }
  return out
}

// ── the record on disk ──────────────────────────────────────────────────
export function recordDirOf(root) {
  return join(root, RECORD_DIR)
}

export function readRecord(root) {
  try {
    const index = JSON.parse(readFileSync(join(recordDirOf(root), RECORD_INDEX), 'utf8'))
    if (!index || !Array.isArray(index.entries)) return null
    return index
  } catch { return null }
}

export function recordAgeDays(record, now = Date.now()) {
  const taken = Date.parse(record && record.recordedAt)
  return Number.isFinite(taken) ? Math.floor((now - taken) / 86400000) : null
}

/** Writes the bytes and an index beside them, then deletes every file in the
 *  directory the new index does not name — so the record is exactly the roster,
 *  and a provider change shows up as a removal rather than as a leftover. */
export function writeRecord(root, { entries, fetchedAt }) {
  const dir = recordDirOf(root)
  mkdirSync(dir, { recursive: true })
  const rows = [...entries.values()].map((e) => ({
    url: e.url,
    kind: e.kind,
    view: e.view || null,
    file: fileNameFor(e.url, e.kind),
    bytes: e.bytes.length,
    sha256: createHash('sha256').update(e.bytes).digest('hex'),
    status: e.status,
    contentType: e.contentType,
  }))
  for (const row of rows) writeFileSync(join(dir, row.file), entries.get(row.url).bytes)
  writeFileSync(join(dir, RECORD_INDEX), JSON.stringify({ recordedAt: fetchedAt, hosts: [...new Set(rows.map((r) => hostOf(r.url)))].sort(), entries: rows }, null, 2) + '\n')
  const keep = new Set([RECORD_INDEX, ...rows.map((r) => r.file)])
  let pruned = 0
  for (const name of readdirSync(dir)) {
    if (keep.has(name)) continue
    rmSync(join(dir, name))
    pruned++
  }
  return { rows, pruned }
}

export const hostOf = (url) => (String(url).match(/^https:\/\/([^/]+)\//) || [])[1] || ''

/** The `read(url, meta)` a caller passes to `judgeBasemaps`: bytes out of the
 *  record. A URL the record does not carry throws with `missingFixture` set, so
 *  the judge can say "re-record" instead of "the network is down". */
export function recordReader({ root, record }) {
  const byUrl = new Map((record ? record.entries : []).map((e) => [e.url, e]))
  return async (url) => {
    const entry = byUrl.get(url)
    if (!entry) throw Object.assign(new Error(`no recorded copy of ${url}`), { missingFixture: true })
    return { bytes: readFileSync(join(recordDirOf(root), entry.file)), contentType: entry.contentType || '', status: entry.status || 200 }
  }
}

/** The other `read`: the real thing. `sink` records what it fetched, which is how
 *  `npm run basemaps:record` builds the record — by running the SAME walk the
 *  guards run, so the record can never list a different roster than they read. */
export function liveReader({ fetchImpl = fetch, sink = null } = {}) {
  return async (url, meta = {}) => {
    const res = await fetchImpl(url)
    const bytes = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0)
    const contentType = res.headers.get('content-type') || ''
    if (!res.ok) throw new Error(`${res.status} from ${url}`)
    if (sink) sink.set(url, { url, kind: meta.kind || 'style', view: meta.view || null, status: res.status, contentType, bytes })
    return { bytes, contentType, status: res.status }
  }
}

/** Record mode must not touch the network at all, or "runs without network" is a
 *  claim nobody tests. This replaces global fetch with a refusal for the hosts
 *  the record covers, and returns a function that puts it back. */
export function banLiveFetch(target = globalThis) {
  const real = target.fetch
  target.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (RECORDED_HOSTS.includes(hostOf(url))) throw new Error(`${url} is a recorded host — the suite is reading scripts/fixtures/basemaps/, and ${REFRESH_HINT}`)
    return real(input, init)
  }
  return () => { target.fetch = real }
}

// ── the judgement ───────────────────────────────────────────────────────
/** Walks `keys` against whatever `read` answers, and returns findings tagged with
 *  the CONCERN they belong to (so each door can name its own checks) plus a
 *  summary the caller can put in a message. `fetchedAt` is the record's date, or
 *  now for a live read. */
export async function judgeBasemaps({ keys, centre, tuner, read, fetchedAt = '', now = Date.now() }) {
  const findings = []
  const fault = (concern, message) => findings.push({ concern, level: 'fault', message })
  const unreachable = (concern, message) => findings.push({ concern, level: 'unreachable', message })
  const summary = { recorded: fetchedAt, judged: [], sampled: [], hosts: [], sawExtrusions: 0 }

  if (!tuner || typeof tuner.tune !== 'function') {
    for (const concern of CONCERNS) fault(concern, 'the tuner did not load (HomeBasemapStyle), so there is nothing to judge the recorded styles with')
    return { findings, summary }
  }
  if (!Object.keys(tuner.DENSE || {}).length) fault('labels', 'the tuner declares no label layers, so a renamed upstream layer would be unmissable — the check passes for free')
  if (!Object.keys(tuner.FLAT || {}).length) fault('flat', 'the FLAT declaration is empty, so flatness is promised rather than checked')
  if (!PAINT_REQUIRED.length) fault('paint', 'the paint requirement is empty, so an empty tile would pass')
  if (!centre) fault('paint', 'the served WAY document declares no MAP_DEFAULT_CENTER, so there is no household view to sample')

  const readOr = async (concern, url, meta) => {
    try {
      return await read(url, meta)
    } catch (err) {
      if (err && err.missingFixture) fault(concern, `${url} has no recorded copy — ${REFRESH_HINT}`)
      else unreachable(concern, `${url}: ${err.message}`)
      return null
    }
  }
  const decode = (concern, res, url) => {
    try {
      return { layers: mvtLayers(res.bytes), bytes: res.bytes.length }
    } catch (err) {
      fault(concern, `${res.bytes.length}B from ${url} (${res.contentType}) is not a vector tile — ${err.message}`)
      return null
    }
  }

  let sawExtrusions = 0
  const templates = new Map() // template -> the zoom it is sampled at
  for (const k of keys) {
    if (!k.style) {
      fault('paint', `${k.key} draws a background the paint check does not judge — a raster key needs its own half (a real tile, not the flat few-hundred-byte block) before its URL can be added here`)
      continue
    }
    const styleRes = await readOr('labels', k.style, { kind: 'style' })
    if (!styleRes) continue
    let style = null
    try { style = JSON.parse(styleRes.bytes.toString('utf8')) } catch (err) { fault('labels', `${k.style} is not JSON — ${err.message}`); continue }

    // Labels: only a key that ASKS for the tuned set is judged against it (the
    // pale key's style is deliberately a different set of layers).
    if (k.dense) {
      const { style: tuned, missing } = tuner.tune(style)
      for (const id of missing) fault('labels', `${id} is gone from ${k.style} — the label table declares a layer upstream no longer has`)
      for (const [id, zoom] of Object.entries(tuner.DENSE)) {
        const layer = (tuned.layers || []).find((l) => l.id === id)
        if (layer && layer.minzoom !== zoom) fault('labels', `${id} in ${k.style} sits at z${layer.minzoom}, not the declared z${zoom}`)
      }
    }

    // Flatness, judged on the OUTPUT for every key, whatever it asks for.
    const flatStyle = tuner.tune(style, false).style
    const still3d = (flatStyle.layers || []).filter((l) => l.type === 'fill-extrusion')
    if (still3d.length) fault('flat', `${k.style} still draws ${still3d.map((l) => l.id).join(', ')}`)
    for (const gone of (style.layers || []).filter((l) => l.type === 'fill-extrusion')) {
      sawExtrusions++
      const covered = (flatStyle.layers || [])
        .filter((l) => l['source-layer'] === gone['source-layer'])
        .some((l) => (l.minzoom || 0) <= (gone.minzoom || 0) && (l.maxzoom === undefined || l.maxzoom >= (gone.maxzoom || 24)))
      if (!covered) fault('flat', `${gone.id} is gone from ${k.style} and nothing draws its '${gone['source-layer']}' footprints from z${gone.minzoom || 0} up`)
    }

    // Paint: walk the style's own sources to the tile a street-level view is made
    // of, at the household's own centre and at the source's own deepest zoom.
    for (const [sourceName, source] of Object.entries(style.sources || {}).filter(([, s]) => s.type === 'vector')) {
      if (source.url) summary.hosts.push(hostOf(source.url))
      for (const u of source.tiles || []) summary.hosts.push(hostOf(u))
      let tilejson = source
      if (source.url) {
        const tj = await readOr('paint', source.url, { kind: 'tilejson' })
        if (!tj) continue
        try { tilejson = JSON.parse(tj.bytes.toString('utf8')) } catch (err) { fault('paint', `${source.url} is not JSON — ${err.message}`); continue }
      }
      const template = (tilejson.tiles || [])[0]
      if (!template) { fault('paint', `${k.key}: source "${sourceName}" names no tile template`); continue }
      const zoom = Number(tilejson.maxzoom || source.maxzoom) || FALLBACK_MAXZOOM
      templates.set(template, zoom)
      const { x, y } = tileAt(centre, zoom)
      const tileUrl = template.replace('{z}', zoom).replace('{x}', x).replace('{y}', y)
      if (!tileUrl.startsWith('https://')) { fault('paint', `${tileUrl} is not https, so a browser blocks it before anyone sees it`); continue }
      const res = await readOr('paint', tileUrl, { kind: 'tile', view: `household@${zoom}` })
      if (!res) continue
      const tile = decode('paint', res, tileUrl)
      if (!tile) continue
      summary.sampled.push({ view: `household@${zoom}`, url: tileUrl, bytes: res.bytes.length, layers: tile.layers })
      const shapes = tile.layers.map((l) => `${l.name}(${l.features})`)
      const missing = PAINT_REQUIRED.filter((want) => !(tile.layers.find((l) => l.name === want) || {}).features)
      if (!tile.layers.length) fault('paint', `${k.key}: the tile at the household's own view is EMPTY (${res.bytes.length}B, ${res.contentType}) — a block and an over-native request both look exactly like this, and neither is an HTTP error`)
      else if (missing.length) fault('paint', `${k.key}: the household's own view has no ${missing.join('/')} — z${zoom} there carries ${shapes.slice(0, 14).join(', ')}`)
      else summary.judged.push(`${k.key} z${zoom} ${res.bytes.length}B ${tile.layers.length} layer(s)`)
    }
  }

  summary.sawExtrusions = sawExtrusions
  // The control: the same source at the same zoom over open water must carry none
  // of it. A requirement a tile with nothing in it satisfies anyway is not a
  // check — it is a reader that names layers whatever the bytes are.
  if (sawExtrusions === 0) {
    fault('flat', 'the recorded styles draw no 3D at all, so the FLAT declaration has lost its subject — delete it rather than leave a check that passes for free')
  }
  if (!templates.size) {
    fault('control', 'no tile was sampled, so the empty-view control has nothing to answer about')
  }
  for (const [template, zoom] of templates) {
    const { x, y } = tileAt(EMPTY_VIEW, zoom)
    const url = template.replace('{z}', zoom).replace('{x}', x).replace('{y}', y)
    const res = await readOr('control', url, { kind: 'tile', view: `empty@${zoom}` })
    if (!res) continue
    const tile = decode('control', res, url)
    if (!tile) continue
    summary.sampled.push({ view: `empty@${zoom}`, url, bytes: res.bytes.length, layers: tile.layers })
    const carried = PAINT_REQUIRED.filter((want) => (tile.layers.find((l) => l.name === want) || {}).features)
    if (carried.length) fault('control', `the empty-view control at ${url} carries ${carried.join('/')}, so the requirement above is met by the reader rather than by the data`)
  }

  // Freshness, and it is not decoration: the whole point of the record is that the
  // answer is about a COPY. Past STALE_DAYS that copy is itself the finding.
  const age = recordAgeDays({ recordedAt: fetchedAt }, now)
  if (fetchedAt && age !== null && age > STALE_DAYS) {
    findings.push({ concern: 'record', level: 'stale', message: `the record was written ${age} days ago (${fetchedAt.slice(0, 10)}) — the checks are answering about a copy of somebody else's server; ${REFRESH_HINT}` })
  }
  return { findings, summary }
}

export function formatFindings(findings) {
  return findings.map((f) => `${(f.level === 'fault' ? '✗' : f.level === 'stale' ? '!' : '·')} [${f.concern}] ${f.message}`)
}
