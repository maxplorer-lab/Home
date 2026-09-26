#!/usr/bin/env node
/**
 * One-off: does a bad fix inflate the "inside a geofence" flag?
 *
 *   node scripts/one-off/2026-09-25-accuracy-geofence/report.mjs --source remote
 *   node scripts/one-off/2026-09-25-accuracy-geofence/report.mjs --source local --days 7
 *
 * Read-only: two SELECTs against way-db (`gps_pings`, `geofences`). No writes.
 *
 * WHY THE QUESTION IS SUBTLE
 * `gps_pings` only ever holds pings that were DRAWN -- FleetDO's accuracy gate
 * (PRE_FILTER_MAX_ACCURACY_M = 10 m, see src/way/config.ts) drops worse fixes
 * before processPing, so a fix stored here has accuracy <= 10 m or is NULL
 * (field absent -> always accepted). "The worst accuracy" in this table is
 * therefore the 8-10 m band, not a long tail of 50 m fixes.
 *
 * The distance geometry is the app's own: lib/geofence.ts haversineKm (R=6371)
 * compared against the fence's ENTRY radius (radius_m, falling back to
 * DEFAULT_GEOFENCE_RADIUS_M = 50). The stored flag additionally has hysteresis
 * (exit radius = radius_m + EXIT_RADIUS_BUFFER_M = 40 m once you are inside),
 * so the script re-derives a stateless flag and counts the mismatches instead
 * of assuming they are zero.
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../../..");

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1] ?? d;
};
const source = flag("--source", "remote");
const days = flag("--days", null) ? Number(flag("--days")) : null;
if (!["remote", "local"].includes(source)) {
  console.error(`--source must be remote | local (got ${source})`);
  process.exit(2);
}

const WRANGLER = join(REPO, "node_modules", "wrangler", "bin", "wrangler.js");
function sql(query) {
  // process.execPath + wrangler.js, not npx: on Windows npx.cmd needs a shell
  // and execFileSync then fails with EINVAL.
  //
  // --command, NOT --file: as of wrangler 4.133.0 `d1 execute --file` ingests
  // the file ("Checking if file needs uploading") and returns a one-row
  // summary instead of the SELECT results, which silently looked like "the
  // table is empty". --command emits the rows. Passing argv directly also
  // sidesteps shell quoting, which is why the old temp-file dance is gone.
  const stdout = execFileSync(
    process.execPath,
    [WRANGLER, "d1", "execute", "WAY_DB", `--${source}`, "--json", `--command=${query}`],
    { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] }
  );
  const at = stdout.indexOf("[");
  if (at === -1) throw new Error(`wrangler did not return JSON:\n${stdout.slice(0, 800)}`);
  return JSON.parse(stdout.slice(at))[0]?.results ?? [];
}

// ── the app's own geometry (lib/geofence.ts) ────────────────────────────
const DEFAULT_RADIUS_M = 50.0;
const EXIT_BUFFER_M = 40.0;
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── fetch ───────────────────────────────────────────────────────────────
const where = days ? ` WHERE timestamp >= datetime('now', '-${days} days')` : "";
console.error(`reading way-db (${source})${days ? `, last ${days}d` : ", full table"} ...`);
const pings = sql(
  `SELECT id, device_id, timestamp, latitude, longitude, speed, speed_avg_30s, accuracy,
          is_inside_geofence, geofence_name, is_driving, is_stationary, is_keep_alive
     FROM gps_pings${where}
    ORDER BY timestamp ASC;`
);
const fences = sql(
  `SELECT name, display_name, category, lat, lon, radius_m, exit_radius_m FROM geofences ORDER BY name;`
).map((f) => ({ ...f, radiusM: f.radius_m ?? DEFAULT_RADIUS_M }));

// ── per-ping geometry ───────────────────────────────────────────────────
const located = [];
let unlocatable = 0;
for (const p of pings) {
  if (p.latitude === null || p.longitude === null) {
    unlocatable++;
    continue;
  }
  let nearest = null;
  let statelessInside = false;
  let statelessFence = null;
  let hysteresisInside = false;
  for (const f of fences) {
    const d = haversineKm(p.latitude, p.longitude, f.lat, f.lon) * 1000;
    if (nearest === null || d - f.radiusM < nearest.slackM) nearest = { f, distM: d, slackM: d - f.radiusM };
    if (d <= f.radiusM && !statelessInside) {
      statelessInside = true;
      statelessFence = f.name;
    }
    // Hysteresis is a path property, but the stored flag is written with the
    // device's own inside/outside state; the exit radius is the looser test and
    // it always wins for a ping the exit rule accepted.
    if (d <= (f.exit_radius_m ?? f.radiusM + EXIT_BUFFER_M)) hysteresisInside = true;
  }
  located.push({
    ...p,
    acc: p.accuracy === null || p.accuracy === undefined ? null : Number(p.accuracy),
    slackM: nearest.slackM,
    nearestFence: nearest.f.name,
    storedInside: p.is_inside_geofence === 1,
    statelessInside,
    statelessFence,
    hysteresisInside,
  });
}

// ── buckets ─────────────────────────────────────────────────────────────
// The gate is 10 m, so the band edges land on the values that matter: <=3 is a
// clean fix, 8-10 is the worst a drawn ping can be, NULL means the client sent
// no accuracy field (always accepted, unknown quality).
const BANDS = [
  ["<=3 m", (a) => a !== null && a <= 3],
  ["3-5 m", (a) => a !== null && a > 3 && a <= 5],
  ["5-8 m", (a) => a !== null && a > 5 && a <= 8],
  ["8-10 m", (a) => a !== null && a > 8 && a <= 10],
  [">10 m", (a) => a !== null && a > 10],
  ["null", (a) => a === null],
];
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

function table(rows, label) {
  console.log(`\n── ${label} ───────────────────────────────────────────────────────────`);
  console.log(
    `${pad("accuracy band", 14)}${padl("pings", 8)}${padl("share", 8)}${padl("inside", 8)}${padl("driving", 9)}${padl("inside(driving)", 16)}${padl("closest-any-fence<=100m", 26)}${padl("stored!=derived", 17)}`
  );
  for (const [name, test] of BANDS) {
    const b = rows.filter((r) => test(r.acc));
    if (!b.length) continue;
    const drv = b.filter((r) => r.is_driving === 1);
    const inside = b.filter((r) => r.storedInside).length;
    const near = b.filter((r) => r.slackM <= 100).length;
    const mismatch = b.filter((r) => r.storedInside !== r.statelessInside).length;
    console.log(
      `${pad(name, 14)}${padl(b.length, 8)}${padl(pct(b.length, rows.length), 8)}${padl(pct(inside, b.length), 8)}${padl(drv.length, 9)}${padl(pct(drv.filter((r) => r.storedInside).length, drv.length), 16)}${padl(pct(near, b.length), 26)}${padl(pct(mismatch, b.length), 17)}`
    );
  }
}

console.log(`\n════ way-db gps_pings, source=${source}${days ? `, last ${days}d` : ""} ════`);
console.log(`stored pings        ${pings.length}`);
console.log(`  located           ${located.length}${unlocatable ? ` (${unlocatable} with NULL lat/lon, excluded)` : ""}`);
console.log(`devices             ${[...new Set(pings.map((p) => p.device_id))].sort().join(", ")}`);
if (pings.length) {
  console.log(`window              ${pings[0].timestamp} → ${pings[pings.length - 1].timestamp}`);
}
console.log(`fences              ${fences.length} (${fences.map((f) => `${f.name}:${f.radiusM}m`).join(", ") || "none"})`);
const withFenceFlag = pings.filter((p) => p.geofence_name).length;
console.log(`geofence_name set   ${withFenceFlag} (${pct(withFenceFlag, pings.length)})`);

const accs = located.map((r) => r.acc).filter((a) => a !== null).sort((a, b) => a - b);
if (accs.length) {
  const q = (f) => accs[Math.min(accs.length - 1, Math.floor(f * (accs.length - 1)))];
  console.log(
    `\naccuracy distribution (non-null, n=${accs.length}): min ${accs[0]} · p50 ${q(0.5)} · p90 ${q(0.9)} · p99 ${q(0.99)} · max ${accs[accs.length - 1]}`
  );
  console.log(`null-accuracy pings ${located.filter((r) => r.acc === null).length} (${pct(located.filter((r) => r.acc === null).length, located.length)})`);
}

table(located, "inside a geofence, by accuracy band (all pings)");
table(located.filter((r) => r.is_driving === 1), "… restated for driving pings only");

// Per-device, because devices differ in where they sit (a parked phone at home
// is always inside, and its accuracy mix is its own). Without this the band
// comparison confounds accuracy with device.
console.log(`\n── by device ────────────────────────────────────────────────────────`);
for (const id of [...new Set(located.map((r) => r.device_id))].sort()) {
  const d = located.filter((r) => r.device_id === id);
  const dAcc = d.map((r) => r.acc).filter((a) => a !== null).sort((a, b) => a - b);
  const med = dAcc.length ? dAcc[Math.floor(dAcc.length / 2)] : null;
  console.log(
    `${pad(id, 12)}${padl(d.length, 8)} pings  median acc ${padl(med ?? "null", 5)}  inside ${padl(pct(d.filter((r) => r.storedInside).length, d.length), 7)}  null-acc ${padl(pct(d.filter((r) => r.acc === null).length, d.length), 7)}  nearest-fence median ${padl(Math.round(d.map((r) => r.slackM).sort((a, b) => a - b)[Math.floor(d.length / 2)]), 7)} m`
  );
}

// ── the boundary test ───────────────────────────────────────────────────
// `accuracy` IS the positional uncertainty radius. A ping whose distance to the
// fence edge is inside one accuracy is a coin flip: the receiver cannot tell
// which side it is on. So if bad accuracy were inflating the flag, these pings
// would read far from 50% inside, and further from 50% as accuracy worsens.
// A band that sits near 50% here is not flipping anything -- it is honestly
// reporting that the position is ambiguous.
const edge = located.filter((r) => Math.abs(r.slackM) <= Math.max(r.acc ?? 0, 5));
console.log(`\n── boundary pings (|distance to fence edge| <= accuracy, or 5 m) ─────`);
console.log(`${pad("accuracy band", 14)}${padl("pings", 8)}${padl("inside", 8)}${padl("median |slack|", 15)}`);
for (const [name, test] of BANDS) {
  const b = edge.filter((r) => test(r.acc));
  if (!b.length) continue;
  const med = b.map((r) => Math.abs(r.slackM)).sort((a, b) => a - b)[Math.floor(b.length / 2)];
  console.log(
    `${pad(name, 14)}${padl(b.length, 8)}${padl(pct(b.filter((r) => r.storedInside).length, b.length), 8)}${padl(`${Math.round(med)} m`, 15)}`
  );
}

// ── what the flag WOULD say with a perfect fix ──────────────────────────
// Slack histogram: how much room the worst band had. A 9 m fix 4 m outside the
// edge is a "close to" ping whose flag is a coin toss; a 9 m fix 300 m inside
// is not evidence of anything.
console.log(`\n── distance to the nearest fence edge (slack; negative = inside) ─────`);
console.log(`${pad("band", 10)}${padl("<= -100m", 10)}${padl("-100..0", 10)}${padl("0..25m", 9)}${padl("25..100m", 10)}${padl("100..500m", 11)}${padl(">500m", 9)}`);
for (const [name, test] of BANDS) {
  const b = located.filter((r) => test(r.acc));
  if (!b.length) continue;
  const inRange = (lo, hi) => b.filter((r) => r.slackM > lo && r.slackM <= hi).length;
  console.log(
    `${pad(name, 10)}${padl(pct(b.filter((r) => r.slackM <= -100).length, b.length), 10)}${padl(pct(inRange(-100, 0), b.length), 10)}${padl(pct(inRange(0, 25), b.length), 9)}${padl(pct(inRange(25, 100), b.length), 10)}${padl(pct(inRange(100, 500), b.length), 11)}${padl(pct(b.filter((r) => r.slackM > 500).length, b.length), 9)}`
  );
}

// ── controlled comparison ───────────────────────────────────────────────
// The table-wide inside rate is confounded: bad fixes are BAD because the phone
// is indoors, and indoors is exactly where the fences are. So compare only
// among pings that are geometrically inside a fence. If accuracy were flipping
// the flag, this rate would move with the band; if it is flat, then accuracy is
// not the variable -- place is.
console.log(`\n── inside rate among pings GEOMETRICALLY inside (slack <= 0), by band ─`);
console.log(`${pad("accuracy band", 14)}${padl("geo-inside", 12)}${padl("flagged inside", 16)}${padl("median dist inside", 19)}`);
for (const [name, test] of BANDS) {
  const b = located.filter((r) => test(r.acc) && r.slackM <= 0);
  if (!b.length) continue;
  const d = b.map((r) => -r.slackM).sort((a, b) => a - b)[Math.floor(b.length / 2)];
  console.log(
    `${pad(name, 14)}${padl(b.length, 12)}${padl(pct(b.filter((r) => r.storedInside).length, b.length), 16)}${padl(`${Math.round(d)} m`, 19)}`
  );
}
const geoIn = located.filter((r) => r.slackM <= 0);
console.log(
  `all bands        ${padl(geoIn.length, 12)}${padl(pct(geoIn.filter((r) => r.storedInside).length, geoIn.length), 16)}`
);

// …and with the moving pings removed too, so the comparison is "parked inside a
// fence" in every band. This is the closest the table gets to a like-for-like
// test of whether a worse fix is more likely to be DECLARED inside.
console.log(`\n── inside rate among pings geometrically inside AND slow (< 10 km/h) ──`);
console.log(`${pad("accuracy band", 14)}${padl("geo-inside+slow", 16)}${padl("flagged inside", 16)}`);
for (const [name, test] of BANDS) {
  const b = located.filter((r) => test(r.acc) && r.slackM <= 0 && (r.speed ?? 0) < 10);
  if (!b.length) continue;
  console.log(`${pad(name, 14)}${padl(b.length, 16)}${padl(pct(b.filter((r) => r.storedInside).length, b.length), 16)}`);
}

// How much of each band is one session? A band whose rows are 90% one evening at
// home is measuring that evening, not accuracy.
console.log(`\n── where each band actually is ──────────────────────────────────────`);
console.log(`${pad("band", 14)}${padl("pings", 8)}${padl("on 2026-08-27", 14)}${padl("at Home1", 10)}${padl("at Office2/3", 12)}${padl("nowhere near", 13)}`);
for (const [name, test] of BANDS) {
  const b = located.filter((r) => test(r.acc));
  if (!b.length) continue;
  const home = b.filter((r) => r.nearestFence === "Home1" && r.slackM <= 100).length;
  const office = b.filter((r) => (r.nearestFence === "Office2" || r.nearestFence === "Office3") && r.slackM <= 100).length;
  console.log(
    `${pad(name, 14)}${padl(b.length, 8)}${padl(pct(b.filter((r) => String(r.timestamp).startsWith("2026-08-27")).length, b.length), 14)}${padl(pct(home, b.length), 10)}${padl(pct(office, b.length), 12)}${padl(pct(b.filter((r) => r.slackM > 500).length, b.length), 13)}`
  );
}

// ── detail ──────────────────────────────────────────────────────────────
console.log(`\n── stored inside flag vs geometry, per fence ────────────────────────`);
console.log(`${pad("fence", 10)}${pad("radius", 8)}${padl("within r", 10)}${padl("flagged", 10)}${padl("median dist", 12)}${padl("flagged>r", 11)}`);
for (const f of fences) {
  const within = located.filter((r) => haversineKm(r.latitude, r.longitude, f.lat, f.lon) * 1000 <= f.radiusM);
  const flagged = located.filter((r) => r.storedInside && r.nearestFence === f.name);
  const dists = located.map((r) => haversineKm(r.latitude, r.longitude, f.lat, f.lon) * 1000).sort((a, b) => a - b);
  console.log(
    `${pad(f.name, 10)}${pad(`${f.radiusM} m`, 8)}${padl(within.length, 10)}${padl(flagged.length, 10)}${padl(`${Math.round(dists[Math.floor(dists.length / 2)])} m`, 12)}${padl(flagged.filter((r) => haversineKm(r.latitude, r.longitude, f.lat, f.lon) * 1000 > f.radiusM).length, 11)}`
  );
}
console.log(`\nstored is_inside_geofence = 1: ${located.filter((r) => r.storedInside).length}`);
console.log(`geometrically within some fence's entry radius: ${located.filter((r) => r.statelessInside).length}`);

console.log(`\n── every ping with accuracy > 8 m ────────────────────────────────────`);
for (const r of located.filter((r) => r.acc > 8)) {
  console.log(
    `${r.timestamp}  ${pad(r.device_id, 6)} acc ${padl(r.acc, 5)}  slack ${padl(Math.round(r.slackM), 6)} m  ${pad(r.nearestFence, 8)} stored=${r.storedInside ? 1 : 0} derived=${r.statelessInside ? 1 : 0} drive=${r.is_driving} stat=${r.is_stationary} keep=${r.is_keep_alive} kmh=${r.speed}`
  );
}

// Where does "stored outside but geometrically inside" live? A fence the app
// knew about but the flag missed, or a fence the geometry test thinks exists.
const extra = located.filter((r) => !r.storedInside && r.statelessInside);
if (extra.length) {
  console.log(`\n── ${extra.length} pings geometrically inside but flagged OUTSIDE ──`);
  const byFence = new Map();
  for (const r of extra) {
    const k = `${r.statelessFence} / ${r.device_id}`;
    byFence.set(k, [...(byFence.get(k) ?? []), r]);
  }
  for (const [k, list] of [...byFence.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const slack = list.map((r) => r.slackM).sort((a, b) => a - b);
    console.log(
      `${pad(k, 22)}${padl(list.length, 7)} pings  ${list[0].timestamp} → ${list[list.length - 1].timestamp}  slack ${Math.round(slack[0])}..${Math.round(slack[slack.length - 1])} m  acc ${list.map((r) => r.acc).sort((a, b) => a - b)[Math.floor(list.length / 2)]}`
    );
  }
}

// Is the "inside but flagged 0" set just the entry dwell? FleetDO arms the flag
// only after the device has been inside, slow, for ENTRY_GUARD_SECONDS (30 s):
// until then processOutside reports isInside=false, so a real fix 40 m inside
// the fence is stored as 0. A run of such pings that ends the moment the flag
// turns 1, and lasts ~30 s, is that guard rather than a bug.
console.log(`\n── runs of consecutive "geometrically inside, flagged 0" ────────`);
for (const id of [...new Set(located.map((r) => r.device_id))].sort()) {
  const day = located.filter((r) => r.device_id === id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let run = [];
  const runs = [];
  for (let i = 0; i <= day.length; i++) {
    const r = day[i];
    if (r && r.slackM <= 0 && !r.storedInside) run.push(r);
    else {
      if (run.length) runs.push({ run, next: r });
      run = [];
    }
  }
  if (!runs.length) continue;
  const durs = runs.map(({ run: rr }) =>
    (Date.parse(rr[rr.length - 1].timestamp) - Date.parse(rr[0].timestamp)) / 1000
  );
  const med = durs.slice().sort((a, b) => a - b)[Math.floor(durs.length / 2)];
  const confirmed = runs.filter(({ next }) => next && next.slackM <= 0 && next.storedInside).length;
  console.log(
    `${pad(id, 8)}${padl(runs.length, 6)} runs  lengths ${Math.min(...durs)}s..${Math.max(...durs)}s (median ${med}s)  pings/run median ${[...runs.map(({ run: rr }) => rr.length)].sort((a, b) => a - b)[Math.floor(runs.length / 2)]}  next ping confirmed-inside: ${confirmed}/${runs.length}`
  );
}

// The longest unconfirmed stretch, verbatim: is it a slow park that the dwell
// should have caught, or a pass-through that was never meant to confirm?
// FleetDO uses result.speedAvg for the entry speed gate, so that column -- not
// the reported `speed` -- is the one that resets the 30 s timer.
for (const id of [...new Set(located.map((r) => r.device_id))].sort()) {
  const day = located.filter((r) => r.device_id === id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let best = null;
  let run = [];
  const push = (r, next) => {
    if (run.length && (!best || run.length > best.run.length)) best = { run, next };
    run = [];
  };
  for (let i = 0; i <= day.length; i++) {
    const r = day[i];
    if (r && r.slackM <= 0 && !r.storedInside) run.push(r);
    else push(r, r);
  }
  if (!best) continue;
  console.log(`\n── ${id}: longest unconfirmed-inside run (${best.run.length} pings) ──`);
  const i0 = day.indexOf(best.run[0]);
  for (const r of day.slice(Math.max(0, i0 - 3), i0 + best.run.length + 4)) {
    console.log(
      `${r.timestamp}  slack ${padl(Math.round(r.slackM), 5)} m  kmh ${padl(r.speed === null ? "null" : Number(r.speed).toFixed(1), 6)}  avg30 ${padl(r.speed_avg_30s === null ? "null" : Number(r.speed_avg_30s).toFixed(1), 5)}  drive ${r.is_driving} stat ${r.is_stationary}  flag ${r.storedInside ? 1 : 0}`
    );
  }
}

// Mismatch detail: the stored flag is the app's, the derived one is stateless.
const mism = located.filter((r) => r.storedInside !== r.statelessInside);
if (mism.length) {
  const mine = mism.filter((r) => r.statelessInside).length;
  console.log(
    `\nstored vs stateless-derived inside flag: ${mism.length} differ of ${located.length} (${pct(mism.length, located.length)})`
  );
  console.log(`  ${mine} derived-inside but stored outside (the exit hysteresis, or a fence edited since)`);
  console.log(`  ${mism.length - mine} stored inside but derived outside`);
  console.log(`  ${mism.filter((r) => r.acc !== null && r.acc > 8).length} of them are 8-10 m fixes`);
}
