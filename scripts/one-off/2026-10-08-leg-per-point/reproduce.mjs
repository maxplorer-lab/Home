/**
 * Why every persisted track point carries its own leg_id (production, Oct 4 on).
 *
 * The legs' own bookkeeping is fine: replayed verbatim, a real 243-point drive
 * opens 2 legs (replay.mjs). What breaks it is the ingest handler's
 * read-modify-write around the save (FleetDO.ts, "re-read them just before the
 * write"):
 *
 *     const controls = this.loadDeviceState(ping.deviceId);
 *     if (controls.motion.pendingLegCut) newMotion.pendingLegCut = true;
 *     this.saveDeviceState(ping.deviceId, { motion: newMotion, ... });
 *
 * `controls` reads the row as the PREVIOUS ping left it. processPing has just
 * SPENT the pending cut for this ping (legId += 1, pendingLegCut = false), but
 * that is still only in memory -- this ping has not saved yet -- so the re-read
 * sees the old `true` and writes it straight back. The one-shot break becomes a
 * LATCH: from the first arm onward, every ping that measures movement mints a
 * leg, forever, with no pause anywhere in sight.
 *
 * This models that loop exactly (a JSON row, load -> processPing -> re-read ->
 * carry -> save) so the difference is a one-line A/B, and so the race the carry
 * line EXISTS for -- a pause landing mid-handler -- can be checked against the
 * candidate fix rather than assumed.
 *
 * Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/way-ts-hooks.mjs scripts/one-off/2026-10-08-leg-per-point/reproduce.mjs
 */
import {
  processPing,
  initialMotionState,
  applyRecordingPause,
} from '../../../src/way/lib/state-machine.ts'

const LAT0 = -18.8792
const LON0 = 47.5079
const T0 = Date.parse('2026-10-07T04:01:00Z')

/** A 20 km/h drive due north: the shape production stores, 3 s apart. */
function drivePoints(n) {
  const mPerStep = (20 * 1000 / 3600) * 3
  return Array.from({ length: n }, (_, i) => ({
    deviceId: 'Niri',
    timestamp: new Date(T0 + (i + 1) * 3000).toISOString(),
    latitude: LAT0 + ((i + 1) * mPerStep) / 111320,
    longitude: LON0,
    vel: 20,
  }))
}

/**
 * The DO's row, as device_state stores it: JSON in, JSON out.
 *
 * carry:
 *   'latch'   -- production: re-assert pendingLegCut whenever the row has it
 *   'none'    -- no carry at all: the mid-handler pause's break is LOST
 *   'guarded' -- carry only an arm NEWER than the state this ping started from
 */
function makeDo({ carry }) {
  let row = JSON.stringify({
    motion: initialMotionState(), forcedMode: null, recordingPaused: false,
  })

  const load = () => JSON.parse(row)
  const save = (state) => { row = JSON.stringify(state) }

  return {
    /** setRecordingPaused(paused): the ONLY place the cut is armed. */
    setRecordingPaused(paused) {
      const stored = load()
      if (paused && !stored.recordingPaused) applyRecordingPause(stored.motion)
      stored.recordingPaused = paused
      save(stored)
    },

    /** One ingest: load, process, re-read for the controls, carry, save. */
    ingest(ping, { pauseLandsMidHandler = false } = {}) {
      const stored = load()
      const { state: newMotion, result } = processPing(stored.motion, ping, [], stored.forcedMode)

      if (pauseLandsMidHandler) {
        // The dashboard's pause arrives on the WebSocket WHILE this handler was
        // awaiting the geofence list, and arms the row behind our back. This is
        // the race the carry line exists for, and what it must not lose.
        const armed = load()
        applyRecordingPause(armed.motion)
        armed.recordingPaused = true
        save(armed)
      }

      if (carry === 'latch') {
        const controls = load()
        if (controls.motion.pendingLegCut) newMotion.pendingLegCut = true
      } else if (carry === 'guarded') {
        const controls = load()
        if (controls.motion.pendingLegCut && !stored.motion.pendingLegCut) {
          newMotion.pendingLegCut = true
        }
      }

      const controls = load()
      save({
        motion: newMotion, forcedMode: controls.forcedMode,
        recordingPaused: controls.recordingPaused,
      })

      const persisted = !stored.recordingPaused && !result.isInside && !result.isStationary
      return { persisted, legId: newMotion.legId, pendingLegCut: newMotion.pendingLegCut }
    },

    peek: () => load().motion,
  }
}

/**
 * One timeline for every case: drive (so a leg is OPEN), one pause/resume --
 * exactly one arm, as the feature intends -- then drive again. `pauseMidHandler`
 * puts the pause on the wire during the first ping after the resume instead of
 * between pings. Nothing else differs.
 */
function run(label, { carry, pauseMidHandler = false }) {
  const doObj = makeDo({ carry })
  const points = drivePoints(60)

  const out = []
  for (let i = 0; i < 2; i++) out.push(doObj.ingest(points[i])) // open a leg
  doObj.setRecordingPaused(true)   // the arm
  doObj.setRecordingPaused(false)  // the resume

  const held = pauseMidHandler
    ? doObj.ingest(points[2], { pauseLandsMidHandler: true })
    : doObj.ingest(points[2])
  doObj.setRecordingPaused(false)  // clear the mid-handler pause
  out.push(held)
  for (const p of points.slice(3)) out.push(doObj.ingest(p))

  const stored = out.filter((r) => r.persisted)
  const legs = [...new Set(stored.map((r) => r.legId))]

  console.log(`\n${label}`)
  console.log(`  points persisted: ${stored.length}   legs among them: ${legs.length}`)
  console.log(`  legId per persisted point (first 12): ${stored.slice(0, 12).map((r) => r.legId).join(', ')}`)
  console.log(`  pendingLegCut left in the state: ${doObj.peek().pendingLegCut}`)
  if (pauseMidHandler) {
    // The break armed mid-handler must not be lost: the next movement has to
    // open a fresh leg, or a paused stretch gets drawn as one continuous line.
    const survived = held.pendingLegCut === true
    const honoured = legs.length === 2
    console.log(`  break armed mid-handler survived the save: ${survived ? 'YES' : 'NO'}`)
    console.log(`  break honoured (exactly one leg cut): ${honoured ? 'YES' : 'NO'}`)
  }
}

console.log('A 20 km/h drive, after ONE pause/resume: leg ids on the points that were stored')

run('A. production: blanket carry (FleetDO.ts:1378)', { carry: 'latch' })
run('B. no carry at all', { carry: 'none' })
run('C. candidate fix: carry only a NEWER arm', { carry: 'guarded' })

console.log('\n--- the race the carry line exists for: the pause lands MID-HANDLER ---')
run('D. production carry', { carry: 'latch', pauseMidHandler: true })
run('E. candidate fix', { carry: 'guarded', pauseMidHandler: true })
