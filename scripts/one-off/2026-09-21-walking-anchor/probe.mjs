// ─── the walking-anchor probe ────────────────────────────────────────
// Run it from the repo root:  node scripts/one-off/2026-09-21-walking-anchor/probe.mjs
//
// WHY IT EXISTS. `computeDriving`'s walking return stores `distance: 0` on
// purpose, and the page measures a walking leg's geometry instead. What it must
// ALSO do is move `lastRecordedPoint`, because that is where the next driving
// segment measures from — leaving it at the last driving point charges the whole
// walked stretch to the drive that follows. That is arithmetic, and a source
// guard can only read the source, so this drives the REAL state machine over a
// synthetic drive -> walk -> drive and prints the distance it charges each row.
//
// HOW. The module is TypeScript and pure (no I/O, no clock, no D1), so Node's
// native type stripping can import it directly once two things are done in a
// temp copy: the extensionless specifiers get `.ts`, and the one type-only
// import (`Geofence`) is elided — Node cannot know it is a type, and the link
// fails on a missing export. Nothing here is imported by the app or the suite.
//
// READING IT. The walk row must store 0. The resumed drive row must charge ONE
// drive step (~0.10520 km), not that step plus the walk (~0.11572 km). Remove
// the `s.lastRecordedPoint = [lat, lon, dt];` line from the walking return in
// src/way/lib/state-machine.ts and the numbers swap: that is the mutation this
// probe was built to catch.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const dir = join(tmpdir(), 'home-eng-probe')
mkdirSync(dir, { recursive: true })

const rewrite = (src) =>
  src
    .replace(/from "\.\/geofence"/g, 'from "./geofence.ts"')
    .replace(/from "\.\.\/config"/g, 'from "./config.ts"')
    .replace(/import \{ Geofence, /, 'import { ')

const copy = (from, to) => writeFileSync(join(dir, to), rewrite(readFileSync(join(repo, from), 'utf8')))
copy('src/way/config.ts', 'config.ts')
copy('src/way/lib/geofence.ts', 'geofence.ts')
copy('src/way/lib/state-machine.ts', 'state-machine.ts')

const { initialMotionState, processPing } = await import(pathToFileURL(join(dir, 'state-machine.ts')).href)
const { WAY_CONFIG } = await import(pathToFileURL(join(dir, 'config.ts')).href)
const { haversineKm } = await import(pathToFileURL(join(dir, 'geofence.ts')).href)

const LAT = -18.9
const t0 = Date.UTC(2026, 8, 21, 12, 0, 0)
const iso = (s) => new Date(t0 + s * 1000).toISOString()

// 0.001° of longitude at 18.9°S is ~105 m; 0.0001° is ~10.5 m.
const DRIVE_STEP = 0.001
const WALK_STEP = 0.0001

const steps = []
let lon = 47.5
const push = (atS, step) => { lon += step; steps.push({ atS, lon }) }
steps.push({ atS: 0, lon })                                        // the anchor
for (const s of [10, 20, 30, 40, 50, 60]) push(s, DRIVE_STEP)      // driving: 105 m / 10 s
for (const s of [70, 80, 90]) push(s, WALK_STEP)                   // below threshold: guard window
for (const s of [100, 110, 120]) push(s, WALK_STEP)                // true walking
push(130, DRIVE_STEP)                                              // driving resumes

let state = { ...initialMotionState(), geoState: 'OUTSIDE' }
const rows = []
for (const p of steps) {
  const out = processPing(state, {
    deviceId: 'Probe', timestamp: iso(p.atS), latitude: LAT, longitude: p.lon, vel: null,
  }, [])
  state = out.state
  rows.push({ atS: p.atS, ...out.result })
}

const oneDriveStep = haversineKm(LAT, 47.5 + 0.006, LAT, 47.5 + 0.006 + DRIVE_STEP)
const oneWalkStep = haversineKm(LAT, 47.5 + 0.006 + 3 * WALK_STEP, LAT, 47.5 + 0.006 + 4 * WALK_STEP)
const walkedOnce = (r) => !r.isDriving

console.log('config:', {
  threshold: WAY_CONFIG.WALKING_DRIVING_THRESHOLD,
  buffer: WAY_CONFIG.SPEED_BUFFER_SIZE,
  walkGuard: WAY_CONFIG.WALKING_GUARD_SECONDS,
})
console.log('\nat   mode   distance_km   note')
for (const r of rows) {
  console.log(
    `${String(r.atS).padStart(3)}s ${r.isDriving ? 'drive ' : 'walk  '}  ${String(r.distance).padEnd(14)}` +
    (r.atS === 130 ? '  <- driving resumes' : r.isStationary ? '  stationary' : '')
  )
}
console.log(`\none drive step ${oneDriveStep.toFixed(5)} km · one walk step ${oneWalkStep.toFixed(5)} km`)

const resumed = rows[rows.length - 1]
const walkRows = rows.filter(walkedOnce)
const ok = [
  ['a walk row still stores distance 0', walkRows.length > 0 && walkRows.every((r) => r.distance === 0)],
  ['the resumed drive charges ONE drive step', Math.abs(resumed.distance - oneDriveStep) < 1e-4],
  ['it is NOT charged the walked stretch', resumed.distance < oneDriveStep + oneWalkStep / 2],
]
console.log('\nverdict')
for (const [what, pass] of ok) console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${what}`)
process.exit(ok.every(([, p]) => p) ? 0 : 1)
