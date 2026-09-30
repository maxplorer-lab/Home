#!/usr/bin/env node
// ─── The map's engines are files: proof that smoke §15 can fail ─────────────
// Falsification driver for the three guards `npm run smoke` §15 grew on
// 2026-09-27, when the map's geometry, verdict, ruler and day-legs moved out of
// `public/way/index.html` into `public/shared/`.
//
// Why these three need one. The first guard's subject is an ABSENCE (no engine
// body pasted back into the page), and a check that forbids something passes
// just as hard when it is looking in the wrong place; the second asserts a
// SHAPE (a one-line return) that a rewrite can grow past; the third asserts a
// delegation in a SECOND document, whose include can be dropped without the map
// noticing at all. Each mutation attacks exactly one of them:
//
//   M1  pastes the ruler's body back into the page (the copy nobody reads)
//   M2  grows a delegation into a function that computes on its own
//   M3  puts the share's own haversine back, in the other algebraic form
//
//   node scripts/one-off/2026-09-27-map-engines/mutate.mjs
//
// Needs a RUNNING dev server (`npm run dev`), because smoke §15 reads the SERVED
// documents rather than the sources — set BASE_URL (default
// http://127.0.0.1:8787). It runs the whole suite per mutation, so allow ~3× a
// normal run. Leaves the tree byte-identical, or it says so.

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
// This working tree is a WINDOWS checkout: files on disk are CRLF while every
// anchor below is written with a plain \n. Matching raw bytes misses the anchor
// — and a missed anchor is a SKIPPED mutation, which changes no code and still
// exits 0. So anchors match a normalised copy and write back with the ending the
// file already had.
const normalized = (p) => read(p).replace(/\r\n/g, '\n')
function writeKeepingEol(p, text) {
  const crlf = read(p).includes('\r\n')
  write(p, crlf ? text.replace(/\n/g, '\r\n') : text)
}

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787'

const mutations = [
  {
    id: 'M1',
    file: 'public/way/index.html',
    why: 'the ruler is page code again, next to the DOM half that reads it',
    guard: "the map's engines are files that load into a bare window, and the page keeps no copy of them",
    from: 'function renderStripPicker() {',
    to: 'function meetStripScale(dist, subjectKey) { return 200; }\nfunction renderStripPicker() {',
  },
  {
    id: 'M2',
    file: 'public/way/index.html',
    why: "a page name stops being a one-line return and starts working things out",
    guard: 'the names the page still calls are one line each, into the shared engines',
    from: 'function computeLegsForDay(pings) {\n    return tripLegs.forDay(pings);\n}',
    to: 'function computeLegsForDay(pings) {\n    var legs = tripLegs.forDay(pings);\n    return legs;\n}',
  },
  {
    id: 'M3',
    file: 'public/live/index.html',
    why: 'the share measures with its own haversine again',
    guard: 'the public share measures with the same geometry as the map',
    from: '  function distanceM(lat1, lon1, lat2, lon2) {\n    return HomeGeo.distanceMeters(lat1, lon1, lat2, lon2);\n  }',
    to: '  function distanceM(lat1, lon1, lat2, lon2) {\n'
      + '    var dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;\n'
      + '    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);\n'
      + '    return 2 * 6371000 * Math.asin(Math.sqrt(a));\n  }',
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

let survived = 0
for (const m of mutations) {
  const original = normalized(m.file)
  const before = sha(m.file)
  if (!original.includes(m.from)) {
    console.log(`${m.id}  ANCHOR MISSING — ${m.from.slice(0, 60)}`)
    survived++
    continue
  }
  writeKeepingEol(m.file, original.replace(m.from, m.to))
  settle()
  let out
  try {
    out = runSuite()
  } finally {
    writeKeepingEol(m.file, original)
  }
  const restored = sha(m.file) === before
  const red = out.includes('✗') && new RegExp(`✗[^\\n]*${m.guard}`).test(out)
  console.log(`${m.id}  caught=${red ? 'YES' : 'NO '}  restored=${restored ? 'yes' : 'NO'}  (${m.why})`)
  if (!red || !restored) survived++
}

console.log(survived === 0
  ? '\nall three guards catch their own fault; tree restored'
  : `\n${survived} mutation(s) survived — a guard is decoration`)
process.exit(survived === 0 ? 0 : 1)
