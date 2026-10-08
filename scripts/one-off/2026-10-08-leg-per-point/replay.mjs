/**
 * Replay the REAL persisted stream from production through the engine.
 *
 * The slice is every point the flush stored for device Niri between
 * 2026-10-07T04:01 and 04:20, in insertion (ingest) order, with the leg_id each
 * one was PERSISTED with. Feeding the same points back through processPing
 * shows whether the engine itself mints a leg per point, or whether the field
 * state it was handed differs from what a replay assumes.
 *
 * out/slice.json is a production dump (gitignored). Refetch it with:
 *
 *   node node_modules/wrangler/bin/wrangler.js d1 execute home-db --remote --json \
 *     --command "SELECT timestamp, latitude, longitude, speed FROM gps_pings \
 *       WHERE device_id='Niri' AND timestamp >= '2026-10-07T04:01:00' \
 *       AND timestamp <= '2026-10-07T04:20:00' ORDER BY id" \
 *     > scripts/one-off/2026-10-08-leg-per-point/out/slice.json 2>/dev/null
 *
 * ORDER BY id, not timestamp: ingest order is what the leg ids count.
 *
 * Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/way-ts-hooks.mjs scripts/one-off/2026-10-08-leg-per-point/replay.mjs
 */
import { readFileSync } from 'node:fs'
import { processPing, initialMotionState } from '../../../src/way/lib/state-machine.ts'

const raw = JSON.parse(readFileSync(new URL('./out/slice.json', import.meta.url), 'utf8'))
const points = raw[0].results
console.log(`replaying ${points.length} real points`)

let state = initialMotionState()
let prevTs = null
let engineLegs = 0
let persistedLegs = new Set()
let lastEngineLeg = null

for (const [i, p] of points.entries()) {
  const gap = prevTs === null
    ? 0
    : (Date.parse(p.timestamp) - Date.parse(prevTs)) / 1000
  prevTs = p.timestamp

  const out = processPing(state, {
    deviceId: 'Niri',
    timestamp: p.timestamp,
    latitude: p.latitude,
    longitude: p.longitude,
    vel: p.speed,
  }, [])
  state = out.state

  if (out.result.legId !== lastEngineLeg) {
    engineLegs++
    lastEngineLeg = out.result.legId
  }
  if (i < 25) {
    console.log(
      `${String(i).padStart(3)} ${p.timestamp.slice(11, 19)} gap=${String(gap).padStart(4)}s ` +
      `leg(engine)=${String(out.result.legId).padStart(4)} mode=${state.motionMode.padEnd(9)} ` +
      `open=${String(state.legOpen).padEnd(5)} stat=${out.result.isStationary}`
    )
  }
}

console.log(`\nengine legs opened over the slice: ${engineLegs} (one per point would be ${points.length})`)
console.log(`final engine legId: ${state.legId}`)
