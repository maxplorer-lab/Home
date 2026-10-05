#!/usr/bin/env node
// ─── Client-state convergence audit ─────────────────────────────
//   node scripts/client-state-audit.mjs        (or: npm run audit:client-state)
//
// Answers ONE question about the whole super app: **for every fact a client
// caches from the server, is there a carrier for a change made elsewhere?**
// The registry, the three carriers (connect / change / resync) and the rules
// are documented at the top of `scripts/lib/client-state.mjs`, which is also
// what smoke §30 runs against fixtures that MUST fail.
//
// It is READ-ONLY: it parses sources and writes nothing, so it is safe to run
// anywhere, and it exits 1 on a finding so it can gate a release.
import { scanClientState, formatFaults } from './lib/client-state.mjs'

const { facts, faults } = scanClientState()

if (faults.length === 0) {
  const declared = facts.filter((f) => f.declared).length
  console.log(`client state: clean — ${facts.length} fact(s) a client caches, each with a carrier (${declared} declared as needing none, printed below)`)
  for (const f of facts) {
    console.log(`  ${f.fact}`)
    console.log(`      ${f.carriers.length ? f.carriers.join(' · ') : 'declared: ' + f.declared}`)
  }
  process.exit(0)
}

console.log(`client state: ${faults.length} fault(s) across ${facts.length} declared fact(s)\n`)
for (const line of formatFaults(faults)) console.log('  ' + line)
console.log('\nA fact a client caches needs a carrier: the connect snapshot or the boot')
console.log('fetch (for a page that was not there), a change signal (for one that was),')
console.log('and a re-read on reconnect/visible so a missed signal is a delay, not a lie.')
console.log('Fix the code, or declare the fact with the reason it needs none.')
process.exit(1)
