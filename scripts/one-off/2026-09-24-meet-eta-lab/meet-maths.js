// ─── The meeting-ETA maths, in ONE place ────────────────────────────────
//
// A plain <script> global, like tracks.js, so it loads under both views of the
// same dataset without a bundler:
//
//   meet-lab.html   the schematic: tables, gate ablation, raw steps
//   meet-map.html   the same maths on real map tiles, with the pill
//
// It exists as a file for the same reason /shared/basemaps.js does: two copies
// of a rule drift, and the moment they disagree the map demo stops being
// evidence about the app. The schematic lab was verified first; the map demo is
// required to produce the same numbers for the same pair and time.
//
// WHAT IS HERE. Geometry, the CPA/TCA pair evaluation, the gate set and the
// pill's phrasing. What is NOT here: the DOM, the thresholds' defaults as shown
// in the inputs, the tables, the plots. Callers own their view.
//
// Every velocity is derived from a device's OWN last two fixes rather than from
// the speed column it reports, so "how fast it is going" and "which way it is
// pointed" can never contradict each other.
window.MeetMaths = (function () {
  "use strict";

  // ── geometry ──────────────────────────────────────────────────────────────
  const M_PER_DEG_LAT = 110540;
  const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
  const DEG = 180 / Math.PI;

  /** Local flat-earth frame about an origin. Linear in lat/lon, so one origin is
   *  consistent for positions AND velocities -- and over a few kilometres the
   *  distortion is far below the GPS noise this lab is about. */
  function projector(lat0, lon0) {
    const kx = mPerDegLon(lat0), ky = M_PER_DEG_LAT;
    return (lat, lon) => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky });
  }
  const len = (v) => Math.hypot(v.x, v.y);
  /** Compass bearing (0 = north, clockwise), same convention as the app's. */
  const bearing = (v) => ((Math.atan2(v.x, v.y) * DEG) + 360) % 360;
  /** Smallest angle between two bearings, 0..180. */
  function angleDiff(a, b) {
    const d = Math.abs(((((a - b) % 360) + 360) % 360));
    return d > 180 ? 360 - d : d;
  }

  /** Shown to the reader as the starting point of every input box, and the
   *  fallback when one is blank. Every key here is also an input id (`t.<key>`)
   *  in both pages, which is what lets `thresholds()` below stay honest. */
  const DEFAULTS = { tcaMaxMin: 15, dcpaMax: 250, closingMin: 3, maxDeg: 55, together: 150,
                     freshS: 180, settledM: 1200, relMin: 10, movingKmh: 15, teleport: 250,
                     // Not a number, so it is read from a <select> instead of a
                     // box -- see readThresholds below.
                     fenceMode: "strict" };

  /** The input boxes' units to the units the evaluation wants (minutes to
   *  seconds, seconds to milliseconds), in ONE place. A page that displayed one
   *  set of thresholds while judging with another would make every number on it
   *  a lie, and that is exactly the kind of drift two views invite. */
  function thresholds(d) {
    return { tcaMaxS: d.tcaMaxMin * 60, dcpaMax: d.dcpaMax, closingMin: d.closingMin, maxDeg: d.maxDeg,
             together: d.together, freshMs: d.freshS * 1000, settledM: d.settledM, relMin: d.relMin,
             movingKmh: d.movingKmh, teleport: d.teleport,
             fenceMode: d.fenceMode === "stationary" ? "stationary" : "strict" };
  }

  /** Reads the threshold controls (`<prefix><key>` for every key of DEFAULTS)
   *  out of a page and maps them. Both views have the same controls, so the
   *  reading belongs here with the mapping: a page that read them differently
   *  would be judging with numbers nobody could see. */
  function readThresholds(prefix, doc) {
    const D = doc || (typeof document !== "undefined" ? document : null);
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      const el = D && D.getElementById(prefix + k);
      if (!el) out[k] = DEFAULTS[k];
      else if (el.tagName === "SELECT") out[k] = el.value;
      else out[k] = Number(el.value) || DEFAULTS[k];
    }
    return thresholds(out);
  }

  // ── one pair, every step ──────────────────────────────────────────────────
  //
  // Walk the merged clock. At each moment both devices must have a fix at or
  // before it. A device whose two fixes imply an impossible speed is a
  // teleport: the step is recorded but left unjudged, because any estimate
  // built on it would be nonsense.
  function evaluatePair(a, b, C) {
    const steps = [];
    const times = [...new Set([...a.pings.map((p) => p.t), ...b.pings.map((p) => p.t)])].sort((x, y) => x - y);
    let ia = -1, ib = -1;
    let prev = null;

    const fixAt = (pings, i) => (i >= 0 && i < pings.length ? pings[i] : null);
    const vel = (pings, i) => {
      const cur = fixAt(pings, i), pri = fixAt(pings, i - 1);
      if (!cur || !pri) return { why: "no previous fix" };
      const dt = (cur.t - pri.t) / 1000;
      if (dt <= 0) return { why: "same timestamp twice" };
      if (dt > 600) return { why: `previous fix ${Math.round(dt)}s earlier` }; // a gap is not a velocity
      const P = projector(cur.lat, cur.lon);
      const pc = P(cur.lat, cur.lon), pp = P(pri.lat, pri.lon);
      let v = { x: (pc.x - pp.x) / dt, y: (pc.y - pp.y) / dt };
      let source = "fixes";
      if (dt < 1) {
        // Two fixes under a second apart give a bearing but not a speed; fall
        // back to the device's own report along that bearing, exactly the way
        // the live HUD has to.
        const kmh = cur.kmh ?? 0;
        const brg = bearing(v);
        v = { x: Math.sin(brg / DEG) * kmh / 3.6, y: Math.cos(brg / DEG) * kmh / 3.6 };
        source = "reported speed";
      }
      const kmh = len(v) * 3.6;
      if (source === "fixes" && kmh > C.teleport) return { why: `teleport (${Math.round(kmh)} km/h implied)` };
      return { v, kmh, heading: bearing(v), source };
    };

    for (const T of times) {
      while (ia + 1 < a.pings.length && a.pings[ia + 1].t <= T) ia++;
      while (ib + 1 < b.pings.length && b.pings[ib + 1].t <= T) ib++;
      const fa = fixAt(a.pings, ia), fb = fixAt(b.pings, ib);
      if (!fa || !fb) continue;

      const P = projector(fa.lat, fa.lon);
      const pA = P(fa.lat, fa.lon);
      const pB = P(fb.lat, fb.lon);
      const r = { x: pB.x - pA.x, y: pB.y - pA.y };
      const range = len(r);

      const va = vel(a.pings, ia), vb = vel(b.pings, ib);
      const freshA = T - fa.t <= C.freshMs, freshB = T - fb.t <= C.freshMs;
      const outsideA = !fa.inside, outsideB = !fb.inside;

      const s = {
        t: T, pair: `${a.id} x ${b.id}`, range, freshA, freshB, outsideA, outsideB,
        fenceA: fa.fence, fenceB: fb.fence,
        kmhA: fa.kmh, kmhB: fb.kmh,
        speedA: va.v ? va.kmh : null, speedB: vb.v ? vb.kmh : null,
        sourceA: va.source ?? va.why, sourceB: vb.source ?? vb.why,
        headingA: va.v ? va.heading : null, headingB: vb.v ? vb.heading : null,
        tcaS: null, dcpa: null, closing: null, closingMeasured: null,
        headingOkA: null, headingOkB: null, headingGate: null,
        verdict: "silent", failed: [],
      };

      if (va.v && vb.v) {
        const v = { x: vb.v.x - va.v.x, y: vb.v.y - va.v.y };
        const vv = v.x * v.x + v.y * v.y;
        const rv = r.x * v.x + r.y * v.y;
        const tStar = vv > 0.01 ? -rv / vv : 0;
        s.tcaS = Math.max(0, tStar);
        const cp = { x: r.x + v.x * s.tcaS, y: r.y + v.y * s.tcaS };
        s.dcpa = len(cp);
        s.closing = range > 0 ? -(rv / range) * 3.6 : 0; // km/h, positive while closing
        // How fast the GAP is changing in any direction, as opposed to how fast
        // it is shrinking. Two phones in the same convoy differ by a couple of
        // km/h of noise, and that is enough to extrapolate a "miss" of a few
        // metres at a horizon of ten minutes: the miss number needs a real
        // relative velocity behind it to mean anything.
        s.relKmh = len(v) * 3.6;
        if (prev) {
          const dt = (T - prev.t) / 1000;
          if (dt > 0) s.closingMeasured = ((prev.range - range) / dt) * 3.6;
        }
      const brgAtoB = bearing(r);
      const brgBtoA = (brgAtoB + 180) % 360;
      const movingA = s.speedA >= C.movingKmh, movingB = s.speedB >= C.movingKmh;
      // ── the fence rule, in two readings ──
      //
      // STRICT: neither peer may be inside any fence. This is what the concept
      // memo first said, and it has a measurable defect: every driver is inside
      // their own home fence for the first minute of a trip, so it silences the
      // pill at the start of the drive -- exactly when the ETA first becomes
      // useful. Measured on the demo: a 15 s hole in the middle of a true meet.
      //
      // STATIONARY: a peer inside a fence counts as being HOME only if it is
      // also not moving. A driver leaving the house is not parked at it, and the
      // case the gate EXISTS for -- a moved peer converging on someone sitting
      // in a fence -- is untouched, because that peer is not moving either.
      const parkedInFenceA = !outsideA && !movingA, parkedInFenceB = !outsideB && !movingB;
      s.parkedInFenceA = parkedInFenceA; s.parkedInFenceB = parkedInFenceB;
      s.fenceMode = C.fenceMode;
      const outsideGate = C.fenceMode === "stationary"
        ? !(parkedInFenceA || parkedInFenceB)
        : (outsideA && outsideB);
      s.headingOkA = !movingA ? null : angleDiff(s.headingA, brgAtoB) <= C.maxDeg;
        s.headingOkB = !movingB ? null : angleDiff(s.headingB, brgBtoA) <= C.maxDeg;
        s.movingA = movingA; s.movingB = movingB;
        s.headingGate = (movingA || movingB)
          && (s.headingOkA !== false) && (s.headingOkB !== false);
        // A meet also has to be ahead of them: past the closest approach the
        // range opens again, which `closing` catches.
        s.checks = {
        outside: outsideGate,
        fresh: freshA && freshB,
          // The one gate that is not about the pair but about the ESTIMATE: at
          // two kilometres out, a few metres of position noise swings the
          // extrapolated miss distance by hundreds of metres, so a "they will
          // pass 30 m apart" at that range is an artefact. Both demo meets fire
          // while still ~2 km apart without this gate, which is how the defect
          // was found.
          settled: range <= C.settledM,
          relative: s.relKmh >= C.relMin,
          closing: s.closing >= C.closingMin,
          dcpa: s.dcpa <= C.dcpaMax,
          heading: s.headingGate,
          speed: movingA || movingB,
          notTogether: range > C.together,
        };
        if (range <= C.together) s.verdict = "together";
        else if (s.closing >= C.closingMin && s.dcpa <= C.dcpaMax && s.tcaS <= C.tcaMaxS) s.verdict = "passing";
        // Only a judged step becomes the baseline for the MEASURED closing rate:
        // differencing across an unjudged row would read its teleport as motion.
        prev = { t: T, range };
      } else {
        s.checks = null;
        s.unusable = `${va.why ?? ""} / ${vb.why ?? ""}`.replace(/^ \/ | \/ $/g, "");
      }
      steps.push(s);
    }
    return steps;
  }

  /** Apply the gate set to a row that was judged with the same thresholds. */
  function decide(s, gates) {
    if (!s.checks) return "silent";
    if (s.verdict === "together") return "together";
    const failed = Object.keys(s.checks).filter((k) => gates[k] && !s.checks[k]);
    return failed.length === 0 ? "meet" : "silent";
  }

  /** What the pill would say. Needs `s.subject` (the row's owning device) and
   *  the thresholds it was judged with. HTML entities: callers innerHTML it. */
  function pill(s, C) {
    const peer = s.pair.split(" x ").find((n) => n !== s.subject);
    if (s.verdict === "together") return `with ${peer} now`;
    if (s.tcaS === null) return "&mdash;";
    if (s.tcaS <= 60) return `${peer} in &lt;1 min`;
    if (s.tcaS <= C.tcaMaxS) return `${peer} in ~${Math.round(s.tcaS / 60)} min`;
    return `${peer} &mdash; ${(s.range / 1000).toFixed(1)} km, closing`;
  }

  /** Contiguous runs of MEET, joined when the gap is under 10 minutes. */
  function events(rows, gates) {
    const out = [];
    let cur = null;
    for (const s of rows) {
      const v = decide(s, gates);
      if (v === "meet") {
        if (cur && s.t - cur.lastT <= 600000) {
          cur.lastT = s.t; cur.steps.push(s);
          if (s.range < cur.minRange) cur.minRange = s.range;
          if (s.dcpa < cur.minDcpa) cur.minDcpa = s.dcpa;
        } else {
          out.push(cur = { pair: s.pair, subject: s.subject, first: s, lastT: s.t, steps: [s], minRange: s.range, minDcpa: s.dcpa });
        }
        if (cur) cur.lastT = s.t;
      } else if (cur && s.t - cur.lastT > 600000) {
        cur = null;
      }
    }
    return out;
  }

  return { M_PER_DEG_LAT, mPerDegLon, DEG, projector, len, bearing, angleDiff,
           DEFAULTS, thresholds, readThresholds, evaluatePair, decide, pill, events };
})();
