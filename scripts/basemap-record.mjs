#!/usr/bin/env node
// ─── Record the map background's upstream ───────────────────────────────
//   node scripts/basemap-record.mjs            (or: npm run basemaps:record)
//   node scripts/basemap-record.mjs --dry-run  (walk and report, write nothing)
//
// This is the ONLY thing in the repo that talks to the tile host on purpose. It
// runs the SAME walk the guards run — a declared key's style, its vector sources,
// each source's TileJSON, one tile at the household's own centre and one over
// open water — with a reader that saves every byte it fetched, so the record in
// `scripts/fixtures/basemaps/` can never list a roster the checks do not read.
//
// It then judges the record it just wrote. That order matters: refreshing the
// record is the moment somebody else's server gets to change its mind, so this
// exits 1 when the new upstream breaks a rule — "a failure means upstream
// changed, not that the network was down" — and prints the per-URL diff
// (same/changed/new/removed, by sha256) that says WHAT changed.
//
// A walk that could not reach something writes NOTHING: a transient failure must
// never silently drop an entry from the record, because a missing entry reads to
// the suite as "upstream stopped serving this" rather than "the laptop was on a
// train".

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RECORD_DIR, declareKeys, centreFrom, formatFindings, judgeBasemaps,
  liveReader, readRecord, writeRecord,
} from './lib/basemap-record.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const dryRun = process.argv.includes('--dry-run')

const keys = declareKeys(readFileSync(join(root, 'public/shared/basemaps.js'), 'utf8'))
const centre = centreFrom(readFileSync(join(root, 'public/way/index.html'), 'utf8'))
const tunerWindow = {}
new Function('window', readFileSync(join(root, 'public/shared/basemap-style.js'), 'utf8'))(tunerWindow)
const tuner = tunerWindow.HomeBasemapStyle

const before = readRecord(root)
const sink = new Map()
const fetchedAt = new Date().toISOString()

console.log(`recording ${keys.length} key(s) (${keys.map((k) => k.key).join(', ')}) at ${centre ? `${centre.lat},${centre.lng}` : 'no centre'}${dryRun ? ' — dry run, nothing will be written' : ''}\n`)

const { findings, summary } = await judgeBasemaps({ keys, centre, tuner, read: liveReader({ sink }), fetchedAt })

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const prior = new Map((before ? before.entries : []).map((e) => [e.url, e]))
const urls = [...new Set([...prior.keys(), ...sink.keys()])].sort()
let changed = 0
for (const url of urls) {
  const old = prior.get(url)
  const now = sink.get(url)
  const digest = now ? sha(now.bytes) : ''
  const state = !old ? 'NEW    ' : !now ? 'REMOVED' : old.sha256 === digest ? 'same   ' : 'CHANGED'
  if (state !== 'same   ') changed++
  console.log(`  ${state} ${String(now ? now.bytes.length : old.bytes).padStart(7)}B  ${url}`)
  if (state === 'CHANGED') console.log(`                                                ${old.sha256.slice(0, 12)} -> ${digest.slice(0, 12)}`)
}

const unreachable = findings.filter((f) => f.level === 'unreachable')
if (unreachable.length) {
  console.log(`\n${unreachable.length} URL(s) could not be reached — the record is UNCHANGED, because a walk that\nmissed something must not look like upstream dropping it:`)
  for (const line of formatFindings(unreachable)) console.log('  ' + line)
  process.exit(1)
}

if (dryRun) {
  console.log(`\ndry run: ${changed} entry/entries would change; nothing written`)
} else {
  const { rows, pruned } = writeRecord(root, { entries: sink, fetchedAt })
  console.log(`\nwrote ${rows.length} entr(ies) to ${RECORD_DIR}/ (${pruned} stale file(s) pruned), recorded ${fetchedAt}`)
}

const faults = findings.filter((f) => f.level !== 'unreachable')
if (faults.length) {
  console.log(`\nthe upstream just recorded does NOT satisfy the basemap rules:\n`)
  for (const line of formatFindings(faults)) console.log('  ' + line)
  console.log('\nRead the finding against the diff above: what upstream changed is usually the\ncause, and the guards in smoke §9 are what a viewer would have seen.')
  process.exit(1)
}
console.log(`\nrecord clean: ${summary.judged.join('; ')}`)
