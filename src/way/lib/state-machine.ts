// state-machine.ts
// Direct port of fleet_tracker.py's StateMachine class. Deliberately NOT a
// class with internal mutation — this is a pure function: give it the
// device's prior persisted state + a new ping, get back the new state
// (to persist into the DO's device_state row) + a classification result
// (to persist into pending_sync, subject to the DO's own driving/walking
// throttle decision, and to broadcast live).
//
// KEEP IT PURE: no I/O, no clock reads, no D1/DO access, no notifications.
// Everything it needs is passed in and everything it decides is returned.
// That property is what makes the tracking engine testable and changeable at
// all. (The standalone W.A.Y project's docs/EXTENDING.md and
// docs/ARCHITECTURE.md, under ../W.A.Y, explain how the stages fit together —
// they were not carried into the merged app.)
//
// All constants and logic below are a 1:1 port of the Python original --
// see fleet_tracker.py for the reasoning behind each guard/threshold.

import { Geofence, isInsideGeofence, distanceM, haversineKm, circleCrossingPoint } from "./geofence";
import { WAY_CONFIG } from "../config";

// ============================================================
//  Local aliases -- all real values live in config.ts. Kept as short
//  names here purely so the logic below stays readable; edit values in
//  config.ts, never here.
// ============================================================
const ENTRY_GUARD_SECONDS = WAY_CONFIG.ENTRY_GUARD_SECONDS;
const EXIT_GUARD_SECONDS = WAY_CONFIG.EXIT_GUARD_SECONDS;
const EXIT_WITNESS_GAP_S = WAY_CONFIG.EXIT_WITNESS_GAP_S;
const WALKING_GUARD_SECONDS = WAY_CONFIG.WALKING_GUARD_SECONDS;
const SPEED_BUFFER_SIZE = WAY_CONFIG.SPEED_BUFFER_SIZE;
const WALKING_DRIVING_THRESHOLD = WAY_CONFIG.WALKING_DRIVING_THRESHOLD;
const STATIONARY_SPEED_THRESHOLD = WAY_CONFIG.STATIONARY_SPEED_THRESHOLD;
const PRE_FILTER_SPEED_LIMIT = WAY_CONFIG.PRE_FILTER_SPEED_LIMIT;
const PRE_FILTER_MAX_ACCURACY_M = WAY_CONFIG.PRE_FILTER_MAX_ACCURACY_M;
const GLITCH_TIME_FLOOR_S = WAY_CONFIG.GLITCH_TIME_FLOOR_S;
const REPORTED_SPEED_MIN_MOVE_M = WAY_CONFIG.REPORTED_SPEED_MIN_MOVE_M;
const REPORTED_SPEED_MIN_GAP_S = WAY_CONFIG.REPORTED_SPEED_MIN_GAP_S;

const ENTRY_CONFIRM_SPEED_KMH = WALKING_DRIVING_THRESHOLD;

const ANCHOR_RADIUS_M = WAY_CONFIG.ANCHOR_RADIUS_M;
const MOVEMENT_CONFIRM_SECONDS = WAY_CONFIG.MOVEMENT_CONFIRM_SECONDS;
const STOP_CONFIRM_SECONDS = WAY_CONFIG.STOP_CONFIRM_SECONDS;

// ============================================================
//  TYPES
// ============================================================
export type GeoState = "CONFIRMED_INSIDE" | "EXITING" | "OUTSIDE" | "UNKNOWN";
export type MotionMode = "STAYING" | "TRAVELING";

/** Everything the DO needs to persist per device between pings. */
export interface MotionState {
  geoState: GeoState;
  exitStartTime: string | null;       // ISO
  speedBuffer: Array<[string, number]>; // [timestamp, speedKmh], max SPEED_BUFFER_SIZE

  lastLat: number | null;
  lastLon: number | null;
  lastTs: string | null;

  entryStartTime: string | null;
  pendingFenceName: string | null;
  lastGeofenceName: string | null;

  motionMode: MotionMode;
  anchor: [number, number, string] | null; // [lat, lon, isoTs]
  pendingDeparture: Array<[string, number, number]>; // [isoTs, lat, lon]
  candidateStop: [number, number, string] | null;
  pendingStop: Array<[string, number, number]>;

  lastRecordedPoint: [number, number, string] | null; // [lat, lon, isoTs]
  walkingStartTime: string | null;
  // Boundary-crossing point stashed when an exit STARTS (CONFIRMED_INSIDE ->
  // EXITING); emitted only once the exit is CONFIRMED (-> OUTSIDE), so a
  // jitter ping that bounces back inside never starts a track.
  pendingExitEdge: { latitude: number; longitude: number; timestamp: string; isDriving: boolean } | null;
  // Backend-only "leg" tracking: a leg is one continuous movement episode,
  // opened when movement is confirmed or the device leaves a fence, and
  // closed on a stop or a fence arrival. Driving <-> walking never breaks a
  // leg. Stored points carry legId so the dashboard can group a day into
  // legs while still drawing the whole day at once. 0 = no leg yet.
  legId: number;
  legOpen: boolean;
  // Set by an UNWITNESSED fence crossing (see EXIT_WITNESS_GAP_S): the next
  // accepted ping re-anchors the motion engine at ITS OWN position with zero
  // distance, so a jump nobody watched leaves no leg and no distance behind.
  settlePending: boolean;
}

/** A device with no history yet -- mirrors StateMachine.__init__ defaults. */
export function initialMotionState(): MotionState {
  return {
    geoState: "CONFIRMED_INSIDE",
    exitStartTime: null,
    speedBuffer: [],
    lastLat: null,
    lastLon: null,
    lastTs: null,
    entryStartTime: null,
    pendingFenceName: null,
    lastGeofenceName: null,
    motionMode: "STAYING",
    anchor: null,
    pendingDeparture: [],
    candidateStop: null,
    pendingStop: [],
    lastRecordedPoint: null,
    walkingStartTime: null,
    pendingExitEdge: null,
    legId: 0,
    legOpen: false,
    settlePending: false,
  };
}

export interface RawPing {
  deviceId: string;
  timestamp: string; // ISO 8601
  latitude: number;
  longitude: number;
  vel?: number | null; // km/h from the client, if it reports one
}

export interface PingResult {
  isInside: boolean;
  geofenceName: string | null;
  isDriving: boolean;
  speedAvg: number;
  distance: number;
  isStationary: boolean;
  /** Set once, at the moment a device crosses a fence's exit radius, to the
   * boundary-crossing point. Lets the DO start the outgoing track AT the
   * fence edge instead of at the first ping past it. */
  edgePoint?: { latitude: number; longitude: number; timestamp: string; isDriving: boolean } | null;
  /** Set when a device was found outside its fence but nobody watched it
   * leave (see EXIT_WITNESS_GAP_S). The ping is a real measurement of WHERE
   * the device is, not of a crossing: the DO moves the live dot but writes no
   * row, counts no distance, announces nothing, and the fence state resolves
   * by position (UNKNOWN) instead of inventing a departure. */
  unwitnessed?: boolean;
  /** Which backend leg this ping belongs to (see MotionState.legId). */
  legId?: number;
}

/**
 * Manual override for the one genuinely ambiguous call the state machine
 * makes: driving vs. walking, decided in computeDriving() by comparing
 * avgSpeed to WALKING_DRIVING_THRESHOLD. A long highway trip crawling
 * through congestion can dip below that threshold for longer than
 * WALKING_GUARD_SECONDS and get misclassified as walking; a full day of
 * walking can have brief bursts (jogging, a lift for a few minutes) that
 * misclassify the other way. forcedMode short-circuits ONLY that one
 * comparison -- geofence hysteresis, the anchor/stop-detection engine,
 * and entry/exit guards are untouched, so real stops are still detected
 * normally even while forced.
 */
export type ForcedMode = "driving" | "walking" | null;

// ============================================================
//  GLITCH PRE-FILTER
//  Port of the HTTP receiver's 120km/h pre-filter. Call this BEFORE
//  processPing -- a glitch ping should never reach the state machine at
//  all, same as the Python original dropping it before queue_classified_ping.
// ============================================================
export function isGlitch(
  prevLat: number, prevLon: number, prevTs: string,
  curLat: number, curLon: number, curTs: string
): boolean {
  const dtSec = (new Date(curTs).getTime() - new Date(prevTs).getTime()) / 1000;
  // A pair stamped in the same second is judged against the stamp resolution,
  // NOT skipped: two genuine µlogger fixes in one second can be kilometres
  // apart, and skipping them is how such a pair slipped past this gate (see
  // GLITCH_TIME_FLOOR_S).
  const judgedSec = dtSec > 0 ? dtSec : GLITCH_TIME_FLOOR_S;
  const distKm = haversineKm(prevLat, prevLon, curLat, curLon);
  const speedKmh = (distKm / judgedSec) * 3600;
  return speedKmh > PRE_FILTER_SPEED_LIMIT;
}

// ============================================================
//  ACCURACY PRE-FILTER
//  The server-side half of µlogger's own "minimum accuracy" setting. Call
//  this BEFORE processPing: a fix whose own receiver rates it worse than the
//  limit is not a measurement of where the phone is, so it is dropped whole
//  -- silently, like isGlitch above (the upload still answers success).
//  Absence is ACCEPTED: null means the field was not sent, which is not the
//  same as a bad measurement, and every real µlogger ping sets it. The
//  comparison is `<=` because µlogger itself accepts exactly the limit.
// ============================================================
export function accuracyIsAcceptable(accuracy: number | null): boolean {
  if (accuracy === null) return true;
  return accuracy <= PRE_FILTER_MAX_ACCURACY_M;
}

// ============================================================
//  REPORTED-SPEED PRE-FILTER
//  The other half of "is this number real?" -- see
//  reportedSpeedIsCredible. Call it before trusting ping.vel.
// ============================================================

/** The speed the coordinates imply between two pings, in km/h -- the honest
 *  answer to "how fast is this device actually going?". 0 when the gap is too
 *  short to divide by (µlogger can report two fixes in the same second) or when
 *  the movement is inside the 3 m dead zone GPS jitter alone produces. This was
 *  always computed inline in processPing; it lives here so the Durable Object's
 *  intake can give the SAME answer when it replaces a report it cannot
 *  corroborate, instead of inventing a second formula. */
export function speedFromPositions(
  prevLat: number, prevLon: number, prevTs: string,
  curLat: number, curLon: number, curTs: string
): number {
  const dtSec = (new Date(curTs).getTime() - new Date(prevTs).getTime()) / 1000;
  if (!(dtSec > 1.0)) return 0.0;
  const distKm = haversineKm(prevLat, prevLon, curLat, curLon);
  return distKm < 0.003 ? 0.0 : (distKm / dtSec) * 3600.0;
}

/** May this ping's DEVICE-REPORTED speed be believed?
 *
 *  Only when the coordinates corroborate it: the device actually MOVED
 *  REPORTED_SPEED_MIN_MOVE_M since the previous ping. A parked phone indoors
 *  reports 5-30 km/h from its GNSS chip while its fixes stay inside a few
 *  metres, and believing that is what makes a device on a table look like it is
 *  driving -- the point is then persisted as a track dot, its distance lands in
 *  the driven totals, and the approach ETA is computed from it. Note the fixes
 *  are often accurate to a couple of metres, which is exactly why µlogger's own
 *  accuracy filter cannot catch this: that filter judges the FIX, never the
 *  movement.
 *
 *  Under REPORTED_SPEED_MIN_GAP_S the coordinates cannot tell either way (5 m
 *  of jitter in one second IS 18 km/h), so a short gap keeps the report: there
 *  the phone is the better signal, not the positions. */
export function reportedSpeedIsCredible(
  prevLat: number, prevLon: number, prevTs: string,
  curLat: number, curLon: number, curTs: string
): boolean {
  const dtSec = (new Date(curTs).getTime() - new Date(prevTs).getTime()) / 1000;
  if (!(dtSec > 0)) return true;
  if (dtSec < REPORTED_SPEED_MIN_GAP_S) return true;
  return haversineKm(prevLat, prevLon, curLat, curLon) * 1000 >= REPORTED_SPEED_MIN_MOVE_M;
}

// ============================================================
//  MAIN ENTRY POINT
// ============================================================
export function processPing(
  prior: MotionState,
  ping: RawPing,
  geofences: Geofence[],
  forcedMode: ForcedMode = null
): { state: MotionState; result: PingResult } {
  // Shallow-clone the top level + the arrays we mutate, so `prior` is
  // never touched -- caller can safely diff old vs new if it wants to.
  const s: MotionState = {
    ...prior,
    speedBuffer: [...prior.speedBuffer],
    pendingDeparture: [...prior.pendingDeparture],
    pendingStop: [...prior.pendingStop],
    // Defaults for fields missing from device_state rows written by older code.
    pendingExitEdge: prior.pendingExitEdge ?? null,
    legId: prior.legId ?? 0,
    legOpen: prior.legOpen ?? false,
    settlePending: prior.settlePending ?? false,
  };

  const lat = ping.latitude;
  const lon = ping.longitude;
  const dt = ping.timestamp;

  // Previous position, captured BEFORE we overwrite s.lastLat/lastLon below.
  // Needed so an exit transition can compute the true fence-edge crossing
  // point (see processConfirmedInside) rather than anchoring at the raw ping.
  const prevLat = s.lastLat;
  const prevLon = s.lastLon;
  // Previous timestamp, same reason -- the exit witness test (EXIT_WITNESS_GAP_S)
  // needs to know how long the device was silent before this ping.
  const prevTs = s.lastTs;

  // ---- Instantaneous speed: prefer client-reported vel, else derive ----
  // Two things a report cannot survive: claiming more than the pre-filter
  // limit, and claiming movement the coordinates since the last ping do not
  // corroborate (a parked phone's GNSS says 5-30 km/h while its fixes stay
  // inside a few metres). The field travels with the ping independently of the
  // coordinates, so no position check can see it -- this is that half. Either
  // way it falls through to the speed the POSITIONS imply, which is the same
  // number whenever the report was true. The DO applies the same two rules at
  // intake, which is what keeps the RAW field (live HUD, stored row,
  // pending_sync, approach ETA) honest; this is the rule at the library
  // boundary, so no caller can bypass it.
  let impliedSpeedKmh: number;
  if (
    ping.vel !== null && ping.vel !== undefined && ping.vel >= 0 &&
    ping.vel <= PRE_FILTER_SPEED_LIMIT &&
    (s.lastLat === null || s.lastLon === null || s.lastTs === null ||
      reportedSpeedIsCredible(s.lastLat, s.lastLon, s.lastTs, lat, lon, dt))
  ) {
    impliedSpeedKmh = ping.vel as number;
  } else if (s.lastLat !== null && s.lastLon !== null && s.lastTs !== null) {
    impliedSpeedKmh = speedFromPositions(s.lastLat, s.lastLon, s.lastTs, lat, lon, dt);
  } else {
    impliedSpeedKmh = 0.0;
  }
  s.lastLat = lat;
  s.lastLon = lon;
  s.lastTs = dt;

  // ---- Rolling speed average (entry-confirmation gating + classification) ----
  s.speedBuffer.push([dt, impliedSpeedKmh]);
  if (s.speedBuffer.length > SPEED_BUFFER_SIZE) s.speedBuffer.shift();
  const avgSpeed =
    s.speedBuffer.reduce((sum, [, v]) => sum + v, 0) / (s.speedBuffer.length || 1);

  const currentlyInside = s.geoState === "CONFIRMED_INSIDE" || s.geoState === "EXITING";
  const { inside, fenceName } = isInsideGeofence(lat, lon, geofences, currentlyInside);

  const outcome = (s.geoState === "CONFIRMED_INSIDE" || s.geoState === "EXITING")
    ? processConfirmedInside(s, inside, fenceName, lat, lon, dt, avgSpeed, impliedSpeedKmh, forcedMode, prevLat, prevLon, prevTs, geofences)
    : processOutside(s, inside, fenceName, lat, lon, dt, avgSpeed, impliedSpeedKmh, forcedMode);

  // ---- Leg tracking (backend-only) ----
  // A leg OPENS when movement is confirmed (STAYING -> TRAVELING) or the
  // device leaves a fence, and CLOSES when it stops (TRAVELING -> STAYING)
  // or arrives at a fence. Driving <-> walking never breaks a leg, since
  // both are TRAVELING. Every stored point carries the open leg's id.
  const st = outcome.state;
  const arrivedFence = st.geoState === "CONFIRMED_INSIDE";
  const leftFence = prior.geoState === "CONFIRMED_INSIDE" && st.geoState !== "CONFIRMED_INSIDE";
  const wasTraveling = prior.motionMode === "TRAVELING";
  const nowTraveling = st.motionMode === "TRAVELING";
  // Close only on a real stop (the REPORTED stationary flag, which stays
  // false during the exit guard while the device is driving away) or a fence
  // arrival. Using "not traveling" here would end a fence-departure leg
  // immediately, since movement isn't confirmed yet during the guard.
  if (st.legOpen && (arrivedFence || outcome.result.isStationary)) st.legOpen = false;
  if (!st.legOpen && !arrivedFence && ((!wasTraveling && nowTraveling) || leftFence)) {
    st.legId += 1;
    st.legOpen = true;
  }
  outcome.result.legId = st.legId;
  return outcome;
}

// ------------------------------------------------------------------
//  CONFIRMED_INSIDE / EXITING (fence hysteresis + exit guard)
// ------------------------------------------------------------------
function processConfirmedInside(
  s: MotionState,
  inside: boolean,
  fenceName: string | null,
  lat: number, lon: number, dt: string,
  avgSpeed: number, impliedSpeedKmh: number,
  forcedMode: ForcedMode,
  prevLat: number | null,
  prevLon: number | null,
  prevTs: string | null,
  geofences: Geofence[]
): { state: MotionState; result: PingResult } {
  if (inside) {
    const wasExiting = s.geoState === "EXITING";
    s.geoState = "CONFIRMED_INSIDE";
    s.exitStartTime = null;
    s.settlePending = false;
    s.lastGeofenceName = fenceName;
    if (wasExiting) {
      // Bounced back inside the wide radius -- discard whatever the
      // motion engine had started tracking during the false start.
      s.anchor = null;
      s.motionMode = "STAYING";
      s.pendingDeparture = [];
      s.candidateStop = null;
      s.pendingStop = [];
      s.pendingExitEdge = null;
    }
    return {
      state: s,
      result: {
        isInside: true, geofenceName: fenceName, speedAvg: 0.0,
        isDriving: false, distance: 0.0, isStationary: false,
      },
    };
  }

  // Outside the exit radius.
  if (s.geoState === "CONFIRMED_INSIDE") {
    // ---- WITNESS TEST ----------------------------------------------------
    // An exit may only START from a ping that MEASURED the departure. If the
    // device was last heard from longer ago than EXIT_WITNESS_GAP_S, nobody
    // watched it leave: the crossing point below would be interpolated (that
    // is the synthetic row that sat exactly on the exit radius after the
    // 2026-09-19 parked-phone teleport), the guard would then confirm on wall
    // time, and the track would gain a leg nobody earned. Resolve the fence
    // state by POSITION instead, silently: no edge point, no exit event, no
    // leg and no distance across the jump (settlePending re-anchors the next
    // accepted ping at its own position).
    const gapS = prevTs === null
      ? Number.POSITIVE_INFINITY
      : (new Date(dt).getTime() - new Date(prevTs).getTime()) / 1000;
    if (gapS > EXIT_WITNESS_GAP_S) {
      s.geoState = "UNKNOWN";
      s.exitStartTime = null;
      s.pendingExitEdge = null;
      s.lastGeofenceName = null;
      s.settlePending = true;
      return {
        state: s,
        result: {
          // NOT "stationary": that flag draws a stationary dot on the map and
          // fires the parked/moving pushes. This ping is simply unwitnessed --
          // the DO and the dashboard both skip it by that flag alone.
          isInside: false, geofenceName: null, isDriving: false,
          speedAvg: avgSpeed, distance: 0.0, isStationary: false,
          unwitnessed: true,
        },
      };
    }
    s.geoState = "EXITING";
    s.exitStartTime = dt;
    // Anchor the motion engine AT the fence edge (where the segment from
    // the last inside ping to this ping crossed the exit radius), not the
    // first ping outside -- which can be well past the edge at speed. Stash
    // that edge point; it's emitted only once the exit is CONFIRMED below,
    // so a jitter ping that bounces back inside never starts a track.
    const [anchorLat, anchorLon] = exitBoundaryPoint(s, prevLat, prevLon, lat, lon, geofences) ?? [lat, lon];
    resetMotionAnchor(s, anchorLat, anchorLon, dt);
    s.pendingExitEdge = {
      latitude: anchorLat,
      longitude: anchorLon,
      timestamp: dt,
      isDriving: avgSpeed >= WALKING_DRIVING_THRESHOLD,
    };
  }

  const motionResult = processMotion(s, lat, lon, dt, avgSpeed, impliedSpeedKmh, forcedMode);

  const elapsed = (new Date(dt).getTime() - new Date(s.exitStartTime as string).getTime()) / 1000;
  if (elapsed < EXIT_GUARD_SECONDS) {
    // Still guarding: is_inside stays true and geofence_name stays
    // populated (needed for exit-event detection downstream), but
    // is_driving/distance reflect the motion engine live -- no blank
    // window, no retroactive replay needed.
    return {
      state: s,
      result: {
        isInside: true,
        geofenceName: s.lastGeofenceName,
        isDriving: motionResult.result.isDriving,
        speedAvg: motionResult.result.speedAvg,
        distance: motionResult.result.distance,
        isStationary: false, // "at a fence" and "stationary" are kept mutually exclusive
      },
    };
  }

  // Confirmed exit -- emit the stashed boundary-crossing point so the
  // outgoing track starts AT the fence edge (retroactively), not at this
  // ping (which is ~30s past the edge at speed).
  const edgePoint = s.pendingExitEdge;
  s.pendingExitEdge = null;
  s.geoState = "OUTSIDE";
  s.exitStartTime = null;
  s.entryStartTime = null;
  s.pendingFenceName = null;
  return {
    state: s,
    result: { ...motionResult.result, isInside: false, geofenceName: null, edgePoint },
  };
}

// ------------------------------------------------------------------
//  OUTSIDE (entry-pending check + anchor-based movement engine)
// ------------------------------------------------------------------
function processOutside(
  s: MotionState,
  inside: boolean,
  fenceName: string | null,
  lat: number, lon: number, dt: string,
  avgSpeed: number, impliedSpeedKmh: number,
  forcedMode: ForcedMode
): { state: MotionState; result: PingResult } {
  if (inside) {
    s.settlePending = false;
    // NOTE: an instant "keep-alive" entry confirmation used to sit here -- a
    // boolean that was read but NEVER set (so the branch was unreachable and
    // the column it fed was written 0 on every row forever). It was a vestige
    // of the standalone Python tracker, and it is gone rather than kept: a
    // field no code can set is a feature that only looks implemented. The
    // dwell timer below is the one entry rule.
    if (s.entryStartTime === null || s.pendingFenceName !== fenceName) {
      s.entryStartTime = dt;
      s.pendingFenceName = fenceName;
    }

    // Speed gate: passing by at speed restarts the dwell timer.
    if (avgSpeed >= ENTRY_CONFIRM_SPEED_KMH) {
      s.entryStartTime = dt;
    } else {
      const elapsed = (new Date(dt).getTime() - new Date(s.entryStartTime as string).getTime()) / 1000;
      if (elapsed >= ENTRY_GUARD_SECONDS) {
        confirmEntry(s, fenceName);
        return {
          state: s,
          result: {
            isInside: true, geofenceName: fenceName, speedAvg: 0.0,
            isDriving: false, distance: 0.0, isStationary: false,
          },
        };
      }
    }
    // Not confirmed yet -- keep tracking movement normally below, so a
    // drive-by (or slow crawl that never fully stops) still produces a
    // real track instead of a blank guard window.
  } else {
    s.entryStartTime = null;
    s.pendingFenceName = null;
  }

  const motionResult = processMotion(s, lat, lon, dt, avgSpeed, impliedSpeedKmh, forcedMode);
  return {
    state: s,
    result: { ...motionResult.result, isInside: false, geofenceName: null },
  };
}

function confirmEntry(s: MotionState, fenceName: string | null) {
  s.geoState = "CONFIRMED_INSIDE";
  s.lastGeofenceName = fenceName;
  s.entryStartTime = null;
  s.pendingFenceName = null;
}

// ------------------------------------------------------------------
//  ANCHOR-BASED STAY / TRAVEL ENGINE
// ------------------------------------------------------------------
function exitBoundaryPoint(
  s: MotionState,
  prevLat: number | null,
  prevLon: number | null,
  curLat: number,
  curLon: number,
  geofences: Geofence[]
): [number, number] | null {
  if (prevLat === null || prevLon === null || !s.lastGeofenceName) return null;
  const fence = geofences.find((f) => f.name === s.lastGeofenceName);
  if (!fence) return null;
  const entryRadiusM = fence.radiusM ?? WAY_CONFIG.DEFAULT_GEOFENCE_RADIUS_M;
  const exitRadiusM = fence.exitRadiusM ?? entryRadiusM + WAY_CONFIG.EXIT_RADIUS_BUFFER_M;
  return circleCrossingPoint(prevLat, prevLon, curLat, curLon, fence.lat, fence.lon, exitRadiusM);
}

function resetMotionAnchor(s: MotionState, lat: number, lon: number, dt: string) {
  s.motionMode = "STAYING";
  s.anchor = [lat, lon, dt];
  s.pendingDeparture = [];
  s.candidateStop = null;
  s.pendingStop = [];
  s.lastRecordedPoint = null;
  s.walkingStartTime = null;
}

function stayResult(avgSpeed: number): PingResult {
  return {
    isInside: false, geofenceName: null, isDriving: false,
    speedAvg: avgSpeed, distance: 0.0, isStationary: true,
  };
}

function processMotion(
  s: MotionState,
  lat: number, lon: number, dt: string,
  avgSpeed: number, impliedSpeedKmh: number,
  forcedMode: ForcedMode
): { state: MotionState; result: PingResult } {
  // First ping after an unwitnessed crossing: it becomes the new anchor, so
  // the jump nobody watched contributes no leg and no distance. Persisted as a
  // normal moving point (the trail resumes where the device really is).
  if (s.settlePending) {
    s.settlePending = false;
    resetMotionAnchor(s, lat, lon, dt);
    return {
      state: s,
      result: {
        isInside: false, geofenceName: null, isDriving: false,
        speedAvg: avgSpeed, distance: 0.0, isStationary: false,
      },
    };
  }
  if (s.anchor === null) {
    resetMotionAnchor(s, lat, lon, dt);
    return { state: s, result: stayResult(avgSpeed) };
  }

  if (s.motionMode === "STAYING") {
    const distM = distanceM(s.anchor[0], s.anchor[1], lat, lon);

    if (distM <= ANCHOR_RADIUS_M) {
      // Back within the stay radius -- cancel any pending departure. This
      // is what absorbs a single bounce/outlier ping.
      s.pendingDeparture = [];
      return { state: s, result: stayResult(avgSpeed) };
    }

    // Outside the stay radius -- candidate departure. Don't commit until
    // sustained for MOVEMENT_CONFIRM_SECONDS.
    s.pendingDeparture.push([dt, lat, lon]);
    const span =
      (new Date(dt).getTime() - new Date(s.pendingDeparture[0][0]).getTime()) / 1000;

    if (span < MOVEMENT_CONFIRM_SECONDS) {
      return { state: s, result: stayResult(avgSpeed) };
    }

    // Confirmed real movement -- replay the buffered points as a
    // driving/walking leg, starting from the true anchor so the initial
    // displacement isn't lost.
    s.motionMode = "TRAVELING";
    s.lastRecordedPoint = [s.anchor[0], s.anchor[1], s.anchor[2]];
    s.walkingStartTime = null;

    let last: { isDriving: boolean; distance: number } | null = null;
    for (const [, pLat, pLon] of s.pendingDeparture) {
      last = computeDriving(s, avgSpeed, impliedSpeedKmh, pLat, pLon, dt, forcedMode);
    }
    s.pendingDeparture = [];

    return {
      state: s,
      result: {
        isInside: false, geofenceName: null,
        isDriving: last!.isDriving, speedAvg: avgSpeed,
        distance: last!.distance, isStationary: false,
      },
    };
  }

  // motionMode === "TRAVELING"
  const { isDriving, distance } = computeDriving(s, avgSpeed, impliedSpeedKmh, lat, lon, dt, forcedMode);

  // Candidate-stop detection: has the device settled near one spot long
  // enough to conclude the leg has actually ended?
  if (avgSpeed < STATIONARY_SPEED_THRESHOLD) {
    if (s.candidateStop === null) {
      s.candidateStop = [lat, lon, dt];
      s.pendingStop = [[dt, lat, lon]];
    } else {
      const stopDistM = distanceM(s.candidateStop[0], s.candidateStop[1], lat, lon);
      if (stopDistM <= ANCHOR_RADIUS_M) {
        s.pendingStop.push([dt, lat, lon]);
        const stopSpan =
          (new Date(dt).getTime() - new Date(s.pendingStop[0][0]).getTime()) / 1000;
        if (stopSpan >= STOP_CONFIRM_SECONDS) {
          resetMotionAnchor(s, lat, lon, dt);
          return { state: s, result: stayResult(0.0) };
        }
      } else {
        // Drifted away from the candidate stop point -- not actually
        // stopping, restart the candidate here.
        s.candidateStop = [lat, lon, dt];
        s.pendingStop = [[dt, lat, lon]];
      }
    }
  } else {
    s.candidateStop = null;
    s.pendingStop = [];
  }

  return {
    state: s,
    result: {
      isInside: false, geofenceName: null, isDriving,
      speedAvg: avgSpeed, distance, isStationary: false,
    },
  };
}

function computeDriving(
  s: MotionState,
  avgSpeed: number, _impliedSpeedKmh: number,
  lat: number, lon: number, dt: string,
  forcedMode: ForcedMode = null
): { isDriving: boolean; distance: number } {
  // ---- Forced mode: skip the speed comparison entirely ----
  if (forcedMode === "driving") {
    s.walkingStartTime = null;
    let distance = 0.0;
    if (s.lastRecordedPoint) {
      distance = haversineKm(s.lastRecordedPoint[0], s.lastRecordedPoint[1], lat, lon);
    }
    s.lastRecordedPoint = [lat, lon, dt];
    return { isDriving: true, distance };
  }
  if (forcedMode === "walking") {
    // No walking-guard leniency when explicitly forced -- a brief speed
    // burst (jogging, a short lift) shouldn't flip classification when
    // the household has said "today is a walking day."
    // The ANCHOR still moves with the walk, even though the row carries no
    // distance: leaving it at the last driving point makes the next driving
    // segment measure from there, so the whole walked stretch is counted as
    // driven (a walk to the shop and back inflated the drive home by its own
    // length). Walking rows store distance 0 by design -- the page measures a
    // walking leg's geometry instead (computeLegsForDay) -- but that is about
    // the ROW's number, never about where the next measurement starts.
    s.lastRecordedPoint = [lat, lon, dt];
    return { isDriving: false, distance: 0.0 };
  }

  // ---- Normal (unforced) classification ----
  if (avgSpeed >= WALKING_DRIVING_THRESHOLD) {
    s.walkingStartTime = null;
    let distance = 0.0;
    if (s.lastRecordedPoint) {
      distance = haversineKm(s.lastRecordedPoint[0], s.lastRecordedPoint[1], lat, lon);
    }
    s.lastRecordedPoint = [lat, lon, dt];
    return { isDriving: true, distance };
  }

  if (s.walkingStartTime === null) {
    s.walkingStartTime = dt;
  }
  const elapsedWalk = (new Date(dt).getTime() - new Date(s.walkingStartTime).getTime()) / 1000;

  if (elapsedWalk < WALKING_GUARD_SECONDS) {
    // Still traffic/potholes -- keep as driving.
    let distance = 0.0;
    if (s.lastRecordedPoint) {
      distance = haversineKm(s.lastRecordedPoint[0], s.lastRecordedPoint[1], lat, lon);
    }
    s.lastRecordedPoint = [lat, lon, dt];
    return { isDriving: true, distance };
  }

  // True walking. Same anchor rule as the forced branch above, for the same
  // reason: the walked stretch belongs to no driving segment.
  s.lastRecordedPoint = [lat, lon, dt];
  return { isDriving: false, distance: 0.0 };
}
