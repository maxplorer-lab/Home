// ── HomeTripLegs: what counts as a stored point, and what a day adds up to ──
//
// Two facts, and they belong together: a point EXISTS in the history when the
// map would draw it (neither stationary nor inside a fence -- spelled identically
// to shouldPersistTrackPoint in FleetDO.ts, which is the rule the backend stores
// by), and a day's distance is the geometry between those stored points, split by
// classification.
//
// It is a file because the page's own suite had to rebuild it: smoke section 15
// pulled `computeLegsForDay`'s body out of the served HTML and ran it in a
// Function with its dependencies stitched in by hand.
//
// The gap rule is NOT this module's, on purpose: it is the same threshold the
// trail and the cursor break at (HomePlayback.FLUID.GAP_SECONDS), and "a break is
// a break" is one decision in one place. The page passes it in.
//
// The daily totals used to add each ping's stored `distance_km` as it arrived,
// which is a DIFFERENT quantity -- the backend writes it per segment as the
// engine measured it, and until 2026-09-21 a walking stretch left the engine's
// anchor untouched, so the drive after a walk carried the walk's distance with
// it. Measured on that day: the HUD badge read "1.8 km today" while the card for
// the same day read "0.9 Driven km". Anything that reports a distance from these
// rows goes through here.
(function (global) {
  'use strict';

  /**
   *   nameOf(location) -> the display name of a fence ("Home" for "home-1")
   *   gapSeconds       -> the trail's break threshold (HomePlayback's)
   */
  function create(opts) {
    var nameOf = opts.nameOf || function (n) { return n; };
    var gapSeconds = opts.gapSeconds;

    /** What the map draws, which must be what the backend STORED. Spelled
     *  identically to the DO's rule on purpose -- the old form short-circuited on
     *  `is_driving` first, which reads as a different rule even where it happens
     *  to agree, and a rule that has to be reasoned about is one that drifts. */
    function shouldDrawPoint(p) {
      return !p.is_inside_geofence && !p.is_stationary;
    }

    /** Group a day's stored points into legs. "Leg" is a BACKEND concept: every
     *  stored point carries leg_id (assigned by the state machine, bounded by
     *  fence departures/arrivals and start/stop), so this just groups by it --
     *  falling back to a time-gap split for rows written before legs existed. */
    function forDay(pings) {
      var sorted = pings.slice().sort(function (a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
      var legs = [];
      var current = null;
      var lastTs = null;

      for (var i = 0; i < sorted.length; i++) {
        var p = sorted[i];
        if (!shouldDrawPoint(p)) { lastTs = null; continue; }
        var ts = new Date(p.timestamp).getTime();
        var legId = (p.leg_id !== undefined && p.leg_id !== null) ? p.leg_id : null;
        var gapSec = (lastTs === null) ? Infinity : (ts - lastTs) / 1000;
        var legChanged = current !== null &&
          ((legId !== null && current.legId !== null && legId !== current.legId) || gapSec > gapSeconds);

        if (current === null || legChanged) {
          if (current && current.points.length >= 2) legs.push(current);
          current = {
            legId: legId,
            startTime: p.timestamp, endTime: p.timestamp,
            startName: p.is_inside_geofence ? nameOf(p.geofence_name) : 'En route',
            points: [[p.latitude, p.longitude]],
            // distanceKm = the whole path; drivenKm / walkedKm split it by
            // classification. The day's totals use the split, so walking is
            // reported but never counted as driven distance.
            distanceKm: 0, drivenKm: 0, walkedKm: 0, topSpeed: p.speed || 0, isDriving: !!p.is_driving
          };
        } else {
          var last = current.points[current.points.length - 1];
          current.points.push([p.latitude, p.longitude]);
          var segKm = global.HomeGeo.distanceMeters(last[0], last[1], p.latitude, p.longitude) / 1000;
          current.distanceKm += segKm;
          if (p.is_driving) current.drivenKm += segKm;
          else current.walkedKm += segKm;
          current.endTime = p.timestamp;
          if ((p.speed || 0) > current.topSpeed) current.topSpeed = p.speed;
          if (p.is_driving) current.isDriving = true;
          if (current.legId === null && legId !== null) current.legId = legId;
        }
        lastTs = ts;
      }
      if (current && current.points.length >= 2) legs.push(current);
      return legs;
    }

    return { shouldDrawPoint: shouldDrawPoint, forDay: forDay };
  }

  global.HomeTripLegs = { create: create };
})(window);
