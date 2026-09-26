#!/usr/bin/env node
/**
 * What a tighter accuracy gate would cost, priced against the real table.
 *
 *   node scripts/one-off/2026-09-25-accuracy-geofence/threshold.mjs --source remote
 *
 * Read-only SELECT of way-db `gps_pings` + `geofences`.
 *
 * WHY THIS IS MEASURABLE
 * The gate drops a ping whose own receiver rates it worse than the limit, and it
 * runs before the state machine -- so a dropped ping is not stored AND is not
 * seen by the motion/geofence engine. Today's limit is 10 m (config.ts
 * PRE_FILTER_MAX_ACCURACY_M), and μlogger's phone-side filter is set to the same
 * 10 m, which is why production holds exactly one row above it. Lowering the
 * limit therefore affects exactly the rows with accuracy in (new limit, 10] --
 * a set that is fully present in this table. Nothing about the impact has to be
 * guessed; only the pings the PHONE already refuses to upload are invisible, and
 * they are all > 10 m, which no lowering of the limit can reach.
 *
 * Row counts are the least interesting part: the same gate also feeds the motion
 * engine, the dwell timers and the leg accounting, so the price is measured in
 * gaps created, legs lost and fence state that never arms.
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "../../..");
const args = process.argv.slice(2);
const source = args.includes("--local") ? "local" : "remote";
const LIMIT_NOW = 10.0;

const WRANGLER = join(REPO, "node_modules", "wrangler", "bin", "wrangler.js");
function sql(query) {
  const stdout = execFileSync(
    process.execPath,
    [WRANGLER, "d1", "execute", "WAY_DB", `--${source}`, "--json", `--command=${query}`],
    { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] }
  );
  const at = stdout.indexOf("[");
  if (at === -1) throw new Error(`wrangler did not return JSON:\n${stdout.slice(0, 800)}`);
  return JSON.parse(stdout.slice(at))[0]?.results ?? [];
}

const rows = sql(
  `SELECT device_id, timestamp, latitude, longitude, speed, speed_avg_30s, accuracy, leg_id,
          is_inside_geofence, geofence_name, is_driving, is_stationary, is_keep_alive
     FROM gps_pings ORDER BY device_id ASC, timestamp ASC;`
);
const fences = sql(`SELECT name, lat, lon, radius_m FROM geofences;`).map((f) => ({ ...f, radiusM: f.radius_m ?? 50 }));

const DIST_BUFFER_M = 40; // EXIT_RADIUS_BUFFER_M, for the "was it inside" test
const EXIT_WITNESS_GAP_S = 120; // a longer hole makes the crossing unwitnessed

function haversineKm(a, b, c, d) {
  const R = 6371.0;
  const r = (x) => (x * Math.PI) / 180;
  const dLat = r(c - a), dLon = r(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
const nearestSlack = (lat, lon) => {
  let best = Infinity;
  for (const f of fences) best = Math.min(best, haversineKm(lat, lon, f.lat, f.lon) * 1000 - f.radiusM);
  return best;
};

const located = rows
  .filter((r) => r.latitude !== null && r.longitude !== null)
  .map((r) => ({
    ...r,
    acc: r.accuracy === null || r.accuracy === undefined ? null : Number(r.accuracy),
    t: Date.parse(r.timestamp),
    slackM: nearestSlack(r.latitude, r.longitude),
  }));
// A ping is dropped when its own receiver rates it worse than the limit. NULL
// accuracy means "not reported" and is always accepted (accuracyIsAcceptable).
const wouldDrop = (r, limit) => r.acc !== null && r.acc > limit;

const byDevice = new Map();
for (const r of located) {
  if (!byDevice.has(r.device_id)) byDevice.set(r.device_id, []);
  byDevice.get(r.device_id).push(r);
}
for (const list of byDevice.values()) list.sort((a, b) => a.t - b.t);

const days = [...new Set(located.map((r) => r.timestamp.slice(0, 10)))].sort();
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

console.log(`\n════ way-db gps_pings (${source}) ════`);
console.log(`${located.length} stored pings, ${byDevice.size} devices, ${days.length} days, ${days[0]} → ${days[days.length - 1]}`);
console.log(`current limit ${LIMIT_NOW} m; rows above it: ${located.filter((r) => wouldDrop(r, LIMIT_NOW)).length}`);

// ── the accuracy values that are actually in play ───────────────────────
const hist = new Map();
for (const r of located) {
  if (r.acc === null) continue;
  const k = r.acc > 5 ? `${r.acc}` : null; // only the interesting tail
  if (k) hist.set(k, (hist.get(k) ?? 0) + 1);
}
const tail = located.filter((r) => r.acc !== null && r.acc > 5);
console.log(`\n── every stored fix worse than 5 m (${tail.length} of ${located.length}, ${pct(tail.length, located.length)}) ──`);
for (const [v, n] of [...hist.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  acc ${pad(Number(v).toFixed(2), 6)} m  ${padl(n, 5)} pings`);
}

// ── gap + leg + fence machinery ─────────────────────────────────────────
function analyse(limit) {
  let dropped = 0;
  let runs = 0;
  let gaps = [];
  const legsHit = new Set();
  const legsWiped = new Set();
  let keepAliveDropped = 0;
  let insideDropped = 0;
  let geoInsideDropped = 0;
  let insideOnPresetting = 0;
  let geoInsideOnPresetting = 0;
  const realHoles = [];
  let boundaryRuns = 0;
  const daysHit = new Set();
  const dayCount = new Map();

  for (const [id, list] of byDevice) {
    const legSeen = new Map();
    const legKept = new Map();
    for (const r of list) {
      if (r.leg_id !== null && r.leg_id !== undefined) {
        legSeen.set(r.leg_id, (legSeen.get(r.leg_id) ?? 0) + 1);
        if (!wouldDrop(r, limit)) legKept.set(r.leg_id, (legKept.get(r.leg_id) ?? 0) + 1);
      }
    }
    for (const [leg, n] of legSeen) {
      if (legKept.get(leg) === undefined) legsWiped.add(leg);
      else if (legKept.get(leg) < n) legsHit.add(leg);
    }

    let i = 0;
    while (i < list.length) {
      if (!wouldDrop(list[i], limit)) {
        dayCount.set(list[i].timestamp.slice(0, 10), (dayCount.get(list[i].timestamp.slice(0, 10)) ?? 0) + 1);
        i++;
        continue;
      }
      const start = i;
      while (i < list.length && wouldDrop(list[i], limit)) i++;
      const run = list.slice(start, i);
      dropped += run.length;
      runs++;
      const presetting = run[0].timestamp.startsWith("2026-08-27");
      for (const r of run) {
        daysHit.add(r.timestamp.slice(0, 10));
        if (r.is_keep_alive === 1) keepAliveDropped++;
        if (r.is_inside_geofence === 1) { insideDropped++; if (presetting) insideOnPresetting++; }
        if (r.slackM <= 0) { geoInsideDropped++; if (presetting) geoInsideOnPresetting++; }
      }
      // The hole the engine actually experiences: last kept ping -> next kept.
      const prev = list[start - 1];
      const next = list[i];
      if (prev && next) {
        const created = (next.t - prev.t) / 1000;
        gaps.push(created);
        // A run sitting against the edge of a data block (a night with no
        // uploads at all) reports a "hole" that was already there; only the
        // runs surrounded by continuous data are holes the gate CREATED.
        const gapBefore = (run[0].t - prev.t) / 1000;
        const gapAfter = (next.t - run[run.length - 1].t) / 1000;
        if (gapBefore >= 3600 || gapAfter >= 3600) boundaryRuns++;
        else realHoles.push({ id, at: run[0].timestamp, created, n: run.length });
      }
    }
  }
  const kept = located.length - dropped;
  const rgaps = realHoles.map((h) => h.created).sort((a, b) => a - b);
  return {
    limit, kept, dropped, runs, gaps, realHoles, rgaps, boundaryRuns,
    medianGap: rgaps.length ? rgaps[Math.floor(rgaps.length / 2)] : 0,
    maxGap: rgaps.length ? rgaps[rgaps.length - 1] : 0,
    over120: rgaps.filter((g) => g >= EXIT_WITNESS_GAP_S).length,
    over300: rgaps.filter((g) => g >= 300).length,
    daysHit: daysHit.size, legsHit: legsHit.size, legsWiped: legsWiped.size,
    keepAliveDropped, insideDropped, geoInsideDropped, insideOnPresetting, geoInsideOnPresetting, dayCount,
  };
}

console.log(`\n── rows kept, per limit ─────────────────────────────────────────────`);
console.log(`${pad("limit", 8)}${padl("kept", 8)}${padl("dropped", 9)}${padl("of table", 10)}${padl("days hit", 10)}${padl("legs hit", 10)}${padl("legs lost", 10)}`);
const results = [];
for (const limit of [10, 9, 8, 7.5, 7, 6.5, 6, 5, 4]) {
  const a = analyse(limit);
  results.push(a);
  console.log(
    `${pad(`${limit} m`, 8)}${padl(a.kept, 8)}${padl(a.dropped, 9)}${padl(pct(a.dropped, located.length), 10)}${padl(a.daysHit, 10)}${padl(a.legsHit, 10)}${padl(a.legsWiped, 10)}`
  );
}

// ── the holes the engine sees ───────────────────────────────────────────
// Only runs surrounded by continuous data count: a run sitting at the edge of a
// data block reports a hole that was already there.
console.log(`\n── holes the gate CREATES (last kept ping -> next kept) ──────────────`);
console.log(`${pad("limit", 8)}${padl("holes", 8)}${padl("median", 9)}${padl("max", 9)}${padl(">=120 s", 10)}${padl(">=5 min", 10)}${padl("at block edge", 15)}`);
for (const a of results) {
  if (![10, 7, 6].includes(a.limit)) continue;
  console.log(
    `${pad(`${a.limit} m`, 8)}${padl(a.realHoles.length, 8)}${padl(`${Math.round(a.medianGap)}s`, 9)}${padl(`${Math.round(a.maxGap)}s`, 9)}${padl(a.over120, 10)}${padl(a.over300, 10)}${padl(a.boundaryRuns, 15)}`
  );
}
for (const limit of [7, 6]) {
  const a = results.find((r) => r.limit === limit);
  const worst = a.realHoles.slice().sort((x, y) => y.created - x.created).slice(0, 5);
  if (!worst.length) continue;
  console.log(`\n  ${limit} m, worst holes created:`);
  for (const h of worst) {
    console.log(`    ${h.at}  ${pad(h.id, 6)} ${padl(h.n, 3)} pings dropped -> ${Math.round(h.created / 60)} min hole `);
  }
}

// ── what the fence engine loses ─────────────────────────────────────────
// The 2026-08-27 evening is separated out on purpose: it predates the phone's
// 10 m setting, so every limit above ~5 m eats it, and counting it as normal
// would price the change on data the setting already prevents today.
console.log(`\n── geofence state the gate would eat ────────────────────────────────`);
console.log(`${pad("limit", 8)}${padl("inside flag dropped", 21)}${padl("(that 08-27 eve)", 18)}${padl("geo-inside dropped", 21)}${padl("(that 08-27 eve)", 18)}`);
for (const a of results) {
  if (![10, 7, 6].includes(a.limit)) continue;
  console.log(
    `${pad(`${a.limit} m`, 8)}${padl(a.insideDropped, 21)}${padl(a.insideOnPresetting, 18)}${padl(a.geoInsideDropped, 21)}${padl(a.geoInsideOnPresetting, 18)}`
  );
}
console.log(`\nflags in the table: 93 inside-flagged, 343 geometrically inside`);

// ── WHERE the lost pings are ────────────────────────────────────────────
// Row percent is the wrong unit if the lost pings are concentrated at fences
// while the table's baseline is mostly open road.
const baseline = located.filter((r) => r.slackM <= 100).length / located.length;
console.log(`\n── what the lost pings are ───────────────────────────────────────────`);
console.log(`${pad("limit", 8)}${padl("dropped", 9)}${padl("within 100m of fence", 22)}${padl("(table baseline)", 18)}${padl("geometrically inside", 21)}`);
for (const limit of [8, 7, 6, 5]) {
  const drop = located.filter((r) => wouldDrop(r, limit));
  const near = drop.filter((r) => r.slackM <= 100).length;
  console.log(
    `${pad(`${limit} m`, 8)}${padl(drop.length, 9)}${padl(pct(near, drop.length), 22)}${padl(pct(baseline * located.length, located.length), 18)}${padl(pct(drop.filter((r) => r.slackM <= 0).length, drop.length), 21)}`
  );
}
console.log(`\n(table-wide: ${pct(baseline * located.length, located.length)} of all pings are within 100 m of a fence edge)`);

// ── per-day cost ────────────────────────────────────────────────────────
console.log(`\n── steady-state row loss (every day except the pre-setting 2026-08-27) ──`);
console.log(`${pad("limit", 8)}${padl("dropped", 9)}${padl("per day", 10)}${padl("worst day", 12)}`);
for (const limit of [9, 8, 7, 6, 5]) {
  const a = results.find((r) => r.limit === limit);
  const rowsAfter = located.filter((r) => !r.timestamp.startsWith("2026-08-27"));
  const dropped = rowsAfter.filter((r) => wouldDrop(r, limit)).length;
  const perDay = new Map();
  for (const r of rowsAfter) if (wouldDrop(r, limit)) perDay.set(r.timestamp.slice(0, 10), (perDay.get(r.timestamp.slice(0, 10)) ?? 0) + 1);
  const worst = [...perDay.entries()].sort((x, y) => y[1] - x[1])[0];
  console.log(
    `${pad(`${limit} m`, 8)}${padl(`${dropped}/${rowsAfter.length}`, 9)}${padl(pct(dropped, rowsAfter.length), 10)}${padl(worst ? `${worst[1]} on ${worst[0].slice(5)}` : "—", 12)}${pad(a.limit === 5 ? "" : "", 0)}`
  );
}

for (const limit of [7, 6]) {
  const a = results.find((r) => r.limit === limit);
  console.log(`\n── ${limit} m: rows kept per day ──────────────────────────────────────`);
  for (const d of days) {
    const now = located.filter((r) => r.timestamp.startsWith(d)).length;
    const kept = a.dayCount.get(d) ?? 0;
    if (now === kept) continue; // days the change does not touch
    console.log(`  ${d}  ${padl(now, 5)} → ${padl(kept, 5)}  (${now - kept} of ${now} dropped, ${pct(now - kept, now)})`);
  }
}

// ── per-device cost ─────────────────────────────────────────────────────
console.log(`\n── per device ──────────────────────────────────────────────────────`);
console.log(`${pad("device", 8)}${padl("pings", 8)}${padl("dropped @7", 12)}${padl("dropped @6", 12)}${padl("max acc", 9)}`);
for (const [id, list] of byDevice) {
  const d7 = list.filter((r) => wouldDrop(r, 7)).length;
  const d6 = list.filter((r) => wouldDrop(r, 6)).length;
  const max = Math.max(...list.map((r) => r.acc ?? 0));
  console.log(`${pad(id, 8)}${padl(list.length, 8)}${padl(d7, 12)}${padl(d6, 12)}${padl(max, 9)}`);
}
