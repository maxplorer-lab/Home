#!/usr/bin/env node
// 2026-10-21 — run the leg repair once the nightly flush has landed.
//
//   node scripts/one-off/2026-10-08-leg-per-point/sweep-after-flush.mjs
//       Wait for the day's pings to reach D1, then repair (writes).
//
//   … --dry                    wait, print what it would repair, write nothing
//   … --day 2026-10-21         the day to wait for (default: today, UTC)
//   … --until 2026-10-22T04:00:00Z   give up after this (default: day+1 04:00Z)
//   … --every 600 --settle 300 how often to look, how long a count must hold
//
// Why this exists: the FleetDO processes pings AS THEY ARRIVE and buffers the
// rows in `pending_sync`; D1 only sees them at the 21:00 UTC cron (wrangler.jsonc
// — the day boundary is UTC+3 midnight, not UTC midnight). So the pings Niri's
// phone sent before the fix was deployed are accepted by the OLD code and reach
// `gps_pings` hours later, still carrying one leg per point. Repairing in the
// afternoon cannot see them; repairing after the flush must, or that day reports
// only the part driven once the fix was live.
//
// It waits rather than guessing a time: it polls for the day's first rows, waits
// for the count to stop moving (a flush is a batch of inserts, not one), and only
// then hands over to repair-leg-ids.mjs — the same script, same receipt, same
// idempotence. If the phone does not move, no rows appear and nothing is written.
//
// `--dry` is the honest test of the whole thing: it exercises the wait and the
// measurement and stops before the UPDATE.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
// Through node itself, not `npx`: on Windows the npx shim is not spawnable
// without a shell. Same pattern as scripts/db-migrate.mjs.
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const REPAIR = join(HERE, 'repair-leg-ids.mjs')

const DEVICE = 'Niri'
const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const valueOf = (name) => (has(name) ? argv[argv.indexOf(name) + 1] : null)

const today = new Date().toISOString().slice(0, 10)
const day = valueOf('--day') || today
const every = Number(valueOf('--every') || 600)
const settle = Number(valueOf('--settle') || 300)
const until = new Date(valueOf('--until') || `${day}T00:00:00.000Z`)
if (!valueOf('--until')) until.setUTCDate(until.getUTCDate() + 1)
if (!valueOf('--until')) until.setUTCHours(4, 0, 0, 0)
const dry = has('--dry')
const local = has('--local')

const log = (...parts) => console.log(new Date().toISOString(), ...parts)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One D1 statement, rows only — see repair-leg-ids.mjs for why `--command`. */
function d1(sql) {
  const raw = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', 'home-db', local ? '--local' : '--remote', '--json', '--command', sql],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  return JSON.parse(raw.slice(raw.indexOf('[')))[0].results
}

const dayStart = `${day}T00:00:00.000Z`
const countRows = () =>
  d1(`SELECT COUNT(*) AS n FROM gps_pings WHERE device_id = '${DEVICE}' AND timestamp >= '${dayStart}'`)[0].n

console.log(
  `\nsweep-after-flush — ${local ? 'LOCAL' : 'PRODUCTION'} home-db, ${DEVICE}, waiting for ${day}` +
    ` (cron flush 21:00 UTC), ${dry ? 'DRY' : 'will repair'}\n`
)
log(`deadline ${until.toISOString()}, poll every ${every}s, settle ${settle}s`)

let seen = 0
while (Date.now() < until.getTime()) {
  seen = countRows()
  if (seen > 0) break
  log('no rows for the day yet — sleeping')
  await sleep(every * 1000)
}

if (seen === 0) {
  log(`nothing flushed for ${day} by the deadline: the phone stored no pings, so there is nothing to sweep.`)
  process.exit(0)
}

log(`${seen} rows for ${day} are in D1 — waiting for the count to settle`)
// A flush is a batch of inserts; repairing halfway through would leave the rest
// of the batch behind, and the script's own warning would read as a live latch.
let stable = 0
while (Date.now() < until.getTime()) {
  await sleep(settle * 1000)
  const now = countRows()
  log(`  ${now} rows (was ${seen})`)
  if (now === seen) {
    stable += 1
    if (stable >= 1) break
  } else {
    stable = 0
    seen = now
  }
}
log(`${seen} rows, count steady — ${dry ? 'measuring' : 'repairing'}\n`)

const run = (args) =>
  execFileSync(process.execPath, [REPAIR, ...args, ...(local ? ['--local'] : [])], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })

// The first pass is the report. If it finds nothing (an ordinary day, or a second
// run), the UPDATE has nothing to do either, so it is not issued at all.
const report = run([])
process.stdout.write(report)
if (dry || report.includes('nothing to repair')) {
  log(dry ? '--dry: stopping before the UPDATE.' : 'nothing to repair — no UPDATE issued.')
  process.exit(0)
}
process.stdout.write(run(['--apply', '--yes']))
log('done — evidence above; re-running this script now reports nothing to repair.')
