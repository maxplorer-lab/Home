#!/usr/bin/env node
// ─── Basemap record audit ───────────────────────────────────────────────
//   node scripts/basemap-record-audit.mjs          (or: npm run audit:basemaps)
//   node scripts/basemap-record-audit.mjs --live   (judge what upstream serves now)
//   node scripts/basemap-record-audit.mjs --print  (the recorded roster)
//
// Answers ONE question: **does the upstream this repo recorded still satisfy the
// basemap rules?** It is the CI half of smoke §9 — the same walk, the same
// judgment (`scripts/lib/basemap-record.mjs`), run against the copy in
// `scripts/fixtures/basemaps/` instead of against the network. No dev server, no
// database, no secret, and — unless you pass `--live` — no network at all: the
// recorded hosts are BLOCKED here, so a check that quietly went back to fetching
// upstream fails instead of passing on the day the network happens to be up.
//
// Why the record and not the network. Two answers to one question is how a red
// stops meaning anything: a rotated upstream release, a CDN blip and a laptop on
// a train all read as "the map is broken", and the fix is different in each case.
// The record makes the routine answer deterministic, `npm run basemaps:record`
// updates it deliberately (printing what changed), and `--live` is how you ask
// "has upstream moved since?" on purpose.
//
// READ-ONLY: it reads files and prints, and exits 1 on a finding so it can gate a
// pull request.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RECORD_DIR, REFRESH_HINT, STALE_DAYS, banLiveFetch, centreFrom, declareKeys,
  formatFindings, judgeBasemaps, liveReader, readRecord, recordAgeDays, recordReader,
} from './lib/basemap-record.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const live = args.includes('--live')

const keys = declareKeys(readFileSync(join(root, 'public/shared/basemaps.js'), 'utf8'))
const centre = centreFrom(readFileSync(join(root, 'public/way/index.html'), 'utf8'))
const tunerWindow = {}
new Function('window', readFileSync(join(root, 'public/shared/basemap-style.js'), 'utf8'))(tunerWindow)
const tuner = tunerWindow.HomeBasemapStyle

const record = readRecord(root)

if (args.includes('--print')) {
  console.log(`record: ${record ? record.recordedAt : 'MISSING'} · ${record ? record.entries.length : 0} entry(ies) in ${RECORD_DIR}/\n`)
  for (const e of record ? record.entries : []) {
    console.log(`  ${String(e.bytes).padStart(7)}B  ${(e.kind || '?').padEnd(8)} ${(e.view || '').padEnd(12)} ${e.sha256.slice(0, 12)}  ${e.url}`)
  }
  if (record) console.log(`\nhosts covered: ${(record.hosts || []).join(', ')}`)
  process.exit(0)
}

if (!record) {
  console.log(`basemap record: MISSING — there is no ${RECORD_DIR}/, so nothing here can answer\nabout the tile host. ${REFRESH_HINT}`)
  process.exitCode = 1
  process.exit()
}

const restore = live ? () => {} : banLiveFetch()
let judged
let banBlind = false
try {
  judged = await judgeBasemaps({
    keys,
    centre,
    tuner,
    read: live ? liveReader() : recordReader({ root, record }),
    fetchedAt: live ? new Date().toISOString() : record.recordedAt,
  })
  // …and the ban has to be shown to bite, with it still installed: ask for a
  // recorded host and it must be refused HERE, or "runs without network" is a
  // claim nobody tests. (The refusal is the answer — no bytes are read.)
  if (!live) {
    try { await fetch('https://tiles.openfreemap.org/styles/positron'); banBlind = true } catch { /* expected */ }
  }
} finally {
  restore()
}

const age = recordAgeDays(record)
const findings = banBlind
  ? [...judged.findings, { concern: 'record', level: 'fault', message: 'the record-mode network ban did not bite — this audit may have answered from the network, which is the one thing it exists not to do' }]
  : judged.findings
const hard = findings.filter((f) => f.level === 'fault' || f.level === 'unreachable' || f.level === 'stale')

if (hard.length === 0) {
  console.log(`basemap record: clean — ${keys.length} key(s), ${record.entries.length} recorded entr(ies), ${live ? 'judged LIVE' : `recorded ${record.recordedAt.slice(0, 10)} (${age} day(s) ago)`}`)
  process.exit(0)
}

console.log(`basemap record: ${hard.length} fault(s)${live ? ' (live)' : ''}\n`)
for (const line of formatFindings(hard)) console.log('  ' + line)
console.log(`\nThe record is a copy of somebody else's server: refresh it with \`npm run basemaps:record\``)
console.log(`(which prints what changed) and read the finding against that diff. Past ${STALE_DAYS} days a`)
console.log('record is reported rather than judged, because a guard about a copy has to know')
console.log('its copy is old. `--live` asks upstream directly instead.')
// `exitCode` and a natural exit rather than `process.exit(1)`: this is the one
// audit that can have a fetch in flight (live mode, or the disarm control), and
// calling exit on a closing socket aborts the process on Windows — the finding
// would still be red, but with a crash printed under it instead of the message.
process.exitCode = 1
