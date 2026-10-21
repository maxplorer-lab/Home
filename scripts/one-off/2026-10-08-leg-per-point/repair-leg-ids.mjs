#!/usr/bin/env node
// 2026-10-08 — repair the leg ids the pendingLegCut latch wrote (production home-db)
//
//   node scripts/one-off/2026-10-08-leg-per-point/repair-leg-ids.mjs
//       READ ONLY. Prints the blast radius: one-point-leg rows per day.
//
//   node scripts/one-off/2026-10-08-leg-per-point/repair-leg-ids.mjs --apply --yes
//       WRITES. Sets leg_id = NULL on Niri's one-point legs from 2026-10-04 on.
//
//   … --local      run against the local dev database instead of production
//
// Why: the latch (00-README.md) made nearly every stored point its own leg from
// 2026-10-04 until the FleetDO fix. HomeTripLegs.forDay() keeps only legs with
// two or more points, and a one-point leg has no segment, so the day's and the
// month's driven totals read 0.0 while the tracks still draw. October froze at
// 23.05 km; with these 11,020 leg ids nulled the same rows read 192.66 km over
// 156 legs (measured with the page's own engine on the real rows).
//
// NULL is the documented state, not a hole: migration 0003 says every row that
// predates legs keeps leg_id = NULL and the dashboard falls back to gap-based
// segmentation (HomePlayback.FLUID.GAP_SECONDS, 90 s). So the rows stay, the map
// still draws them, and the totals measure them again.
//
// Why null instead of recomputing: a one-point leg has nothing left to recover —
// only one ping survived it. The gap rule is the app's own answer for a leg it
// cannot see, and the review overlay already draws by it, so a repaired day is
// drawn and summed by ONE rule instead of two.
//
// Deploy the FleetDO fix FIRST. It clears the latch on the device's next
// movement (a stationary ping leaves the cut armed for the departure), but rows
// written before it are still one-point legs — and rows written while it is
// still live would freeze the total again. This script warns if the newest
// stored point is still a one-point leg.
//
// Safe to re-run: rows already NULL are skipped. Undo within 7 days with D1 Time
// Travel (`wrangler d1 time-travel restore home-db --timestamp <before-this>`).
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// Through node itself, not `npx`: on Windows the npx shim is not spawnable
// without a shell. Same pattern as scripts/db-migrate.mjs.
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

const DEVICE = 'Niri'
// The latch's first stored point (2026-10-04T09:19:47Z). Everything before it
// was written by a healthy engine; the 3 genuine one-point legs on 2026-10-02
// stay untouched.
const FROM = '2026-10-04T00:00:00.000Z'

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const local = has('--local')
const apply = has('--apply')
const yes = has('--yes')

if (apply && !yes) {
  console.log('\n  This would rewrite production rows (or the local DB with --local).')
  console.log('  It cannot be undone except with D1 Time Travel. Read 00-README.md,')
  console.log('  deploy the FleetDO fix, then re-run with:\n')
  console.log('    node scripts/one-off/2026-10-08-leg-per-point/repair-leg-ids.mjs --apply --yes\n')
  process.exit(1)
}

/** One D1 statement. `--command` (not `--file`): a remote file import answers
 *  with a summary, not the SELECT rows, so a report built on it prints nothing. */
function d1(sql) {
  const raw = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', 'home-db', local ? '--local' : '--remote', '--json', '--command', sql],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  // Wrangler prints its banner before the JSON array; take from the first '['.
  return JSON.parse(raw.slice(raw.indexOf('[')))
}

// The one-point legs, as a subquery both statements share: a leg whose stored
// row count is 1. Scoped to the device so a leg id (per-device counter) can
// never collide with the other phone's.
const ONE_POINT_LEGS =
  `SELECT leg_id FROM gps_pings WHERE device_id = '${DEVICE}' AND leg_id IS NOT NULL ` +
  `GROUP BY leg_id HAVING COUNT(*) = 1`

const inWindow = `device_id = '${DEVICE}' AND timestamp >= '${FROM}' AND leg_id IS NOT NULL`

const report = () =>
  d1(
    `SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS rows FROM gps_pings ` +
      `WHERE ${inWindow} AND leg_id IN (${ONE_POINT_LEGS}) GROUP BY day ORDER BY day`
  )[0].results

console.log(`\nleg repair — ${local ? 'LOCAL' : 'PRODUCTION'} home-db, device ${DEVICE}, from ${FROM}\n`)

const rows = report()
if (!rows.length) {
  console.log('  nothing to repair: no one-point legs in the window.\n')
  process.exit(0)
}

let total = 0
for (const r of rows) {
  total += r.rows
  console.log(`  ${r.day}   ${String(r.rows).padStart(5)} rows`)
}
console.log(`\n  ${total} rows would go back to the 90 s gap rule (leg_id = NULL)\n`)

// Is the latch still live? The newest stored point belonging to a one-point leg
// means the engine is still minting one leg per ping, and a repair now would be
// undone by the next flush.
const newest = d1(
  `SELECT timestamp, leg_id FROM gps_pings WHERE device_id = '${DEVICE}' AND leg_id IS NOT NULL ` +
    `ORDER BY timestamp DESC LIMIT 1`
)[0].results[0]
if (newest) {
  const newestOnePoint = d1(
    `SELECT COUNT(*) AS n FROM gps_pings WHERE device_id = '${DEVICE}' AND leg_id = ${newest.leg_id}`
  )[0].results[0].n === 1
  if (newestOnePoint) {
    console.log('  WARNING: the newest stored point still belongs to a one-point leg.')
    console.log('  The FleetDO fix is not deployed (or has not seen a movement yet), so')
    console.log('  more one-point legs will be written after this repair and the total will')
    console.log('  freeze again. Deploy src/way/do/FleetDO.ts first.\n')
  }
}

if (!apply) {
  console.log('  dry run: nothing written. Add --apply --yes to repair.\n')
  process.exit(0)
}

const res = d1(
  `UPDATE gps_pings SET leg_id = NULL WHERE ${inWindow} AND leg_id IN (${ONE_POINT_LEGS})`
)[0]
// `meta.changes` is not reported by every wrangler build (the local one leaves it
// out), so the count below is the receipt either way: the SELECT that follows
// reads the same rows back and has to find none of them.
const changes = res.meta && typeof res.meta.changes === 'number' ? res.meta.changes : null
console.log(`  UPDATE ran${changes === null ? ` (asked for ${total} rows)` : ` (${changes} rows)`}`)

const left = d1(
  `SELECT COUNT(*) AS n FROM gps_pings WHERE ${inWindow} AND leg_id IN (${ONE_POINT_LEGS})`
)[0].results[0].n
console.log(`  one-point-leg rows left in the window: ${left}`)
console.log('\n  Reopen the Trips tab: the month and each day now measure the same rows')
console.log('  by the gap rule. A one-point leg left here is a genuine short leg, and it')
console.log('  contributes no distance by definition.\n')
