// ── HomePlayback: the fluid cursor and the follow camera, in ONE place ──────
//
// Both maps load this before their own script: the household's own view
// (`/way/index.html`) and the public live share (`/live/index.html`). The point
// is not code tidiness -- it is that "the share should look exactly like the
// map" cannot be maintained by two copies of an easing curve. Every number that
// decides how a device MOVES on screen lives in FLUID below and nowhere else,
// and both pages call these same functions, so a change here moves both or
// neither.
//
// What is shared: the delayed cursor (when, and where between two fixes the
// marker is), the marker easing, the roaming circle, and the push/pull camera
// cycle. What is NOT shared, because it is page policy rather than motion: the
// household map's pace switch (`live` = zero lag) and its follow-zoom
// preference; the share view is fluid only, at whatever zoom it was opened.
//
// Nothing here reads storage, the network or the DOM. It is arithmetic over a
// list of fixes and a Leaflet map handed in by the caller, which is also what
// makes it testable and impossible to get subtly different.
(function (global) {
  'use strict';

  var FLUID = {
    // How far behind real time the marker is drawn. This one number is the
    // whole difference between fluid and live: a ping is always already in
    // hand by the time the marker has to reach it, so the marker is
    // interpolated between pings instead of snapped to each arrival.
    LAG_SECONDS: 25,
    // A trail break (GAP_SECONDS) is not crawled across -- there are no points
    // there, so the marker holds at the last one and eases the final stretch.
    GLIDE_MS: 1400,
    GAP_SECONDS: 90,
    // Frame-rate independent exponential ease for the marker.
    EASE_PER_SECOND: 2.0,
    // The live tail is redrawn only once the cursor moved this far: rebuilding
    // a polyline every frame buys motion that cannot be seen.
    TAIL_MIN_METERS: 1.5,
    // The circle the device may roam before the camera reacts, as a fraction of
    // the SHORTER side of the map, so the circle always fits inside it (on a
    // portrait phone that is 70% of the width).
    ZONE_DIAMETER_FRACTION: 0.7,
    // PUSH: how long the device keeps travelling past the edge before the pull
    // starts -- the beat that reads as "shoving through".
    PUSH_MS: 380,
    // PULL: expressed as a fraction of the DRIFT it just watched, not a
    // duration: 3 means the pull crosses the same distance in a third of the
    // time, at any device speed.
    PULL_RATIO: 3,
    PULL_MIN_MS: 1500,
    // The pull comes to rest this far short of the opposite extreme; landing
    // exactly ON the circle would re-trigger the pull for ever.
    PULL_LANDING: 0.93,
    // The pull's easing overshoots its aim and settles back onto it
    // (easeOutBack): the difference between a spring and a slide.
    PULL_SPRING: 1.2
  };

  // The speed ramp, low -> high: yellow -> green -> blue -> red. It is here
  // because it is read by BOTH surfaces that colour a number by how fast the
  // device is going -- the household map's speedometer and the share's -- and a
  // palette that agrees today is exactly what two copies cannot promise. The
  // household map's TRAIL colour is drawn from this same list.
  var SPEED_STOPS = [
    { maxKmh: 10, color: '#f1c40f' },
    { maxKmh: 40, color: '#2ecc71' },
    { maxKmh: 70, color: '#38bdf8' },
    { maxKmh: Infinity, color: '#ef4444' }
  ];

  /** The colour for a speed in km/h: the first stop it sits under. */
  function speedColor(kmh) {
    for (var i = 0; i < SPEED_STOPS.length; i++) {
      if (kmh <= SPEED_STOPS[i].maxKmh) return SPEED_STOPS[i].color;
    }
    return SPEED_STOPS[SPEED_STOPS.length - 1].color;
  }

  /** Index of the last point at or before `clock`; -1 when every point is
   * newer. Binary search, because points are re-sorted into the list as late
   * ones arrive, so no index may ever be cached across frames. */
  function cursorIndex(pts, clock) {
    var lo = 0, hi = pts.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (new Date(pts[mid].timestamp).getTime() <= clock) { found = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return found;
  }

  /** Where the marker belongs on the delayed clock, and which pair it is
   * crossing. `clock` is the caller's (the page owns whether there is a lag at
   * all); this clamps it to the newest fix, so the cursor can never pass a
   * point that has not arrived yet. */
  function cursorPosition(pts, clock) {
    if (!pts || !pts.length) return null;
    var newestTs = new Date(pts[pts.length - 1].timestamp).getTime();
    var t = Math.min(clock, newestTs);
    var i = cursorIndex(pts, t);
    var p0 = i >= 0 ? pts[i] : pts[0];
    var next = i >= 0 ? pts[i + 1] : null;
    if (!next) {
      return { lat: p0.latitude, lng: p0.longitude, ping: p0, prev: p0, next: null, alpha: 1, idx: i };
    }
    var t0 = new Date(p0.timestamp).getTime();
    var t1 = new Date(next.timestamp).getTime();
    var span = t1 - t0;
    var alpha;
    if (span > FLUID.GAP_SECONDS * 1000) {
      // There are no points in that gap, so the marker is not dragged across it
      // as if the device had driven there: it holds, then eases the last
      // stretch. A break is a break, but never a jump.
      alpha = Math.max(0, 1 - (t1 - t) / FLUID.GLIDE_MS);
    } else {
      alpha = span > 0 ? (t - t0) / span : 1;
    }
    alpha = Math.max(0, Math.min(1, alpha));
    return {
      lat: p0.latitude + (next.latitude - p0.latitude) * alpha,
      lng: p0.longitude + (next.longitude - p0.longitude) * alpha,
      // The nearer-in-time of the two, so a colour that flips does so where
      // the old jump did.
      ping: alpha < 0.5 ? p0 : next,
      prev: p0, next: next, alpha: alpha, idx: i
    };
  }

  /** Frame-rate independent exponential ease: a slow phone lands in the same
   * place at the same time as a fast one. */
  function easeFactor(ratePerSecond, dtSec) {
    return 1 - Math.exp(-ratePerSecond * dtSec);
  }

  /** The radius of the circle the device may roam before the camera reacts. */
  function followZoneRadius(size, fraction) {
    return (Math.min(size.x, size.y) * fraction) / 2;
  }

  /** One pull's easing (easeOutBack): it leaves slowly -- the device has just
   * been shoving at the edge -- then closes most of the gap, crosses its aim by
   * a few percent and settles back onto it. */
  function pullEase(t, spring) {
    var s = spring;
    var c = s + 1;
    return 1 + c * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
  }

  /** Where a pull aims and how long it takes. The aim is the point OPPOSITE the
   * crossing on the circle, a hair inside it -- deliberately not the exit
   * offset mirrored, since a device that was TELEPORTED far outside the circle
   * (a fresh follow, a reconnect, a pace switch) would land outside it again
   * and the pull would then repeat for ever. `pt` is Leaflet's point factory. */
  function planPull(pt, gap, radius, driftMs) {
    var out = Math.max(gap.distanceTo(pt(0, 0)), 1);
    var aim = gap.multiplyBy(-(radius * FLUID.PULL_LANDING) / out);
    var jumped = out > radius * 2;
    var durationMs = jumped
      ? FLUID.PULL_MIN_MS
      : Math.max(driftMs / FLUID.PULL_RATIO, FLUID.PULL_MIN_MS);
    return { aim: aim, durationMs: durationMs, jumped: jumped };
  }

  /**
   * The camera, as a cycle rather than a chase. It never TRAILS the device:
   *
   *   DRIFT  the map is still. The device walks away from the middle of the
   *          screen until it leaves the roaming circle.
   *   PUSH   it keeps going for PUSH_MS while the map still holds, so the edge
   *          registers as something it shoves through.
   *   PULL   the camera carries it from the edge it crossed to the OPPOSITE
   *          edge, easing with an overshoot while the point it aims at travels
   *          with the device, so whatever the device does mid-carry is still
   *          drawn.
   *
   * Every per-frame correction is a pixel `panBy` -- how Leaflet's own animated
   * pan works internally. Deliberately not `panTo` (that picks a landing point
   * and stops moving with the device) and not `setView` (that fires `viewreset`
   * and re-projects every layer, 60x/s).
   */
  function createFollowCamera(opts) {
    var L = opts.L;
    var getMap = opts.getMap;
    // Named `pullGap`/`pullAim` rather than `gap`/`aim` on purpose: the sweep
    // below reads them into locals of those shorter names, and a state variable
    // shadowed by a local of the same name is a bug that hides until the pull
    // starts from nothing.
    var driftFrom = 0, phase = 'drift', pushUntil = 0, pullFrom = 0, pullTo = 0;
    var pullGap = null, pullAim = null, heldUntil = 0;

    return {
      phaseOf: function () { return phase; },

      /** The page placed the device itself (a fresh follow, a zoom fix): the
       * next drift is timed from here, so the first pull is never a jump. */
      notifyPlaced: function (nowMs) {
        phase = 'drift';
        pullGap = null;
        pullAim = null;
        driftFrom = nowMs;
      },

      /** Hold the machine still while the PAGE animates the view (a flyTo). */
      holdUntil: function (ms) { heldUntil = ms; },
      isHeld: function (nowMs) { return nowMs < heldUntil; },

      /** @param target {lat,lng} the device's drawn position this frame. */
      update: function (nowMs, target) {
        var map = getMap();
        if (!map || !target) return;
        if (nowMs < heldUntil) return;

        // Everything is measured in screen pixels: how far the eye tolerates
        // the device drifting depends on the screen, not on the ground.
        var size = map.getSize();
        var radius = followZoneRadius(size, FLUID.ZONE_DIAMETER_FRACTION);
        var center = size.divideBy(2);
        var at = map.latLngToContainerPoint([target.lat, target.lng]);

        if (phase === 'push') {
          if (nowMs < pushUntil) return;
          phase = 'pull';
          pullFrom = nowMs;
          pullGap = at.subtract(center);
          var plan = planPull(L.point, pullGap, radius, nowMs - (driftFrom || nowMs));
          pullAim = plan.aim;
          pullTo = nowMs + plan.durationMs;
        }

        if (phase === 'drift') {
          if (at.distanceTo(center) <= radius) return;
          phase = 'push';
          pushUntil = nowMs + FLUID.PUSH_MS;
          return;
        }

        // The device's screen position sweeps from the edge it crossed to the
        // aim, one spring-eased step at a time: gap + (aim - gap) * ease(t).
        var t = Math.min((nowMs - pullFrom) / Math.max(pullTo - pullFrom, 1), 1);
        var gap = pullGap || L.point(0, 0);
        var aim = pullAim || L.point(0, 0);
        var want = center.add(gap.add(aim.subtract(gap).multiplyBy(pullEase(t, FLUID.PULL_SPRING))));
        var delta = at.subtract(want);
        if (delta.x || delta.y) map.panBy(delta, { animate: false, noMoveStart: true });
        if (t >= 1) {
          phase = 'drift';
          pullGap = null;
          pullAim = null;
          driftFrom = nowMs;
        }
      }
    };
  }

  global.HomePlayback = {
    FLUID: FLUID,
    SPEED_STOPS: SPEED_STOPS,
    speedColor: speedColor,
    cursorIndex: cursorIndex,
    cursorPosition: cursorPosition,
    easeFactor: easeFactor,
    followZoneRadius: followZoneRadius,
    pullEase: pullEase,
    planPull: planPull,
    createFollowCamera: createFollowCamera
  };
})(window);
