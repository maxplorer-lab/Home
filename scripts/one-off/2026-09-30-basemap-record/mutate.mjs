#!/usr/bin/env node
// ─── The basemap record audit can still fail ────────────────────────────
// Falsification driver for `npm run audit:basemaps`, which CI runs because the
// basemap checks judge somebody else's tile host: the suite (smoke §9) and this
// audit read a RECORD of it, `scripts/fixtures/basemaps/`, judged by the walk in
// `scripts/lib/basemap-record.mjs`.
//
// Why a second driver rather than more mutations in
// `scripts/one-off/2026-09-30-basemap-names/mutate.mjs`. That one runs the whole
// suite per mutation because smoke §9 reads the SERVED documents, so it needs a
// dev server and cannot run in the `guards` job. The audit has no such need: its
// subject is a copy in the repo, so a fault here is a file edit and a run of
// seconds. That is what makes the pair worth having — the expensive driver covers
// what only a running app can answer, this one covers the CI gate itself.
//
//   R1  there is no record at all
//   R2  the recorded TileJSON names a release the record has no bytes for
//   R3  the record hands the open-water tile over as the household's own view
//   R4  the paint requirement is emptied, so the check can never fail
//   R5  the record is older than the staleness bound and judged anyway
//   R6  the offline ban is disarmed, so the audit could have answered from the net
//
//   node scripts/one-off/2026-09-30-basemap-record/mutate.mjs
//
// No server, no database, and — except for R6, which fetches on purpose to prove
// the ban is what stops it — no network. Leaves the tree byte-identical, or it
// says so.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../../../', import.meta.url)
const rootPath = fileURLToPath(root)
const path = (p) => fileURLToPath(new URL(p, root))
const readJson = (p) => JSON.parse(readFileSync(path(p), 'utf8'))
const writeJson = (p, value) => writeFileSync(path(p), JSON.stringify(value, null, 2) + '\n')
const sha = (p) => createHash('sha256').update(readFileSync(path(p))).digest('hex')

const INDEX = 'scripts/fixtures/basemaps/index.json'
const TILEJSON = 'scripts/fixtures/basemaps/tiles_openfreemap_org_planet.json'
const LIB = 'scripts/lib/basemap-record.mjs'

// Every mutation below edits one of these three, so the whole set is snapshotted
// once and put back from the bytes — an inverse edit can be wrong in a way the
// sha check would still call restored.
const TOUCHED = [INDEX, TILEJSON, LIB]
const snapshot = new Map(TOUCHED.map((f) => [f, readFileSync(path(f))]))
const indexMoved = `${INDEX}.moved`
const restoreAll = () => {
  for (const [f, buf] of snapshot) writeFileSync(path(f), buf)
  try { renameSync(path(indexMoved), path(INDEX)) } catch { /* R1 not applied, or already back */ }
}

const HOUSEHOLD_FILE = 'tiles_openfreemap_org_planet_20260927_080001_pt_14_10355_9068_pbf.pbf'
const EMPTY_FILE = 'tiles_openfreemap_org_planet_20260927_080001_pt_14_11832_9624_pbf.pbf'

const swapIn = (file, find, replace) => {
  const text = readFileSync(path(file), 'utf8')
  if (!text.includes(find)) throw new Error(`anchor missing in ${file}: ${find.slice(0, 48)}`)
  writeFileSync(path(file), text.replace(find, replace))
}

const mutations = [
  {
    id: 'R1',
    why: 'the record is gone, so there is nothing to answer about',
    expect: 'MISSING',
    apply: () => renameSync(path(INDEX), path(indexMoved)),
  },
  {
    id: 'R2',
    why: 'the recorded TileJSON names a release the record has no bytes for',
    expect: 'has no recorded copy',
    apply: () => swapIn(TILEJSON, 'planet/20260927_080001_pt/{z}/{x}/{y}.pbf', 'planet/20261001_000000_zz/{z}/{x}/{y}.pbf'),
  },
  {
    id: 'R3',
    why: 'the household view is handed the open-water payload',
    expect: 'has no building',
    apply: () => {
      const index = readJson(INDEX)
      for (const e of index.entries) if (e.file === HOUSEHOLD_FILE) e.file = EMPTY_FILE
      writeJson(INDEX, index)
    },
  },
  {
    id: 'R4',
    why: 'the paint requirement is emptied, so the check can never fail',
    expect: 'paint requirement is empty',
    apply: () => swapIn(LIB, "export const PAINT_REQUIRED = ['building', 'transportation', 'place']", 'export const PAINT_REQUIRED = []'),
  },
  {
    id: 'R5',
    why: 'the record is older than the staleness bound and judged anyway',
    expect: 'days ago',
    apply: () => {
      const index = readJson(INDEX)
      index.recordedAt = '2020-01-01T00:00:00.000Z'
      writeJson(INDEX, index)
    },
  },
  {
    id: 'R6',
    why: 'the offline ban is disarmed, so the audit could answer from the network',
    expect: 'ban did not bite',
    apply: () => swapIn(LIB, 'if (RECORDED_HOSTS.includes(hostOf(url))) throw', 'if (false) throw'),
  },
]

const runAudit = () => {
  try {
    return { out: execFileSync('node', ['scripts/basemap-record-audit.mjs'], { cwd: rootPath, encoding: 'utf8' }), code: 0 }
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? -1 }
  }
}

let survived = 0
for (const m of mutations) {
  const before = new Map(TOUCHED.map((f) => [f, sha(f)]))
  let result
  try {
    m.apply()
    result = runAudit()
  } finally {
    restoreAll()
  }
  const restored = TOUCHED.every((f) => sha(f) === before.get(f))
  const caught = result.code !== 0 && result.out.includes(m.expect)
  console.log(`${m.id}  caught=${caught ? 'YES' : 'NO '}  exit=${String(result.code).padStart(3)}  restored=${restored ? 'yes' : 'NO'}  (${m.why})`)
  if (!caught || !restored) {
    console.log(`      wanted an exit != 0 whose output names "${m.expect}"; got: ${result.out.split('\n').filter(Boolean).slice(0, 3).join(' | ')}`)
    survived++
  }
}

console.log(survived === 0
  ? `\nall ${mutations.length} mutations caught by the audit they attack; tree restored`
  : `\n${survived} mutation(s) survived or were not restored — the audit is decoration`)
process.exit(survived === 0 ? 0 : 1)
