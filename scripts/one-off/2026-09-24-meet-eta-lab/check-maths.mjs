#!/usr/bin/env node
/**
 * Pins what the demo is supposed to say, so the claim can be re-proved instead
 * of re-read from the README.
 *
 * The lab is two views of one dataset (meet-lab.html's tables, meet-map.html on
 * real tiles) and both call meet-maths.js. A view can break without changing a
 * single number in the other -- if that maths drifts, every table on the pages
 * stays plausible and stops being evidence. This is the guard for that: it runs
 * the SAME functions the pages call, headlessly, against the same tracks.js, and
 * fails loudly when a conclusion moves.
 *
 *   node scripts/one-off/2026-09-24-meet-eta-lab/check-maths.mjs
 *
 * The expected values are pinned to the 120 s DEMO, not to a rule: the demo's
 * geometry is known by construction (see 00-README.md), so the numbers are
 * facts about the fixture. Regenerating the demo with different seeds or a
 * different `--minutes` means re-reading the README and re-pinning them here --
 * which is the point, because a silent change in these numbers is exactly the
 * failure mode this file exists to catch.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** Both files are browser globals; a bare `window` object is the whole mock. */
function load(file) {
  const w = {};
  new Function("window", readFileSync(join(HERE, file), "utf8"))(w);
  return w;
}

const DATA = load("tracks.js").MEET_LAB_TRACKS;
const M = load("meet-maths.js").MeetMaths;

if (!DATA) {
  console.error("tracks.js did not define MEET_LAB_TRACKS -- regenerate it with build-data.mjs --demo");
  process.exit(1);
}

const PASS = [], FAIL = [];
const ok = (what, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  (same ? PASS : FAIL).push(`${same ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${same ? "" : ` (expected ${JSON.stringify(want)})`}`);
};
const near = (what, got, want, tol) => {
  const same = Math.abs(got - want) <= tol;
  // Rounded for the report: the raw values are floats, and a log full of
  // 1195.1589439899637 makes a real change harder to spot.
  const show = Math.round(got * 1000) / 1000;
  (same ? PASS : FAIL).push(`${same ? "ok  " : "FAIL"} ${what}: ${show}${same ? "" : ` (expected ${want} ±${tol})`}`);
};

const ALL_ON = { outside: 1, fresh: 1, closing: 1, dcpa: 1, settled: 1, relative: 1, heading: 1, speed: 1, notTogether: 1 };
const gates = (off = []) => Object.fromEntries(Object.entries(ALL_ON).map(([k, v]) => [k, off.includes(k) ? false : !!v]));

// The pages build these from their controls; here from the same defaults and the
// same mapping, so a change to either has to change this check too.
const C = M.thresholds(M.DEFAULTS);
// The other reading of the fence rule (see the section on it below).
const C_RELAXED = M.thresholds({ ...M.DEFAULTS, fenceMode: "stationary" });

const dev = (id) => DATA.devices.find((d) => d.id === id);
const pairRows = (a, b, c = C, off = []) => {
  const rows = M.evaluatePair(dev(a), dev(b), c);
  rows.forEach((s) => { s.subject = a; });
  return { rows, events: M.events(rows, gates(off)) };
};
const allEvents = (off = [], c = C) => {
  let out = [];
  for (let i = 0; i < DATA.devices.length; i++)
    for (let j = i + 1; j < DATA.devices.length; j++)
      out = out.concat(pairRows(DATA.devices[i].id, DATA.devices[j].id, c, off).events);
  return out;
};

// ── the fixture itself ────────────────────────────────────────────────────
const t0 = Math.min(...DATA.devices.flatMap((d) => d.pings.map((p) => p.t)));
const spanS = (Math.max(...DATA.devices.flatMap((d) => d.pings.map((p) => p.t))) - t0) / 1000;
ok("devices in the demo", DATA.devices.length, 5);
near("window length (s)", spanS, 120, 0);

// ── the case the concept exists for ───────────────────────────────────────
const headOn = pairRows("Niri", "MaxX");
ok("Niri x MaxX: meeting events", headOn.events.length, 1);
near("Niri x MaxX: range at the first step (m)", headOn.events[0].first.range, 1195, 1);
near("Niri x MaxX: first predicted miss (m)", headOn.events[0].first.dcpa, 73, 1);
near("Niri x MaxX: first time-to-crossing (s)", headOn.events[0].first.tcaS, 46, 1);
near("Niri x MaxX: pill opens at (s into the window)", (headOn.events[0].first.t - t0) / 1000, 45, 0);

const closest = headOn.rows.filter((s) => s.checks).reduce((b, s) => (b === null || s.range < b.range ? s : b), null);
near("Niri x MaxX: closest observed (m) -- the ground truth", closest.range, 30, 1);
near("Niri x MaxX: closest observed at (s into the window)", (closest.t - t0) / 1000, 100, 0);

// The handoff: at the pass the pair is inside the together radius, which is
// where the app's existing peer pill takes over from this one -- and only for
// as long as they are that close, after which the range opens again and this
// pill correctly stays away (it is a pill about ARRIVING, not about having
// met: two people sitting at the same table are not a meeting event).
const together = headOn.rows.filter((s) => s.verdict === "together");
near("Niri x MaxX: rows handed to the peer pill", together.length, 3, 0);
ok("... and they are the ones around the pass (s into the window)",
  together.map((s) => (s.t - t0) / 1000), [95, 100, 105]);
ok("... the closest-approach row is one of them", together.includes(closest), true);
ok("... and the last row of the window is not", headOn.rows[headOn.rows.length - 1].verdict, "silent");

// The hole the bothOutside gate punches in the middle of a true meet, because
// one of them is driving through their own home fence. Pinned as a COUNT so a
// change to the rule shows up here rather than in an argument later.
const holes = headOn.events[0].steps
  ? headOn.rows.filter((s) => s.t >= headOn.events[0].first.t && s.t <= headOn.events[0].lastT && s.checks && !s.checks.outside)
  : [];
near("Niri x MaxX: steps of the meet silenced by bothOutside", holes.length, 3, 0);
ok("... and why", holes.map((s) => s.fenceA ?? s.fenceB).filter(Boolean), ["Home1", "Home1", "Home1"]);

// ── what the miss distance is for ─────────────────────────────────────────
const kofi = pairRows("Niri", "Kofi");
ok("Niri x Kofi: meeting events (head-on on two roads 473 m apart)", kofi.events.length, 0);
near("Niri x Kofi: closest observed (m)", kofi.rows.filter((s) => s.checks).reduce((b, s) => (b === null || s.range < b.range ? s : b), null).range, 464, 2);

// ── the ablation, as counts ───────────────────────────────────────────────
ok("events with every gate on", allEvents().length, 2);
ok("turning `settled` off adds", allEvents(["settled"]).length - 2, 1);
ok("turning `heading` off adds", allEvents(["heading"]).length - 2, 2);
ok("turning `dcpa` off adds", allEvents(["dcpa"]).length - 2, 1);
for (const g of ["fresh", "closing", "relative", "speed", "notTogether"]) {
  ok(`turning \`${g}\` off adds (a gate that earns nothing)`, allEvents([g]).length - 2, 0);
}

// ── the fence rule, both readings ─────────────────────────────────────────
// Strict costs a 15 s hole in a true meet (above: 3 silenced steps), because
// every driver is inside their own home fence for the first minute of a trip.
// The relaxed reading -- a peer inside a fence only counts as home if it is also
// not moving -- is supposed to close the hole WITHOUT letting the case the gate
// exists for come back: a mover converging on somebody parked in a fence.
const strictMeet = pairRows("Niri", "MaxX", C).events[0];
const relaxedMeet = pairRows("Niri", "MaxX", C_RELAXED).events[0];
near("strict: steps of the meet (hole included)", strictMeet.steps.length, 7, 0);
near("stationary: steps of the same meet", relaxedMeet.steps.length, 10, 0);
near("stationary: steps silenced by the gate (the hole)",
  pairRows("Niri", "MaxX", C_RELAXED).rows.filter((s) => s.t >= relaxedMeet.first.t && s.t <= relaxedMeet.lastT && s.checks && !s.checks.outside).length, 0, 0);
near("stationary: the meet opens at the same second as strict",
  (relaxedMeet.first.t - strictMeet.first.t) / 1000, 0, 0);
ok("stationary: total events unchanged (no new false positive)", allEvents([], C_RELAXED).length, 2);
ok("stationary: Niri x Aina is still suppressed -- she is parked at home",
  pairRows("Niri", "Aina", C_RELAXED).events.length, 0);
ok("stationary: the fence gate is still doing the same work when turned off",
  allEvents(["outside"], C_RELAXED).length - allEvents([], C_RELAXED).length, 4);
ok("strict: and the same four when it is turned off there",
  allEvents(["outside"], C).length - allEvents([], C).length, 4);
// The raw fact is kept separate from the gate's answer, so the page can show a
// driver inside a fence without pretending the gate ignored its input.
ok("the row still reports the raw fact: Niri is inside Home1 while driving",
  pairRows("Niri", "MaxX", C_RELAXED).rows.filter((s) => !s.outsideA).map((s) => s.fenceA),
  ["Home1", "Home1", "Home1"]);
ok("... and that the relaxed rule let it through",
  pairRows("Niri", "MaxX", C_RELAXED).rows.filter((s) => !s.outsideA).map((s) => s.parkedInFenceA),
  [false, false, false]);
ok("while a parked peer is still flagged as home",
  pairRows("Niri", "Aina", C_RELAXED).rows.filter((s) => s.parkedInFenceB).length > 0, true);

// ── the guard the fixture cannot exercise, in either window ───────────────
// Solo's gap is 90 s in the ten minute demo and absent from the 120 s cut (it
// starts at step 60). Both are under the 180 s cap, so `fresh` cannot fire on
// either -- which the ablation above shows as "adds 0" for the WRONG reason:
// not because staleness is harmless, but because this fixture never goes stale.
const solo = dev("Solo").pings;
const maxGap = Math.max(...solo.slice(1).map((p, i) => (p.t - solo[i].t) / 1000));
near("Solo's longest gap (s) -- 90 in the 10 min demo, absent from the cut", maxGap, spanS >= 600 ? 90 : 5, 0);
ok("the gap is under the staleness cap, so `fresh` never fires here", maxGap < M.DEFAULTS.freshS, true);
ok("... against the cap in DEFAULTS (s)", M.DEFAULTS.freshS, 180);

// ── the view-level invariants both pages rely on ──────────────────────────
ok("thresholds() maps minutes to seconds", C.tcaMaxS, 900);
ok("thresholds() passes the fence rule through", [C.fenceMode, C_RELAXED.fenceMode], ["strict", "stationary"]);
ok("an unknown fence rule cannot silently become relaxed", M.thresholds({ ...M.DEFAULTS, fenceMode: "nonsense" }).fenceMode, "strict");
ok("thresholds() maps seconds to ms", C.freshMs, 180000);
near("every demo speed is derived, not reported (km/h)",
  M.evaluatePair(dev("Niri"), dev("MaxX"), C).filter((s) => s.checks && s.speedA !== null)[0].speedA, 40, 8);

// ── report ────────────────────────────────────────────────────────────────
for (const line of PASS) console.log(line);
if (FAIL.length) {
  console.log("");
  for (const line of FAIL) console.log(line);
  console.log(`\n${FAIL.length} of ${PASS.length + FAIL.length} checks failed.`);
  console.log("Either the maths changed, or the demo was regenerated: re-read 00-README.md before re-pinning.");
  process.exit(1);
}
console.log(`\nAll ${PASS.length} checks passed (dataset: ${DATA.source}, ${DATA.devices.length} devices).`);
