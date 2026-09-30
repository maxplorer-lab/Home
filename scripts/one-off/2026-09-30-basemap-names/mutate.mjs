#!/usr/bin/env node
// ─── The labelled map carries names: proof that smoke §9 can fail ───────────
// Falsification driver for the checks smoke §9 carries since 2026-09-30, when
// the household's complaint — "esri is not detailed enough, just a colored
// version of the lite basemap", and then, given a better raster, "you just
// bolded the street names, and very few places" — turned the background from a
// raster into a VECTOR style whose label density is ours:
//
//   public/shared/basemaps.js      the keys: lite (pale), streets (dense)
//   public/shared/basemap-style.js the label density, patched at run time
//   public/shared/basemap-layer.js the ONE place a key becomes layers
//
// Why these need a driver. Every fault below leaves a map that renders
// perfectly: a style without the tuned labels is a map with fewer names, a page
// that draws its own layer is a map drawn by code nothing here reads, and a
// tuner whose table has been emptied reports no fault because it looks for
// nothing. "A gate nobody has seen fail is not a gate" is the whole of it.
//
//   M1  the labelled key stops asking for the dense label set
//   M2  the household map draws its own background instead of the shared path
//   M3  the tuner's table is emptied — a tuner that looks for nothing
//   M4  a key draws from a host whose terms and credit nobody has declared
//   M5  the tuner stops dropping 3D, so buildings rise again at z14
//   M6  the 3D goes but the flat twin keeps its zoom cap — footprints lost above
//       z14, which renders perfectly and is the fault a viewer would call "the
//       map has no buildings here"
//   M7  the household's own default view is moved to open water — a map that
//       renders perfectly and paints NOTHING, which is the fault the style-level
//       checks cannot see (they read JSON; the tile is somebody else's server)
//   M8  the paint requirement is emptied (in the lib now, where the walk lives) —
//       a check that can never fail, which is the shape of hole this suite keeps
//       finding
//   M9  the RECORD's TileJSON names a release upstream is not serving (the
//       fixture is the subject now, so a URL with no recorded bytes is a fault
//       that says "re-record" rather than "the network is down")
//   M10 the record's two tiles are swapped, so the household's own view is the
//       open-water payload: the check has to judge the BYTES, not the filename
//
//   node scripts/one-off/2026-09-30-basemap-names/mutate.mjs
//
// M2 also needs a RUNNING dev server (`npm run dev`), because smoke §9 reads the
// SERVED documents rather than the sources — set BASE_URL (default
// http://127.0.0.1:8787). It runs the whole suite per mutation, so allow ~10× a
// normal run; pass mutation ids to re-prove one guard on its own. Leaves the tree
// byte-identical, or it says so.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../../../', import.meta.url)          // the repo root (Home/)
const rootPath = fileURLToPath(root)
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const write = (p, s) => writeFileSync(new URL(p, root), s)
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex')

// ── line endings ─────────────────────────────────────────────────────
// This working tree is a WINDOWS checkout: the pages and the suite are CRLF
// while the shared modules are LF, and every anchor below is written with a
// plain \n. Matching raw bytes misses the anchor — and a missed anchor is a
// SKIPPED mutation, which changes no code and still exits 0. So anchors match a
// normalised copy and write back with the ending the file already had.
const normalized = (p) => read(p).replace(/\r\n/g, '\n')
function writeKeepingEol(p, text) {
  const crlf = read(p).includes('\r\n')
  write(p, crlf ? text.replace(/\n/g, '\r\n') : text)
}

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787'
const NAMES_GUARD = 'the labelled basemap asks for more names than the plain canvas'
const DRAWN_GUARD = 'both maps draw the background through the one shared path'
const DRIFT_GUARD = 'the style each key draws still has the label layers the tuner rewrites'
const HOST_GUARD = 'every basemap is https, and each one names who to credit'
const FLAT_GUARD = 'a style draws no 3D, and loses no footprint with it'
const PAINT_GUARD = "the basemap actually paints at the household's own street level"

const mutations = [
  {
    id: 'M1',
    file: 'public/shared/basemaps.js',
    why: 'the labelled key is a plain canvas again — no extra names asked for',
    guards: [NAMES_GUARD],
    from: "    style: 'https://tiles.openfreemap.org/styles/liberty',\n    dense: true,\n",
    to: "    style: 'https://tiles.openfreemap.org/styles/liberty',\n",
  },
  {
    id: 'M2',
    file: 'public/way/index.html',
    why: 'the household map builds its own background, outside the shared path',
    guards: [DRAWN_GUARD],
    from: '    const drawn = await HomeBasemapLayer.show(want, map);',
    to: "    const drawn = { key: want, layers: [L.maplibreGL({ style: HomeBasemaps[want].style })], credit: '' };\n    drawn.layers.forEach(function (l) { l.addTo(map); });",
  },
  {
    id: 'M3',
    file: 'public/shared/basemap-style.js',
    why: 'the tuner has nothing left to look for, so it can report nothing',
    guards: [DRIFT_GUARD],
    from: "  DENSE: {\n    'highway-name-minor': 14, // was 15: minor street names, the ones a viewer needs\n    'highway-name-path': 15,  // was 15.5\n    'poi_r1': 14,             // was 15: the first neighbourhood places\n    'poi_r7': 15,             // was 16\n    'poi_r20': 16,            // was 17\n  },",
    to: '  DENSE: {},',
  },
  {
    id: 'M4',
    file: 'public/shared/basemaps.js',
    why: 'a key draws from a host nobody has read the terms of',
    guards: [HOST_GUARD],
    from: "    style: 'https://tiles.openfreemap.org/styles/positron',",
    to: "    style: 'https://tiles.example.com/styles/positron',",
  },
  {
    id: 'M5',
    file: 'public/shared/basemap-style.js',
    why: 'buildings rise into 3D again — the extrusion is never dropped',
    guards: [FLAT_GUARD],
    from: "    tuned.layers = (tuned.layers || []).filter((l) => {\n      if (l.type !== 'fill-extrusion') return true\n      flattened.push(l.id)\n      return false\n    })",
    to: '    tuned.layers = tuned.layers || []',
  },
  {
    id: 'M6',
    file: 'public/shared/basemap-style.js',
    why: 'the 3D goes and the flat twin keeps its cap: no buildings above z14',
    guards: [FLAT_GUARD],
    from: "      delete twin.maxzoom\n",
    to: '      twin.maxzoom = 14\n',
  },
  {
    id: 'M7',
    file: 'public/way/index.html',
    why: 'the household\'s own view is moved to open water: a green suite drawing nothing',
    guards: [PAINT_GUARD],
    from: 'MAP_DEFAULT_CENTER: [-18.91, 47.53],',
    to: 'MAP_DEFAULT_CENTER: [-30.0, 80.0],',
  },
  {
    id: 'M8',
    file: 'scripts/lib/basemap-record.mjs',
    why: 'the paint requirement is emptied, so the check can never fail',
    guards: [PAINT_GUARD],
    from: "export const PAINT_REQUIRED = ['building', 'transportation', 'place']\n",
    to: 'export const PAINT_REQUIRED = []\n',
  },
  {
    id: 'M9',
    file: 'scripts/fixtures/basemaps/tiles_openfreemap_org_planet.json',
    why: 'the recorded TileJSON names a release the record has no bytes for',
    guards: [PAINT_GUARD],
    from: 'planet/20260927_080001_pt/{z}/{x}/{y}.pbf',
    to: 'planet/20261001_000000_zz/{z}/{x}/{y}.pbf',
  },
  {
    id: 'M10',
    file: 'scripts/fixtures/basemaps/index.json',
    why: 'the record hands the open-water tile over as the household view',
    guards: [PAINT_GUARD],
    from: '"file": "tiles_openfreemap_org_planet_20260927_080001_pt_14_10355_9068_pbf.pbf",',
    to: '"file": "tiles_openfreemap_org_planet_20260927_080001_pt_14_11832_9624_pbf.pbf",',
  },
]

// `wrangler dev` re-reads `public/` per request; give it a beat and warm the
// worker so the suite never reads a document served from the previous bytes.
function settle() {
  sleepMs(1500)
  try {
    execSync(`curl -s -o /dev/null --max-time 20 ${BASE}/live/index.html`, { stdio: 'ignore', shell: true })
  } catch { /* the suite will report a dead server far more clearly */ }
}

function runSuite() {
  try {
    return execSync('npm run smoke', {
      cwd: rootPath, encoding: 'utf8', timeout: 600000,
      env: { ...process.env, BASE_URL: BASE },
    })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

// Optional selection: `mutate.mjs M7 M8` re-falsifies just those, which is what a
// later change to one of these guards needs. No argument runs the lot.
const wanted = process.argv.slice(2).map((a) => a.toUpperCase())
const selected = wanted.length ? mutations.filter((m) => wanted.includes(m.id)) : mutations
if (!selected.length) {
  console.log(`no mutation matches ${wanted.join(', ')} — known: ${mutations.map((m) => m.id).join(', ')}`)
  process.exit(1)
}
if (wanted.length) console.log(`running ${selected.map((m) => m.id).join(', ')} of ${mutations.length} mutation(s)\n`)

// A mutation is a file edit, so this has to survive being interrupted: the run
// that gets stopped mid-suite used to leave the fault in the tree (found the hard
// way — a killed run left `MAP_DEFAULT_CENTER` over open water, which then made
// every OTHER mutation's suite fail the paint check and read as "caught").
let inFlight = null
const putBack = (loud = false) => {
  if (!inFlight) return false
  writeKeepingEol(inFlight.file, inFlight.original)
  if (loud) console.log(`\n${inFlight.id}  INTERRUPTED — ${inFlight.file} restored`)
  inFlight = null
  return true
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { putBack(true); process.exit(130) })

let survived = 0
for (const m of selected) {
  const original = normalized(m.file)
  const before = sha(m.file)
  if (!original.includes(m.from)) {
    console.log(`${m.id}  ANCHOR MISSING — ${m.from.slice(0, 60)}`)
    survived++
    continue
  }
  inFlight = { id: m.id, file: m.file, original }
  writeKeepingEol(m.file, original.replace(m.from, m.to))
  settle()
  let out
  try {
    out = runSuite()
  } finally {
    putBack()
  }
  const restored = sha(m.file) === before
  // Section 9 ends at the 9b banner: a run that never got there proves nothing,
  // and would otherwise read as "the guard stayed green".
  const reached = out.includes('9b. WAY HUD')
  const missed = m.guards.filter((g) => !(out.includes('✗') && new RegExp(`✗[^\\n]*${g}`).test(out)))
  console.log(`${m.id}  caught=${missed.length ? 'NO ' : 'YES'}  restored=${restored ? 'yes' : 'NO'}  reached9=${reached ? 'yes' : 'NO'}  (${m.why})`)
  if (missed.length || !restored || !reached) survived++
}

console.log(survived === 0
  ? `\nall ${selected.length} mutation(s) caught by the guard they attack; tree restored`
  : `\n${survived} mutation(s) survived or never ran — a guard is decoration`)
process.exit(survived === 0 ? 0 : 1)
