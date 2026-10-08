/**
 * The tracking engine — `src/way/lib/geofence.ts` (geometry) and
 * `src/way/lib/state-machine.ts` (processPing) — under `node --test`.
 *
 * Home is the deployable Worker, so this is the copy that actually runs in
 * production; it is the mirror of `../W.A.Y/tests/tracking.test.mjs`; keep the
 * two in step. They have NOT stayed byte-identical: the deployed copy is AHEAD
 * of the standalone one, and the cases marked DIVERGED below pin the deployed
 * behaviour where the two engines genuinely differ (the 1 s same-second floor
 * in `isGlitch`, and the reported-speed credibility filter, which changes both
 * the entry-dwell case and the ping index where a stop confirms). Those are
 * deliberate field fixes, not drift — do not "restore" the W.A.Y expectation
 * here without a matching source change.
 *
 * The state machine is deliberately pure (no I/O, no clock reads: see its
 * header), so every case here drives it with literal timestamps and coordinates
 * and pins the behaviour that survived real field bugs, in the order W.A.Y's
 * docs/EXTENDING.md suggested them: boundary bounce, exit guard, bounce-back,
 * the driving/walking guard, glitch pre-filter, and leg bookkeeping. If a
 * change breaks one of these, it is the tracking semantics changing — decide
 * that deliberately, do not just repoint the test.
 *
 * The TS is imported directly: `npm test` preloads scripts/way-ts-hooks.mjs so
 * the Worker's extensionless imports resolve.
 *
 * No dev server, no database, no mocks — unlike `npm run smoke`.
 * Run: `npm test`. `npm run verify` = check + test + smoke.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { WAY_CONFIG } from '../src/way/config.ts'
import {
  haversineKm,
  distanceM,
  isInsideGeofence,
  circleCrossingPoint,
  bearingDegrees,
  angularDiff,
} from '../src/way/lib/geofence.ts'
import {
  applyRecordingPause,
  initialMotionState,
  isGlitch,
  processPing,
} from '../src/way/lib/state-machine.ts'

// ─── Fixtures ────────────────────────────────────────────────

// Antananarivo. Entry radius 100 m, exit radius 140 m (radiusM + the 40 m
// buffer -- this is the hysteresis the geometry tests pin).
const FENCE = {
  name: 'home',
  displayName: 'Home',
  category: null,
  lat: -18.8792,
  lon: 47.5079,
  radiusM: 100,
  exitRadiusM: null,
}

const T0 = Date.parse('2026-10-01T06:00:00Z')
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString()

/** A ping at the fence centre; override timestamp/position/vel per case. */
function ping(timestamp, overrides = {}) {
  return {
    deviceId: 'alice',
    timestamp,
    latitude: FENCE.lat,
    longitude: FENCE.lon,
    vel: 0,
    ...overrides,
  }
}

/** A point `metres` due north of the fence centre (1 deg lat ~ 111 320 m). */
function north(metres) {
  return { latitude: FENCE.lat + metres / 111320, longitude: FENCE.lon }
}

/** Feed a whole ping sequence through processPing, collecting every result. */
function run(pings, { state = initialMotionState(), geofences = [FENCE], forced = null } = {}) {
  const results = []
  let current = state
  for (const p of pings) {
    const outcome = processPing(current, p, geofences, forced)
    current = outcome.state
    results.push(outcome.result)
  }
  return { state: current, results }
}

/** Run `fn` with the process timezone set, restoring the previous value. */
function withTz(tz, fn) {
  const prev = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

// ─── Geofence geometry ───────────────────────────────────────

test('haversineKm: ~111.19 km per degree of latitude, and 0 for a point against itself', () => {
  assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - 111.1949) < 0.01)
  assert.ok(Math.abs(haversineKm(0, 1, 0, 0) - 111.1949) < 0.01, 'symmetric')
  assert.equal(haversineKm(FENCE.lat, FENCE.lon, FENCE.lat, FENCE.lon), 0)
})

test('distanceM is the same distance in metres', () => {
  assert.equal(distanceM(0, 1, 0, 0), haversineKm(0, 1, 0, 0) * 1000)
})

test('isInsideGeofence: tighter radius from outside, wider radius from inside', () => {
  // 120 m out: inside the 140 m exit radius, outside the 100 m entry radius.
  const near = north(120)
  assert.deepEqual(isInsideGeofence(near.latitude, near.longitude, [FENCE], false), {
    inside: false,
    fenceName: null,
  })
  assert.deepEqual(isInsideGeofence(near.latitude, near.longitude, [FENCE], true), {
    inside: true,
    fenceName: 'home',
  })
  // 150 m out: outside even the exit radius.
  const far = north(150)
  assert.equal(isInsideGeofence(far.latitude, far.longitude, [FENCE], true).inside, false)
  // 90 m out: inside even the entry radius.
  const close = north(90)
  assert.equal(isInsideGeofence(close.latitude, close.longitude, [FENCE], false).inside, true)
})

test('circleCrossingPoint lands on the radius, first crossing going outward', () => {
  const to = { latitude: FENCE.lat, longitude: FENCE.lon + 0.02 } // ~2.1 km east
  const point = circleCrossingPoint(FENCE.lat, FENCE.lon, to.latitude, to.longitude, FENCE.lat, FENCE.lon, 100)
  assert.ok(point, 'the segment reaches the circle')
  const d = distanceM(FENCE.lat, FENCE.lon, point[0], point[1])
  assert.ok(Math.abs(d - 100) < 1, `crossing sits on the radius (got ${d.toFixed(1)} m)`)
  assert.ok(point[1] > FENCE.lon, 'outward (east of centre)')
})

test('circleCrossingPoint is null when the segment never crosses', () => {
  const inside = north(50)
  assert.equal(
    circleCrossingPoint(FENCE.lat, FENCE.lon, inside.latitude, inside.longitude, FENCE.lat, FENCE.lon, 100),
    null,
    'both ends inside the circle'
  )
  const a = north(200)
  const b = north(300)
  assert.equal(
    circleCrossingPoint(a.latitude, a.longitude, b.latitude, b.longitude, FENCE.lat, FENCE.lon, 100),
    null,
    'both ends outside, moving away'
  )
  assert.equal(
    circleCrossingPoint(FENCE.lat, FENCE.lon, FENCE.lat, FENCE.lon, FENCE.lat, FENCE.lon, 100),
    null,
    'zero-length segment'
  )
})

test('bearingDegrees: N/E/S/W are 0/90/180/270', () => {
  assert.equal(Math.round(bearingDegrees(0, 0, 1, 0)), 0)
  assert.equal(Math.round(bearingDegrees(0, 0, 0, 1)), 90)
  assert.equal(Math.round(bearingDegrees(1, 0, 0, 0)), 180)
  assert.equal(Math.round(bearingDegrees(0, 1, 0, 0)), 270)
})

test('angularDiff takes the short way around', () => {
  assert.equal(angularDiff(350, 10), 20)
  assert.equal(angularDiff(10, 350), 20)
  assert.equal(angularDiff(0, 180), 180)
  assert.equal(angularDiff(0, 181), 179)
  assert.equal(angularDiff(90, 90), 0)
})

// ─── State machine: purity and defaults ──────────────────────

test('initialMotionState matches the DO row defaults', () => {
  const s = initialMotionState()
  assert.equal(s.geoState, 'CONFIRMED_INSIDE')
  assert.equal(s.motionMode, 'STAYING')
  assert.equal(s.anchor, null)
  assert.equal(s.pendingExitEdge, null)
  assert.equal(s.legId, 0)
  assert.equal(s.legOpen, false)
  assert.equal(s.pendingLegCut, false, 'Home-only field: the recording pause is a leg break')
  assert.equal(s.settlePending, false, 'Home-only field: unwitnessed crossings')
  assert.deepEqual(s.speedBuffer, [])
})

test('processPing does not mutate the prior state, and repeated runs agree', () => {
  const prior = initialMotionState()
  const snapshot = structuredClone(prior)
  const a = processPing(prior, ping(at(0)), [FENCE])
  const b = processPing(prior, ping(at(0)), [FENCE])
  assert.deepEqual(prior, snapshot, 'prior state untouched')
  assert.deepEqual(a, b, 'no hidden state or clock')
})

test('processPing is timezone-independent (ISO instants in, same decisions out)', () => {
  const sequence = [
    ping(at(0)),
    ping(at(30), { ...north(200) }),
    ping(at(60), { ...north(240) }),
  ]
  const seen = ['UTC', 'Africa/Nairobi', 'America/New_York'].map((tz) =>
    withTz(tz, () => run(sequence))
  )
  assert.deepEqual(seen[1], seen[0])
  assert.deepEqual(seen[2], seen[0])
})

// ─── State machine: the glitch pre-filter ────────────────────

test('isGlitch drops only implied speeds above PRE_FILTER_SPEED_LIMIT', () => {
  const t0 = at(0)
  const t1 = at(1)
  // ~11 m in 1 s ~ 40 km/h -- a normal ping.
  assert.equal(isGlitch(FENCE.lat, FENCE.lon, t0, FENCE.lat + 0.0001, FENCE.lon, t1), false)
  // ~56 m in 1 s ~ 200 km/h -- a GPS glitch.
  assert.equal(isGlitch(FENCE.lat, FENCE.lon, t0, FENCE.lat + 0.0005, FENCE.lon, t1), true)
  assert.equal(WAY_CONFIG.PRE_FILTER_SPEED_LIMIT, 120, 'the threshold this test describes')
})

// DIVERGED: W.A.Y's copy steps aside for non-positive dt (`dtSec <= 0 return
// false`), which let two same-second fixes kilometres apart through. Home
// judges that pair against GLITCH_TIME_FLOOR_S instead, so the assertions here
// are the deployed semantics -- see the source comment on GLITCH_TIME_FLOOR_S.
test('isGlitch judges a non-positive gap at GLITCH_TIME_FLOOR_S, not as no elapsed time', () => {
  const t = at(0)
  // Same-second pair, glitch-sized jump: ~56 m at the 1 s floor is 200 km/h.
  assert.equal(isGlitch(FENCE.lat, FENCE.lon, t, FENCE.lat + 0.0005, FENCE.lon, t), true)
  // Same-second pair, harmless jitter: ~5 m is 18 km/h and still passes.
  assert.equal(isGlitch(FENCE.lat, FENCE.lon, t, FENCE.lat + 0.000045, FENCE.lon, t), false)
  // Out-of-order pair: judged the same way, and a normal ~40 km/h jump passes.
  assert.equal(isGlitch(FENCE.lat, FENCE.lon, at(1), FENCE.lat + 0.0001, FENCE.lon, at(0)), false)
  assert.equal(WAY_CONFIG.GLITCH_TIME_FLOOR_S, 1.0, 'the floor this test describes')
})

// ─── State machine: fence hysteresis and guards ──────────────

test('a jitter ping inside the exit radius changes nothing', () => {
  // Start confirmed inside. The ping is 120 m out -- outside the entry radius,
  // inside the exit radius -- so it must not start an exit or open a leg.
  const { state, results } = run([ping(at(0), { ...north(120) }), ping(at(30), { ...north(120) })])
  assert.equal(state.geoState, 'CONFIRMED_INSIDE')
  for (const r of results) {
    assert.equal(r.isInside, true)
    assert.equal(r.edgePoint, undefined, 'no edge point from a bounce')
  }
  assert.equal(state.legId, 0)
  assert.equal(state.legOpen, false)
})

test('the exit fires only after EXIT_GUARD_SECONDS, and carries the fence-edge point', () => {
  const { state, results } = run([
    ping(at(0)), // confirmed inside, at the centre
    ping(at(30), { ...north(200) }), // first ping past the exit radius: EXITING
    ping(at(45), { ...north(220) }), // still inside the guard
    ping(at(60), { ...north(240) }), // guard elapsed: OUTSIDE
  ])
  assert.equal(results[0].isInside, true)
  assert.equal(results[1].isInside, true, 'the guard holds the exit')
  assert.equal(results[1].edgePoint, undefined, 'nothing emitted while EXITING')
  assert.equal(results[2].isInside, true, 'still guarding at +15 s')
  assert.equal(results[2].isDriving, true, 'movement stays live through the guard')
  assert.equal(results[3].isInside, false, 'the confirmed exit fires here')
  assert.equal(results[3].geofenceName, null)
  assert.equal(state.geoState, 'OUTSIDE')

  const edge = results[3].edgePoint
  assert.ok(edge, 'the confirmed exit carries the edge point')
  assert.equal(edge.timestamp, at(30), 'stamped when the exit started, not when confirmed')
  const edgeDistance = distanceM(FENCE.lat, FENCE.lon, edge.latitude, edge.longitude)
  assert.ok(
    Math.abs(edgeDistance - 140) < 1,
    `the edge point sits on the 140 m exit radius (got ${edgeDistance.toFixed(1)} m)`
  )
})

test('a bounce back inside before the guard discards the false start', () => {
  const { state, results } = run([
    ping(at(0)),
    ping(at(30), { ...north(200) }), // EXITING -- opens a leg, stashes an edge point
    ping(at(45), { ...north(50) }), // back inside the entry radius
  ])
  assert.equal(results[2].isInside, true)
  assert.equal(state.geoState, 'CONFIRMED_INSIDE')
  assert.equal(state.exitStartTime, null)
  assert.equal(state.pendingExitEdge, null, 'the stashed edge is discarded')
  assert.equal(state.anchor, null)
  assert.equal(state.pendingDeparture.length, 0)
  assert.equal(state.motionMode, 'STAYING')
  assert.equal(state.legId, 1)
  assert.equal(state.legOpen, false, 'the false-start leg is closed')
})

// ─── State machine: entry ────────────────────────────────────

/** Drive the device from confirmed-inside to a confirmed OUTSIDE. */
function exitHome() {
  return run([ping(at(0)), ping(at(30), { ...north(200) }), ping(at(60), { ...north(240) })])
}

test('entry confirms after ENTRY_GUARD_SECONDS of low-speed dwelling', () => {
  const away = exitHome()
  assert.equal(away.state.geoState, 'OUTSIDE')

  const back = run([ping(at(120), { ...north(50) }), ping(at(150), { ...north(50) })], {
    state: away.state,
  })
  assert.equal(back.results[0].isInside, false, 'dwelling, not yet arrived')
  assert.equal(back.results[1].isInside, true, '30 s of dwelling confirms')
  assert.equal(back.results[1].geofenceName, 'home')
  assert.equal(back.state.geoState, 'CONFIRMED_INSIDE')
})

// DIVERGED: the W.A.Y copy reports 20 km/h while standing still at 50 m, and
// the deployed reported-speed filter now refuses to believe that (the
// coordinates did not move), so its timer never restarts and entry confirms on
// wall time. Here the movement is real -- the device drives past and only then
// stops -- which is the case the speed gate exists for, so the assertion is the
// same one W.A.Y makes, against the deployed engine.
test('driving past inside the fence restarts the dwell timer; entry confirms 30 s after stopping', () => {
  const away = exitHome()
  const back = run(
    [
      ping(at(120), { ...north(600), vel: 40 }), // approaching, still outside
      ping(at(150), { ...north(300), vel: 40 }), // past the gate, still outside
      ping(at(165), { ...north(60), vel: 20 }), // inside, at speed: timer restarts
      ping(at(195), { ...north(60), vel: 0 }), // stopped; the average is still high
      ping(at(225), { ...north(60), vel: 0 }), // 30 s of dwelling: confirms
    ],
    { state: away.state }
  )
  assert.equal(back.results[2].isInside, false, 'at speed: no entry yet')
  assert.equal(back.results[3].isInside, false, 'the rolling average is still above the gate')
  assert.equal(back.results[4].isInside, true, '30 s after the wheels stop')
  assert.equal(back.results[4].geofenceName, 'home')
})

// ─── State machine: legs (the movement engine) ───────────────

// Inside -> fence departure (leg 1 opens) -> drive -> walk. Three zero-speed
// pings sit in the buffer, so the rolling average tracks the `vel` values.
const TRAVEL_PREFIX = [
  ping(at(0)),
  ping(at(30), { ...north(300) }),
  ping(at(60), { ...north(450) }),
  ping(at(90), { ...north(600), vel: 60 }),
  ping(at(120), { ...north(620), vel: 3 }),
  ping(at(150), { ...north(640), vel: 3 }),
  ping(at(165), { ...north(650), vel: 3 }),
  ping(at(180), { ...north(660), vel: 3 }),
  ping(at(195), { ...north(670), vel: 3 }),
]

test('a leg opens at fence departure and survives a brief driving->walking dip', () => {
  const { state, results } = run(TRAVEL_PREFIX)
  assert.equal(results[1].legId, 1, 'the leg opens when the fence is left')
  assert.equal(results[3].isDriving, true, '60 km/h is driving')
  assert.ok(results[3].distance > 0.1, 'a driving ping accumulates distance (km)')
  // The dip below the walking threshold starts at at(165); the first three
  // low-speed pings must stay classified as driving (traffic leniency)...
  assert.equal(results[6].isDriving, true)
  assert.equal(results[7].isDriving, true)
  // ...and only 30 s of the dip reclassifies as walking.
  assert.equal(results[8].isDriving, false)
  assert.equal(results[8].distance, 0, 'walking accumulates no driving distance')
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.equal(results[i].legId, 1, `ping ${i} belongs to leg 1`)
  }
  assert.equal(state.legOpen, true)
  assert.equal(state.motionMode, 'TRAVELING')
})

test('a confirmed stop closes the leg; the next movement opens a new one', () => {
  const { state, results } = run([
    ...TRAVEL_PREFIX,
    ping(at(255), { ...north(670), vel: 0 }), // 60 s of silence in the same spot: stop
    ping(at(285), { ...north(670), vel: 0 }), // still parked
    ping(at(315), { ...north(670), vel: 0 }), // still parked, still leg 1
    ping(at(345), { ...north(900), vel: 30 }), // moving again, not yet confirmed
    ping(at(360), { ...north(1200), vel: 30 }), // 15 s sustained: leg 2
  ])
  // DIVERGED, three ways. The stop lands one ping earlier than in the W.A.Y
  // copy, and the reason is now the silence rule rather than the average: the
  // deployed engine confirms a stop on STOP_CONFIRM_SECONDS (60 s since
  // 2026-10-06, 30 s in the W.A.Y copy) without a fix while still inside
  // ANCHOR_RADIUS_M of the last one, where W.A.Y waits for the rolling average
  // to fall under STATIONARY_SPEED_THRESHOLD -- which the deployed
  // reported-speed filter delays further, by disbelieving the walk's 3 km/h
  // (10 m between pings is inside REPORTED_SPEED_MIN_MOVE_M), so the average
  // is 2.4 rather than 3.0. The two silence cases below pin the parked-phone
  // bug that rule exists for.
  assert.equal(results[9].isStationary, true, 'the stop is confirmed on the silence itself')
  assert.equal(results[9].legId, 1, 'the stop belongs to leg 1')
  assert.equal(results[10].isStationary, true, 'and stays parked')
  assert.equal(results[11].isStationary, true, 'still parked 30 s later')
  assert.equal(results[12].legId, 1, 'the first movement ping is still the old leg')
  assert.equal(results[13].legId, 2, 'leg 2 opens only because leg 1 closed at the stop')
  assert.equal(results[13].isDriving, true)
  assert.ok(results[13].distance > 0.2, 'the leg replays from the anchor (km)')
  assert.equal(state.legId, 2)
  assert.equal(state.motionMode, 'TRAVELING')
  assert.equal(state.legOpen, true, 'leg 2 is open at the end of the run')
})

// The parked-phone bug these two pin: the phone's uploader only sends a point
// once the device has MOVED (µlogger's own minimum-distance setting), so a
// phone that stops moving goes SILENT. The case above still passes at a 60 s
// cadence, but the moment the client's filter withholds those pings there is
// nothing inside the candidate's 20 m bubble to accumulate a dwell span, and a
// device that stopped looks like it never did -- the leg stays open through the
// whole park and the "stopped" push never fires.
test('a silence longer than the confirmation window is itself a confirmed stop', () => {
  const { state, results } = run([
    ...TRAVEL_PREFIX, // the drive ends parked at north(670)
    ping(at(495), { ...north(679), vel: 0 }), // 5 min of silence, 9 m of drift
  ])
  assert.equal(results[9].isStationary, true, 'silence inside the anchor is a stop')
  assert.equal(results[9].legId, 1, 'the stop belongs to the leg it ended')
  assert.equal(results[9].distance, 0, 'the drift that broke the silence is not a track point')
  assert.equal(state.motionMode, 'STAYING')
  assert.equal(state.legOpen, false, 'the leg is closed by the silence')
})

test('a silence with real distance in it is not a stop -- the drive continues', () => {
  const { state, results } = run([
    ...TRAVEL_PREFIX,
    ping(at(495), { ...north(3670), vel: 60 }), // 3 km up the road, 5 min later
  ])
  assert.equal(results[9].isStationary, false, 'the device is 3 km from where it was last heard')
  assert.equal(results[9].isDriving, true)
  assert.ok(results[9].distance > 2.9, 'the silent stretch is counted, not collapsed (km)')
  assert.equal(state.legOpen, true, 'the leg is still open')
})

test('a backlog is judged on the fixes\' own timestamps, not on when they arrive', () => {
  // The phone lost signal mid-drive, so µlogger queued the fixes and offloaded
  // them in one burst later; each still carries the second it was captured at.
  // Nothing in this engine reads the wall clock, so the replayed burst reaches
  // the same conclusions it would have live -- and the one long gap in it (the
  // 2 min the app itself captured nothing) is a real 1.1 km of movement, which
  // is what keeps it from being mistaken for a stop.
  const { state, results } = run([
    ping(at(0)),
    ping(at(30), { ...north(200), vel: 50 }), // EXITING
    ping(at(60), { ...north(700), vel: 50 }), // OUTSIDE
    ping(at(75), { ...north(950), vel: 50 }), // 15 s sustained: leg 1 opens
    // ...offline from here; the queue below is uploaded in one go...
    ping(at(195), { ...north(2100), vel: 50 }), // 1.15 km across the 2 min gap
    ping(at(225), { ...north(2850), vel: 50 }),
    ping(at(255), { ...north(3600), vel: 50 }),
  ])
  for (const i of [4, 5, 6]) {
    assert.equal(results[i].isStationary, false, `backlog ping ${i} is not a stop`)
    assert.equal(results[i].isDriving, true)
  }
  assert.ok(results[4].distance > 1.1, 'the whole silent stretch is charged as driven km')
  assert.ok(results[5].distance > 0.7)
  assert.ok(results[6].distance > 0.7)
  assert.equal(state.legId, 1, 'one leg, not a leg per burst')
  assert.equal(state.legOpen, true)
  assert.equal(state.motionMode, 'TRAVELING')
})

test('the silence rule fires at STOP_CONFIRM_SECONDS, not a second earlier', () => {
  // Same drive, same parked drift; the two runs differ only in WHEN the first
  // fix after the silence arrives. The rolling average is still ~40 km/h in
  // both (the pre-park 60 km/h samples are only three deep), so the older
  // candidate-stop path cannot fire in either run -- the silence rule is the
  // only thing that can, which is what makes the pair a boundary test.
  const driveOut = [
    ping(at(0)),
    ping(at(30), { ...north(200), vel: 60 }),
    ping(at(45), { ...north(450), vel: 60 }),
    ping(at(60), { ...north(700), vel: 60 }),
  ]
  const early = run([...driveOut, ping(at(119), { ...north(708), vel: 0 })])
  const onTime = run([...driveOut, ping(at(120), { ...north(708), vel: 0 })])
  assert.equal(early.results[4].isStationary, false, '59 s of silence is not yet a stop')
  assert.equal(early.results[4].isDriving, true, 'and the 8 m of drift is still driven km')
  assert.ok(early.results[4].distance > 0)
  assert.equal(onTime.results[4].isStationary, true, '60 s of silence is')
  assert.equal(onTime.results[4].distance, 0, 'and the drift is not a track point')
})

test('forcedMode overrides only the driving/walking call', () => {
  const sequence = [
    ping(at(0)),
    ping(at(30), { ...north(200) }),
    ping(at(45), { ...north(220) }),
    ping(at(60), { ...north(240) }),
  ]
  const natural = run(sequence)
  const walking = run(sequence, { forced: 'walking' })
  const driving = run(sequence, { forced: 'driving' })
  assert.equal(natural.results[3].isDriving, true, 'unforced: still inside the walking guard')
  assert.equal(walking.results[3].isDriving, false, 'forced walking wins over the guard')
  assert.equal(walking.results[3].distance, 0)
  assert.equal(driving.results[3].isDriving, true)
  assert.ok(driving.results[3].distance > 0)
})

// ─── State machine: the recording pause is a leg break ───────

// DIVERGED: the DO's per-device "pause the log" switch exists in both copies,
// but only Home's engine breaks the leg for it (applyRecordingPause + the
// pendingLegCut flag); W.A.Y's standalone copy still joins the two halves of a
// paused day into one leg. Back-port deliberately or not at all -- do not
// "restore symmetry" by deleting these cases.

test('pausing the recording breaks the open leg and leaves the break pending', () => {
  const s = initialMotionState()
  s.legId = 3
  s.legOpen = true
  applyRecordingPause(s)
  assert.equal(s.legOpen, false, 'the leg ends where the pause lands')
  assert.equal(s.pendingLegCut, true, 'the next movement must open a fresh leg')
  assert.equal(s.legId, 3, 'the new id is minted by that movement, not by the pause')
})

test('pausing with nothing open arms nothing -- there is no leg to break', () => {
  const s = initialMotionState()
  applyRecordingPause(s)
  assert.equal(s.legOpen, false)
  assert.equal(s.pendingLegCut, false, 'a departure opens its leg the natural way instead')
})

test('a pause with no pings in it is still a break: the resumed drive is a new leg', () => {
  // The pause is a stored BIT, not a gap in the points: the parked phone's
  // uploader can send nothing at all between the pause and the resume, and a
  // pause shorter than the trail's own break threshold leaves no gap to see.
  // Either way the resumed drive must not be glued to the leg it followed.
  const { state } = run(TRAVEL_PREFIX)
  assert.equal(state.legOpen, true, 'the drive is one open leg')
  applyRecordingPause(state)
  const after = run([
    ping(at(225), { ...north(700), vel: 40 }),
    ping(at(240), { ...north(900), vel: 40 }),
  ], { state })
  // No STAYING -> TRAVELING transition here: the device never stopped, so the
  // pending break is the only thing that can open the new leg.
  assert.equal(after.results[0].isStationary, false, 'the resumed ping measures movement')
  assert.equal(after.results[0].legId, 2, 'it opens leg 2')
  assert.equal(after.results[1].legId, 2)
  assert.equal(after.state.legId, 2)
  assert.equal(after.state.legOpen, true)
  assert.equal(after.state.pendingLegCut, false, 'the break is spent, not left armed for the next movement')
})

test('the break is spent by the first ping that measures movement, never by a resume event', () => {
  // The pause gates STORING, never classifying -- pings keep flowing through
  // the engine while it is on. So the break is spent where the movement is,
  // and the first point stored after the resume already carries the new leg.
  const { state } = run(TRAVEL_PREFIX)
  applyRecordingPause(state)
  const during = run([
    ping(at(225), { ...north(700), vel: 40 }),
    ping(at(255), { ...north(1000), vel: 40 }),
  ], { state })
  assert.equal(during.results[0].legId, 2, 'the new leg opens while the pause is still on')
  assert.equal(during.results[1].legId, 2)
  assert.equal(during.state.pendingLegCut, false)
  const after = run([ping(at(285), { ...north(1300), vel: 40 })], { state: during.state })
  assert.equal(after.results[0].legId, 2, 'the first stored point after the resume is the new leg')
})

test('a break armed mid-drive survives a stop and is spent exactly once', () => {
  const { state } = run(TRAVEL_PREFIX)
  applyRecordingPause(state)
  const after = run([
    ping(at(495), { ...north(679), vel: 0 }), // 5 min of silence: the stop
    ping(at(525), { ...north(900), vel: 30 }), // departure candidate (reports a stay)
    ping(at(540), { ...north(1100), vel: 30 }), // 15 s sustained: movement
    ping(at(570), { ...north(1400), vel: 30 }),
  ], { state })
  assert.equal(after.results[0].isStationary, true, 'the stop is confirmed by the silence')
  assert.equal(after.state.legId, 2, 'one new leg -- the break is not spent again on every movement ping')
  assert.equal(after.results[2].legId, 2)
  assert.equal(after.results[3].legId, 2)
  assert.equal(after.state.pendingLegCut, false)
})

test('a break armed on the way home waits for the departure, not the arrival', () => {
  // Leg 1 opens as the device drives away, THEN the household pauses: the
  // break is armed. The device turns around and comes home instead. An
  // arrival is not a movement -- spending the break there would mint a leg
  // inside the fence, and the next real departure would cut itself in two.
  const started = run([ping(at(0)), ping(at(30), { ...north(200) })])
  assert.equal(started.state.legOpen, true, 'the drive away is one open leg')
  applyRecordingPause(started.state)
  const arrived = run([ping(at(45), { ...north(50) })], { state: started.state })
  assert.equal(arrived.results[0].isInside, true, 'back inside the fence')
  assert.equal(arrived.state.geoState, 'CONFIRMED_INSIDE')
  assert.equal(arrived.state.legId, 1, 'arriving home does not mint a leg')
  assert.equal(arrived.state.legOpen, false)
  assert.equal(arrived.state.pendingLegCut, true, 'the break waits for the next departure')
  const out = run([
    ping(at(90), { ...north(200) }),
    ping(at(105), { ...north(220) }),
    ping(at(120), { ...north(240) }),
  ], { state: arrived.state })
  assert.equal(out.state.geoState, 'OUTSIDE')
  assert.equal(out.state.motionMode, 'TRAVELING')
  assert.equal(out.state.legId, 2, 'the departure spends the break exactly once')
  assert.equal(out.state.legOpen, true)
  assert.equal(out.state.pendingLegCut, false)
})
