// geofence.ts
// Direct port of fleet_tracker.py's haversine() and is_inside_geofence().
// Geofence hysteresis: exit radius is wider than entry radius so a GPS
// bounce near the boundary doesn't flap entry/exit state.
//
// Pure geometry -- no I/O, no clock. Also home to bearingDegrees/angularDiff
// (used by FleetDO's "approach" notification) and circleCrossingPoint (the
// exact boundary crossing, used to start an exit track at the fence edge
// rather than ~100 m away).
//
// Tunable values (radius fallbacks) live in config.ts, not here.
// Behavioural context: docs/ARCHITECTURE.md, "The tracking engine".

import { WAY_CONFIG } from "../config";

export interface Geofence {
  name: string;
  displayName: string;
  category: string | null;
  lat: number;
  lon: number;
  radiusM: number;
  exitRadiusM: number | null; // null -> falls back to radiusM + EXIT_RADIUS_BUFFER_M
}

/** Great-circle distance in kilometres between two lat/lon points. */
export function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371.0;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Same distance, in metres — used by the anchor/motion engine. */
export function distanceM(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000.0;
}

export interface GeofenceCheckResult {
  inside: boolean;
  fenceName: string | null;
}

/**
 * Hysteresis geofence check.
 * - currentlyInside=false (device was OUTSIDE): use the tighter entry
 *   radius to decide if it has newly entered.
 * - currentlyInside=true (device was INSIDE/EXITING): use the wider exit
 *   radius to decide if it has truly left. Stops boundary-jitter bounces
 *   from repeatedly flapping the entry/exit guards.
 */
export function isInsideGeofence(
  lat: number,
  lon: number,
  geofences: Geofence[],
  currentlyInside = false
): GeofenceCheckResult {
  for (const f of geofences) {
    const entryRadiusM = f.radiusM ?? WAY_CONFIG.DEFAULT_GEOFENCE_RADIUS_M;
    const exitRadiusM = f.exitRadiusM ?? entryRadiusM + WAY_CONFIG.EXIT_RADIUS_BUFFER_M;
    const radiusKm = (currentlyInside ? exitRadiusM : entryRadiusM) / 1000.0;
    const dist = haversineKm(lat, lon, f.lat, f.lon);
    if (dist <= radiusKm) {
      return { inside: true, fenceName: f.name };
    }
  }
  return { inside: false, fenceName: null };
}

/**
 * Point where the segment [from -> to] crosses a circle (center, radiusM),
 * i.e. the first crossing going outward. Used to start a post-exit track at
 * the fence edge instead of the first raw ping (which can be well past the
 * edge at speed). Uses a local planar approximation -- accurate enough at
 * household geofence scales (a few hundred metres).
 */
export function circleCrossingPoint(
  fromLat: number, fromLon: number,
  toLat: number, toLon: number,
  centerLat: number, centerLon: number,
  radiusM: number
): [number, number] | null {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((centerLat * Math.PI) / 180);

  const ax = (fromLat - centerLat) * mPerDegLat;
  const ay = (fromLon - centerLon) * mPerDegLon;
  const bx = (toLat - centerLat) * mPerDegLat;
  const by = (toLon - centerLon) * mPerDegLon;

  const dx = bx - ax;
  const dy = by - ay;

  // Solve |a + t*d|^2 = r^2  =>  A t^2 + B t + C = 0
  const A = dx * dx + dy * dy;
  if (A === 0) return null;
  const B = 2 * (ax * dx + ay * dy);
  const C = ax * ax + ay * ay - radiusM * radiusM;

  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-B - sqrtDisc) / (2 * A);
  const t2 = (-B + sqrtDisc) / (2 * A);

  let t: number | null = null;
  for (const candidate of [t1, t2]) {
    if (candidate >= 0 && candidate <= 1) { t = candidate; break; }
  }
  if (t === null) return null;

  return [fromLat + t * (toLat - fromLat), fromLon + t * (toLon - fromLon)];
}

/** Initial bearing (degrees, 0-360, 0 = north) from point 1 to point 2.
 * Used to tell whether a device is actually heading toward a fence. */
export function bearingDegrees(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0-180 degrees. */
export function angularDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
