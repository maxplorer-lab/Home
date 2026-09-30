// ── HomeGeo: the geometry BOTH maps measure with ────────────────────────────
//
// The distance between two fixes, the bearing from one to the other, and that
// bearing as a compass point. It is here, and not in either page, because both
// pages were carrying their own copy: /way/index.html had `distanceMeters` and
// the public share had `distanceM` -- the same law written twice (one in the
// atan2 form, one in the asin form), which is exactly the shape the motion
// engine had before /shared/playback.js. A share that measures differently from
// the map is a second opinion about the same road.
//
// Nothing here reads the DOM, storage, the network or the clock. It is
// arithmetic over coordinates, which is what makes it runnable in a test.
//
// The household Worker's own copy (src/way/lib/geofence.ts, which the Fleet DO
// stores points with) is deliberately NOT this file: it is TypeScript bundled
// into the worker, and it answers the same question on the other side of the
// wire. The two are required to agree -- they decide whether the same point is
// stored and drawn -- and the day they need to be one function, the worker can
// import this file rather than re-implement it.
(function (global) {
  'use strict';

  /** Metres between two coordinates. R = 6,371,000 m. */
  function distanceMeters(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** True bearing (0 = north, clockwise) from one coordinate to another. */
  function bearingDegrees(lat1, lon1, lat2, lon2) {
    var toRad = function (d) { return d * Math.PI / 180; }, toDeg = function (r) { return r * 180 / Math.PI; };
    var y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    var x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /** Compass bearing (0 = north, clockwise) of a local-frame velocity vector. */
  function bearingOfVector(x, y) {
    return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
  }

  /** A bearing (0 = north, clockwise) as one of the eight compass points. The words
   *  are for the chip on the bar: an arrow is a shape, "NE" is somewhere to aim,
   *  and the two together cannot be misread as anything else. */
  var COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

  function compassPoint(brgDeg) {
    var i = Math.round(((brgDeg % 360) + 360) % 360 / 45) % 8;
    return COMPASS_POINTS[i];
  }

  /** The angle between two bearings, always 0..180: "pointed at" is a question
   *  about the smaller of the two ways round. */
  function angularDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  global.HomeGeo = {
    distanceMeters: distanceMeters,
    bearingDegrees: bearingDegrees,
    bearingOfVector: bearingOfVector,
    COMPASS_POINTS: COMPASS_POINTS,
    compassPoint: compassPoint,
    angularDiff: angularDiff
  };
})(window);
