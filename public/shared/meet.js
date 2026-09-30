// ── HomeMeet: are these two about to cross? ONE verdict, asked twice ────────
//
// The meeting pill and the distance bar both ask this and nothing else, so the
// two can never disagree about the same pair -- which is the whole reason it is
// one module rather than two copies of the gates. The bar's crossing tick
// (meetStripCrossPair) and the pill's countdown (meetEtaFor) start from the same
// participant test and run the same decision, so a bar that says "closing"
// cannot be showing a pair the pill has just called off.
//
// It is a file because it used to be page code that the page's own test suite
// had to REBUILD: smoke section 15 stitched `meetDecision` out of the served
// page with a hand-written list of what it referenced. The interface here is the
// test surface -- create() takes the page's live reads and the clock.
//
// The numbers are the module's, the way FLUID's are HomePlayback's: every one of
// them was chosen against the one-off lab in
// scripts/one-off/2026-09-24-meet-eta-lab, whose README says which gate each one
// buys. They are not estimates of the same thing, and they are not page policy.
(function (global) {
  'use strict';

  var CONFIG = {
    // The gates, each one a defect the lab measured rather than a precaution.
    SETTLED_M: 1200,        // under this separation the extrapolation is worth reading
    DCPA_MAX_M: 250,        // a crossing that passes 250 m wide is not a meeting
    CLOSING_MIN_KMH: 3,     // the range has to actually be shrinking
    FRESH_S: 180,           // a fix older than this is not a position, it is a memory
    MAX_GAP_S: 600,         // two fixes this far apart are a gap, not a velocity
    TELEPORT_KMH: 250,      // an implied speed above this is a bad fix, not motion
    MAX_MIN: 15,            // the horizon the countdown is allowed to name
    MIN_SPEED_KMH: 15,      // under this a device is not "driving" for the maths
    MAX_BEARING_DIFF_DEG: 55, // "pointed at" tolerance, either direction
    TOGETHER_DISTANCE_M: 150  // inside this the together radius owns the moment
  };

  /**
   * The page's live reads, as accessors (the createFollowCamera idiom in
   * playback.js): nothing is copied, so nothing can be stale.
   *   devices()      -> [deviceId]
   *   latestPing(id) -> the newest fix for that device, or undefined
   *   pings(id)      -> that device's stored fixes, oldest first
   *   now()          -> milliseconds; injected so the freshness gate is testable
   */
  function create(opts) {
    var devices = opts.devices;
    var latestPing = opts.latestPing;
    var pings = opts.pings;
    var now = opts.now || function () { return Date.now(); };

    /** A device's velocity from its own last two fixes: direction of travel and
     *  km/h, or null when the pair is a gap, or a jump no vehicle could have
     *  made. Reported speed is never used -- the ping carries a speed column and
     *  it is wrong often enough that believing it here would be believing one bad
     *  number twice. */
    function velocity(pts) {
      if (!pts || pts.length < 2) return null;
      var prev = pts[pts.length - 2], cur = pts[pts.length - 1];
      var dt = (new Date(cur.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000;
      if (!(dt > 0) || dt > CONFIG.MAX_GAP_S) return null; // a gap is not a velocity
      var ky = 110540, kx = 111320 * Math.cos(cur.latitude * Math.PI / 180);
      var x = (cur.longitude - prev.longitude) * kx / dt;
      var y = (cur.latitude - prev.latitude) * ky / dt;
      var kmh = Math.sqrt(x * x + y * y) * 3.6;
      if (kmh > CONFIG.TELEPORT_KMH) return null; // a bad fix is not motion
      return { x: x, y: y, kmh: kmh, fix: cur };
    }

    /** A device's own velocity for the meeting maths, or null when it is not a
     *  participant at all: not driving by the map's own record (is_driving, the
     *  state machine's answer), or no velocity that can be derived from its
     *  fixes. */
    function participantVelocity(deviceId) {
      var p = latestPing(deviceId);
      if (!p || !p.is_driving) return null;
      var v = velocity(pings(deviceId));
      return (v && v.kmh >= CONFIG.MIN_SPEED_KMH) ? v : null;
    }

    /** THE verdict. Returns the numbers either way (a silent pair still has a
     *  range and a closing rate), with `verdict` null when the pair is not one to
     *  show. */
    function decision(mine, theirs) {
      if (!mine || !theirs) return null;
      var t = now();
      // The badge's staleness rule: a five minute old fix is a memory of where
      // somebody was, and a promise about the next few seconds is not built on one.
      var fresh = function (v) { return t - new Date(v.fix.timestamp).getTime() <= CONFIG.FRESH_S * 1000; };
      if (!fresh(mine) || !fresh(theirs)) return null;
      // HOME, not merely "inside a fence": a peer parked in a fence is not about
      // to meet anybody, while a peer driving through one is.
      if (theirs.fix.is_inside_geofence && theirs.kmh < CONFIG.MIN_SPEED_KMH) return null;

      var kx = 111320 * Math.cos(mine.fix.latitude * Math.PI / 180), ky = 110540;
      var r = {
        x: (theirs.fix.longitude - mine.fix.longitude) * kx,
        y: (theirs.fix.latitude - mine.fix.latitude) * ky
      };
      var range = Math.sqrt(r.x * r.x + r.y * r.y);
      // Inside the together radius the peer pill owns the moment; the two pills
      // saying the same thing to the same pair is what this prevents.
      if (range <= CONFIG.TOGETHER_DISTANCE_M) {
        return { verdict: 'together', range: range, closing: 0, tcaS: 0, dcpa: range };
      }

      var v = { x: theirs.x - mine.x, y: theirs.y - mine.y };
      var vv = v.x * v.x + v.y * v.y;
      var rv = r.x * v.x + r.y * v.y;
      var tcaS = vv > 0.01 ? Math.max(0, -rv / vv) : 0;
      var closing = rangeRateKmh(mine.fix, theirs.fix, mine, theirs); // km/h, positive while they close
      // Closest point of approach: how near they WILL get, not how near they are.
      // That one number is what separates a meeting from two people on parallel
      // roads 473 m apart, both pointed straight at each other.
      var dcpa = Math.sqrt(Math.pow(r.x + v.x * tcaS, 2) + Math.pow(r.y + v.y * tcaS, 2));
      var out = { verdict: null, range: range, closing: closing, tcaS: tcaS, dcpa: dcpa };

      if (range > CONFIG.SETTLED_M) return out;
      if (tcaS > CONFIG.MAX_MIN * 60) return out;
      if (closing < CONFIG.CLOSING_MIN_KMH) return out;
      if (dcpa > CONFIG.DCPA_MAX_M) return out;
      // Every side that is MOVING has to be pointed at the other. Not a formality
      // in either direction: without it an overtake closes at 15 km/h with only one
      // of them pointed at the other, and with it alone a parallel-road pair passes.
      var myToThem = global.HomeGeo.bearingDegrees(
        mine.fix.latitude, mine.fix.longitude, theirs.fix.latitude, theirs.fix.longitude);
      if (global.HomeGeo.angularDiff(global.HomeGeo.bearingOfVector(mine.x, mine.y), myToThem) > CONFIG.MAX_BEARING_DIFF_DEG) return out;
      if (theirs.kmh >= CONFIG.MIN_SPEED_KMH &&
          global.HomeGeo.angularDiff(global.HomeGeo.bearingOfVector(theirs.x, theirs.y), (myToThem + 180) % 360) > CONFIG.MAX_BEARING_DIFF_DEG) return out;
      out.verdict = 'meet';
      return out;
    }

    /** The best meeting the SELECTED device is heading into, or null. Only that
     *  device is ever the subject: the pill says what is about to happen to the
     *  person you are watching. Of the pairs that pass, it reports the soonest
     *  crossing -- an upcoming one is what a countdown is for. */
    function etaFor(deviceId) {
      var mine = participantVelocity(deviceId);
      if (!mine) return null;
      var best = null;

      var list = devices();
      for (var i = 0; i < list.length; i++) {
        var otherId = list[i];
        if (otherId === deviceId) continue;
        var d = decision(mine, velocity(pings(otherId)));
        if (d && d.verdict === 'meet' && (!best || d.tcaS < best.tcaS)) {
          best = { peerId: otherId, tcaS: d.tcaS, dcpa: d.dcpa, range: d.range, closing: d.closing };
        }
      }
      return best;
    }

    return {
      velocity: velocity,
      participantVelocity: participantVelocity,
      decision: decision,
      etaFor: etaFor
    };
  }

  /** The rate the range between two fixes is changing, in km/h, POSITIVE while it
   *  shrinks. ONE formula for the whole feature: the verdict gates on it ("not
   *  closing is not a meeting") and the bar's trend arrow is the same number
   *  pointed at. `vb` is {x:0,y:0} for anything with no velocity of its own (a
   *  fence), which is how "am I getting closer to this place" is asked. */
  function rangeRateKmh(aFix, bFix, va, vb) {
    var kx = 111320 * Math.cos(aFix.latitude * Math.PI / 180), ky = 110540;
    var rx = (bFix.longitude - aFix.longitude) * kx, ry = (bFix.latitude - aFix.latitude) * ky;
    var range = Math.sqrt(rx * rx + ry * ry);
    if (range < 0.5) return 0;
    return -(((rx * (vb.x - va.x)) + (ry * (vb.y - va.y))) / range) * 3.6;
  }

  global.HomeMeet = {
    CONFIG: CONFIG,
    create: create,
    rangeRateKmh: rangeRateKmh
  };
})(window);
