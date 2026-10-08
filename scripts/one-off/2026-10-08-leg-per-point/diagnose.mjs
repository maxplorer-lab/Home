/**
 * Scratch: why does every persisted track point carry its own leg_id?
 *
 * Production (gps_pings, device Niri) shows 982 points on 2026-10-07 across 977
 * legs -- 972 of them single-point -- while is_driving=1 and the device is
 * outside every fence, moving 20-30 m every 3 s. A leg should open on a
 * confirmed departure and survive until a stop.
 *
 * This drives the engine with an unambiguously continuous drive and prints the
 * leg id and the isStationary flag for every ping.
 *
 * Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/way-ts-hooks.mjs scripts/one-off/2026-10-08-leg-per-point/diagnose.mjs
 */
import { processPing, initialMotionState } from '../../../src/way/lib/state-machine.ts'

const LAT0 = -18.8792
const LON0 = 47.5079
// 20 km/h due north, one ping every 3 s: 16.7 m per step.
const SPEED_KMH = 20
const STEP_S = 3
const M_PER_STEP = (SPEED_KMH * 1000 / 3600) * STEP_S

const T0 = Date.parse('2026-10-07T04:01:00Z')

function drive(n, { geofences = [], from = null } = {}) {
  let state = from ?? initialMotionState()
  const rows = []
  for (let i = 1; i <= n; i++) {
    const t = new Date(T0 + i * STEP_S * 1000).toISOString()
    const ping = {
      deviceId: 'test',
      timestamp: t,
      latitude: LAT0 + (i * M_PER_STEP) / 111320,
      longitude: LON0,
      vel: SPEED_KMH,
    }
    const out = processPing(state, ping, geofences)
    state = out.state
    rows.push({
      t: t.slice(11, 19),
      legId: out.result.legId,
      stat: out.result.isStationary,
      inside: out.result.isInside,
      drv: out.result.isDriving,
      mode: state.motionMode,
      legOpen: state.legOpen,
      km: out.result.distance.toFixed(4),
    })
  }
  return { state, rows }
}

console.log('--- CASE 1: continuous drive, no fences at all ---')
const a = drive(12)
for (const r of a.rows) console.log(JSON.stringify(r))

console.log('\n--- CASE 2: same drive, but resumed from a TRAVELING state ---')
const seeded = initialMotionState()
seeded.motionMode = 'TRAVELING'
seeded.anchor = [LAT0, LON0, new Date(T0).toISOString()]
seeded.lastLat = LAT0
seeded.lastLon = LON0
seeded.lastTs = new Date(T0).toISOString()
seeded.lastRecordedPoint = [LAT0, LON0, new Date(T0).toISOString()]
seeded.legId = 100
seeded.legOpen = true
const b = drive(12, { from: seeded })
for (const r of b.rows) console.log(JSON.stringify(r))

console.log('\n--- CASE 3: same drive, with a fence 2 km away ---')
const c = drive(12, {
  geofences: [{
    name: 'home', displayName: 'Home', category: null,
    lat: LAT0 + 18000 / 111320, lon: LON0, radiusM: 100, exitRadiusM: null,
  }],
})
for (const r of c.rows) console.log(JSON.stringify(r))
