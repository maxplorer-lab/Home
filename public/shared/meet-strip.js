// ── HomeMeetStrip: the ruler under the map, and what it measures TO ─────────
//
// Two halves, and the split is the point of the file:
//
//   The RULER (module-level below) is arithmetic: a ladder of rungs built from
//   the bands, the rung a distance sits on (with hysteresis), the fill, the
//   colour, the two labels. It reads nothing.
//
//   The SUBJECT half (create()) answers "the far end of the bar": the pinned
//   reference, the nearest person or place, the trend, the bar's own crossing,
//   the picker's rows. It reads the page's live state through accessors, so
//   nothing is copied and nothing goes stale.
//
// What stays in the page is the DOM: the bar's own elements, the picker panel,
// the chip that spells out the direction, and the persistence of a pick.
//
// The bar spans ONE rung of the ladder and its fill is how much of that rung is
// still LEFT, so 500 m apart fills half of a 1 km bar -- and the fill grows as
// the two of them close, the dot riding its head.
//
// The rung's memory is per SUBJECT and belongs to an INSTANCE:
// createScale() returns { scale(dist, subjectKey), index(), reset() }, the same
// shape as createFollowCamera in playback.js. It used to be two page-scope
// `let`s, which is why the test suite had to re-declare them by hand to get a
// ruler that started where a first render would.
//
// A STALE peer still draws. The pill goes silent on an old fix because it is a
// promise about the next few seconds; "he was 3 km away, four minutes ago" is
// still a reading, so the gauge draws it and says the age beside it. The scale
// GROWS at once and shrinks reluctantly (SHRINK_AT): without the second half, a
// distance sitting on a rung boundary rescales the whole bar on every fix -- ±6 m
// of GPS noise crosses 1,000 m repeatedly.
//
// A PICKED reference is the point of the whole thing: the bar stops following
// whoever is nearest and answers about one person or place, so the distance can
// grow as well as shrink while you drive -- and the trend arrow beside the
// reading says which way it is going, which position alone (always near the end
// of the scale) cannot. The bar's own crossing (green name, red tick) is asked
// about ITS two ends, which while something is picked may be a pair the pill is
// not talking about; bar and pill both go through HomeMeet.decision, so they
// cannot disagree about a pair they share.
(function (global) {
  'use strict';

  var CONFIG = {
    // The ladder as BANDS -- [up to this many metres, snap to a multiple of this
    // many] -- because that is how the rule is actually thought about: fine while
    // it matters, coarser as it stops mattering.
    BANDS_M: [
      [1000, 200],        // under 1 km:  200 m steps (200, 400, 600, 800, 1 km)
      [10000, 1000],      // 1-10 km:     1 km steps
      [50000, 5000],      // 10-50 km:    5 km steps
      [100000, 10000],    // 50-100 km:   10 km steps
      [200000, 20000],    // 100-200 km:  20 km steps
      [300000, 50000],    // 200-300 km:  50 km steps
      [1000000, 100000]   // past 300 km: 100 km steps, up to the bar's ceiling
    ],
    // Rescale hysteresis, and it is not decoration: the scale may grow the moment
    // the distance no longer fits, but it only shrinks when it is well inside the
    // next rung down. This is the fraction of the next rung down the distance must
    // be under before the bar zooms back in.
    SHRINK_AT: 0.75,
    // The trend arrow's noise floor, in km/h: a gap changing slower than this is
    // reported as steady rather than as a direction. GPS jitter on two fixes at a
    // 5 s cadence swings the range by a few metres, which is this size.
    TREND_KMH: 3
  };

  /** Every rung of the ladder, bottom-up, from the bands. "Snap to a multiple of
   *  1 km" is why a 1.1 km distance reads on a 2 km bar: a rung is the smallest
   *  one that still CONTAINS the distance. */
  function buildLadder() {
    var out = [];
    var top = 0;
    for (var b = 0; b < CONFIG.BANDS_M.length; b++) {
      var band = CONFIG.BANDS_M[b];
      for (var v = Math.ceil((top + 1) / band[1]) * band[1]; v <= band[0]; v += band[1]) out.push(v);
      top = Math.max(top, band[0]);
    }
    return out;
  }
  var LADDER = buildLadder();

  /** The rung this distance sits on, with hysteresis: up at once, down only once
   *  the distance is comfortably inside the rung below. */
  function createScale() {
    var idx = 0;      // remembered between renders; the ladder walk needs it
    var key = null;   // ...and WHICH subject that rung was chosen for
    return {
      /** A DIFFERENT subject starts fresh. The hysteresis is about ONE distance
       *  wobbling on a boundary; carried across a change of reference it drew a
       *  100 m pick as 1% of a 10 km bar and then walked down one rung per fix. */
      scale: function (dist, subjectKey) {
        if (subjectKey !== key) { key = subjectKey; idx = 0; }
        var i = Math.max(0, Math.min(idx, LADDER.length - 1));
        while (i < LADDER.length - 1 && dist > LADDER[i]) i++;               // grows at once
        while (i > 0 && dist < LADDER[i - 1] * CONFIG.SHRINK_AT) i--;        // shrinks only well inside
        idx = i;
        return LADDER[i];
      },
      /** Which rung that was: the colour is read rung-relative (closeness). */
      index: function () { return idx; },
      reset: function () { idx = 0; key = null; }
    };
  }

  /** The fill: what fraction of the CURRENT SCALE is closed. 0 when the distance
   *  is at the top of the bar's scale -- nothing gained yet -- and 1 when it is
   *  zero. Its complement is how far along the bar the flashed reference sits,
   *  which is why the dot rides the fill's head: the number beside the bar, the
   *  head and the shaded part are then one reading of the same fact ("3.1 km of a
   *  4 km bar" is a quarter full), not three. */
  function fillFraction(dist, scale) {
    return Math.max(0, Math.min(1, 1 - dist / Math.max(1, scale)));
  }

  /** How far INTO ITS RUNG a distance sits: 0 when the distance is as small as
   *  this rung's step allows, 1 when it is at the top of the rung. This one drives
   *  the COLOUR, not the fill: read off the whole scale instead and the colour
   *  barely moves -- hysteresis keeps the distance in the top half of the bar's
   *  scale at every real range, so a scale-wide ramp is amber at 500 m and amber
   *  at 50 km and says nothing. Rung-relative it sweeps green to amber on every
   *  rung instead, and since it is driven by the same distance it still moves WITH
   *  the fill even though the two fractions are not the same number. */
  function closeness(dist, i) {
    var prev = i > 0 ? LADDER[i - 1] : 0;
    return Math.max(0, Math.min(1, (dist - prev) / Math.max(1, LADDER[i] - prev)));
  }

  /** Closeness -> colour, as "r,g,b": green at 0, amber at 1. */
  function tint(t) {
    var green = [46, 204, 113], amber = [245, 196, 81];
    var mix = function (k) { return Math.round(green[k] + (amber[k] - green[k]) * t); };
    return mix(0) + ',' + mix(1) + ',' + mix(2);
  }

  /** The scale as it is written on the bar. */
  function scaleLabel(m) {
    if (m < 1000) return m + ' m';
    return (m % 1000 === 0 ? (m / 1000) : (m / 1000).toFixed(1)) + ' km';
  }

  /** The bar's own reading of a distance, in ONE place: the leaf beside the bar
   *  and the picker's rows must not round the same number two different ways. */
  function distanceLabel(m) {
    if (m === null || m === undefined || !isFinite(m)) return '--';
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  }

  /**
   * The live half. Accessors, not copies:
   *   devices()         -> [deviceId]
   *   latestPing(id)    -> the newest fix for that device, or undefined
   *   pings(id)         -> that device's stored fixes, oldest first
   *   geofences()       -> [{ name, lat, lng }]
   *   stripRef()        -> { kind: 'user'|'fence', id } or null (the user's pick)
   *   sourceMode()      -> 'fence' | anything else (Settings -> Map)
   *   nameOf(location)  -> the display name of a fence
   *   now()             -> milliseconds
   *   meet              -> a HomeMeet instance (the shared verdict)
   */
  function create(opts) {
    var devices = opts.devices;
    var latestPing = opts.latestPing;
    var pings = opts.pings;
    var geofences = opts.geofences;
    var stripRef = opts.stripRef;
    var sourceMode = opts.sourceMode;
    var nameOf = opts.nameOf || function (n) { return n; };
    var now = opts.now || function () { return Date.now(); };
    var meet = opts.meet;

    /** The bar's far end when the user has PICKED one thing to measure to, or
     *  null for Auto. A pick that cannot be resolved right now -- a peer that has
     *  not reported since the reload, a place that left the list -- still comes
     *  back, with dist null, rather than quietly falling through to the nearest:
     *  a bar that silently measured somebody else would make the picker look
     *  broken, and the bar is the only place a pick can be cleared from. */
    function refTarget(deviceId) {
      var ref = stripRef();
      if (!ref) return null;
      var mine = latestPing(deviceId);
      if (!mine) return null;
      var gap = function (lat, lng) { return global.HomeGeo.distanceMeters(mine.latitude, mine.longitude, lat, lng); };
      if (ref.kind === 'fence') {
        var f = geofences().filter(function (g) { return g.name === ref.id; })[0];
        if (!f) return { kind: 'fence', id: ref.id, name: ref.id, dist: null, lat: null, lng: null };
        return { kind: 'fence', id: f.name, name: nameOf(f.name), dist: gap(f.lat, f.lng), lat: f.lat, lng: f.lng };
      }
      var theirs = latestPing(ref.id);
      if (!theirs) return { kind: 'user', id: ref.id, name: ref.id, dist: null, at: null, lat: null, lng: null };
      return {
        kind: 'user', id: ref.id, name: ref.id, at: theirs.timestamp,
        lat: theirs.latitude, lng: theirs.longitude,
        dist: gap(theirs.latitude, theirs.longitude)
      };
    }

    /** The crossing between the bar's OWN two ends, or null. The pill asks the
     *  same verdict about the pair IT is about; this is the bar asking about its
     *  own pair, which is a different one the moment a reference is pinned -- and
     *  a tick borrowed from the pill's pair would mark a bar whose dot is somebody
     *  else. Both start from the same participant test. */
    function crossPair(deviceId, pairId) {
      var mine = meet.participantVelocity(deviceId);
      if (!mine) return null;
      var d = meet.decision(mine, meet.velocity(pings(pairId)));
      return (d && d.verdict === 'meet') ? d : null;
    }

    /** Which way the gap is MOVING: 'closing' while the range shrinks, 'opening'
     *  while it grows, 'flat' when the change is under TREND_KMH, and null when
     *  there is no honest velocity to read. Deliberately the same range rate the
     *  verdict gates on, so a bar saying "closing" cannot be showing a pair the
     *  pill has just refused for not closing. A place has no velocity of its own,
     *  so its rate is my own motion along the line to it -- which is what "getting
     *  closer to Anjohy" means. */
    function trend(deviceId, target) {
      if (!target || target.dist === null || target.lat === null) return null;
      var mine = meet.velocity(pings(deviceId));
      // A rate from five minutes ago is not a rate: the bar may draw a stale
      // DISTANCE and print its age, but not a stale DIRECTION as if it were now.
      if (!mine || now() - new Date(mine.fix.timestamp).getTime() > global.HomeMeet.CONFIG.FRESH_S * 1000) return null;
      var theirs = { x: 0, y: 0 };
      if (target.kind === 'user') {
        theirs = meet.velocity(pings(target.id));
        if (!theirs) return null;
      }
      var rate = global.HomeMeet.rangeRateKmh(mine.fix, { latitude: target.lat, longitude: target.lng }, mine, theirs);
      if (Math.abs(rate) < CONFIG.TREND_KMH) return 'flat';
      return rate > 0 ? 'closing' : 'opening';
    }

    /** The picker's rows, as DATA: Auto first, then every other person, then every
     *  place, nearest first in each group and anything with no fix at the end of
     *  its group. It sorts from the position of the device being WATCHED --
     *  "everything from where you are now" can only mean one of the two -- and it
     *  is pure on purpose, so the DOM half is thin enough to read and this half
     *  can be run. A tie keeps the list order (sort is stable), so the list does
     *  not shuffle under a finger between two fixes. */
    function pickerRows(deviceId) {
      var mine = latestPing(deviceId);
      var from = mine ? function (lat, lng) { return global.HomeGeo.distanceMeters(mine.latitude, mine.longitude, lat, lng); } : null;
      var row = function (kind, id, name, dist, at, active) {
        return { kind: kind, id: id, name: name, dist: dist, at: at || null, active: !!active };
      };
      var ref = stripRef();
      var pinnedUser = ref && ref.kind === 'user' ? ref.id : null;
      var pinnedFence = ref && ref.kind === 'fence' ? ref.id : null;
      var people = [];
      var list = devices();
      for (var i = 0; i < list.length; i++) {
        var id = list[i];
        if (id === deviceId) continue;
        var theirs = latestPing(id);
        people.push(row('user', id, id, (theirs && from) ? from(theirs.latitude, theirs.longitude) : null, theirs ? theirs.timestamp : null, pinnedUser === id));
      }
      var places = [];
      var fences = geofences();
      for (var j = 0; j < fences.length; j++) {
        var f = fences[j];
        places.push(row('fence', f.name, nameOf(f.name), from ? from(f.lat, f.lng) : null, null, pinnedFence === f.name));
      }
      // Nothing to measure to goes last.
      var byNearest = function (a, b) {
        if (a.dist === null && b.dist === null) return 0;
        if (a.dist === null) return 1;
        if (b.dist === null) return -1;
        return a.dist - b.dist;
      };
      people.sort(byNearest);
      places.sort(byNearest);
      var mode = sourceMode();
      var autoList = mode === 'fence' ? places : people;
      return {
        autoLabel: mode === 'fence' ? 'nearest place' : 'nearest person',
        auto: autoList.length ? autoList[0] : null,
        people: people,
        places: places
      };
    }

    /** What the far end of the bar is, in order: the reference the user PICKED
     *  (if any), then the pill's own peer while the pill is up (so the ticking
     *  crossing and the dot agree), then the nearest one on the current source.
     *  Null when there is nothing to measure to. */
    function target(deviceId, preferId) {
      var mine = latestPing(deviceId);
      if (!mine) return null;
      var from = function (lat, lng) { return global.HomeGeo.distanceMeters(mine.latitude, mine.longitude, lat, lng); };

      // 1. The pick wins over everything, including the pill's peer: it is the
      //    thing the user actually chose, and a bar that abandoned it the moment
      //    somebody else converged would answer a question nobody asked.
      var pinned = refTarget(deviceId);
      if (pinned) return pinned;

      // 2. Auto, per the switch: the nearest place...
      if (sourceMode() === 'fence') {
        var best = null;
        var fences = geofences();
        for (var i = 0; i < fences.length; i++) {
          var f = fences[i];
          var dist = from(f.lat, f.lng);
          if (!best || dist < best.dist) best = { kind: 'fence', id: f.name, name: nameOf(f.name), dist: dist, lat: f.lat, lng: f.lng };
        }
        return best;
      }

      var at = function (id) {
        var theirs = latestPing(id);
        if (!theirs) return null;
        return {
          kind: 'user', id: id, name: id, at: theirs.timestamp,
          lat: theirs.latitude, lng: theirs.longitude,
          dist: from(theirs.latitude, theirs.longitude)
        };
      };
      // ...or the pill's own peer while the pill is up, so the tick and the dot agree.
      if (preferId) { var p = at(preferId); if (p) return p; }
      var bestUser = null;
      var list = devices();
      for (var k = 0; k < list.length; k++) {
        if (list[k] === deviceId) continue;
        var cand = at(list[k]);
        if (cand && (!bestUser || cand.dist < bestUser.dist)) bestUser = cand;
      }
      return bestUser;
    }

    return {
      target: target,
      refTarget: refTarget,
      crossPair: crossPair,
      trend: trend,
      pickerRows: pickerRows
    };
  }

  global.HomeMeetStrip = {
    CONFIG: CONFIG,
    ladder: LADDER,
    createScale: createScale,
    create: create,
    fillFraction: fillFraction,
    closeness: closeness,
    tint: tint,
    scaleLabel: scaleLabel,
    distanceLabel: distanceLabel
  };
})(window);
