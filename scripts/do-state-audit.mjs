#!/usr/bin/env node
// ─── Durable Object instance-state audit ────────────────────────
//   node scripts/do-state-audit.mjs        (or: npm run audit:do-state)
//
// Answers ONE question about the Durable Objects: **is any field on `this`
// carrying one request's data into another request's turn?**
//
// Why this exists. A DO is single-threaded, so it is tempting to treat `this`
// as private scratch space for the request being handled. It is not: single
// threaded means no two INSTRUCTIONS overlap, and says nothing about two
// REQUESTS, which interleave at every `await`. So
//
//     this.currentDevice = body.deviceId     // request A
//     ... await ...                          // request B assigns the same field
//     use(this.currentDevice)                // A now acts on B's device
//
// leaks across requests while looking exactly like ordinary object state. State
// on `this` is legitimate and this app depends on it — a geofence cache, a
// cooldown map, a rate-limit ledger — so the audit is not "no state on `this`".
// It is: every field must be DECLARED here with the reason it is object state,
// and its writes must match that declaration.
//
// The declaration lives beside the code it describes (`DO_STATE_POLICY` in
// scripts/lib/do-state.mjs), which is what makes this a decision rather than a
// convention: a new field fails the audit until somebody writes down what it
// is, and a known field written a new way fails until the claim is revisited.
//
// Scope comes from `wrangler.jsonc`'s `durable_objects` bindings, not from
// `extends DurableObject` — Laoka's `Lobby` is a plain class and a DO all the
// same, and the bindings are what Cloudflare actually instantiates. A class
// named there and missing from the source is itself a finding.
//
// It is READ-ONLY: it parses sources and writes nothing, so it is safe to run
// anywhere, and it exits 1 on a finding so it can gate a release. `npm run
// smoke` §25 runs the same scan plus the controls that prove it can still fail.
//
//   node scripts/do-state-audit.mjs [srcDir]
import {
  scanDoState, formatDoFaults, durableObjectClasses, DO_STATE_POLICY,
} from './lib/do-state.mjs'
import { fileURLToPath } from 'node:url'

const root = process.argv[2] || 'src'
const { classes, faults } = scanDoState({ root })

const registered = durableObjectClasses(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)))
console.log(`durable objects (from wrangler.jsonc): ${registered.join(', ') || '(none)'}`)
for (const c of classes) {
  console.log(`  ${c.name}  ${c.file}`)
  for (const f of c.fields) console.log(`    ${f.field.padEnd(18)} ${f.kind}`)
}

const reasons = Object.entries(DO_STATE_POLICY).filter(([, v]) => (v.why || '').length < 20)
if (reasons.length) {
  console.log(`\nregistry entries with no real reason: ${reasons.map(([k]) => k).join(', ')}`)
}

if (faults.length === 0) {
  console.log('\ndo state: clean — every field is declared, and none carries request data across an interleaving point')
  process.exit(0)
}

console.log(`\ndo state: ${faults.length} finding(s)\n`)
for (const line of formatDoFaults(faults)) console.log('  ' + line)
console.log('\nA field written from request data and read past an await is one request\'s data')
console.log('in another request\'s turn. Either thread the value through as a parameter, or')
console.log('declare the field in DO_STATE_POLICY with the reason it is object state.')
process.exit(1)
