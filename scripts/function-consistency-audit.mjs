#!/usr/bin/env node
// ─── Function consistency & stability audit ─────────────────────
//   node scripts/function-consistency-audit.mjs        (or: npm run audit:functions)
//
// Answers ONE question about every function the app ships: **is a call that
// can fail or can be rejected actually carried somewhere?** The three faults
// (floating-async, empty-catch, async-callback) and the declared-exceptions
// contract are documented at the top of `scripts/lib/function-consistency.mjs`,
// which is also what smoke §30 runs against fixtures that MUST fail.
//
// Scope: `src/` (the Worker and the SSR pages), `public/**.js` (the pages and
// the shared engines) and the inline <script> blocks of `public/**.html` — the
// pages are where most of this app's functions live, so a scan that stopped at
// the Worker would miss the ones a phone actually runs.
//
// It is READ-ONLY: it parses sources and writes nothing, so it is safe to run
// anywhere, and it exits 1 on a finding so it can gate a release.
//
//   node scripts/function-consistency-audit.mjs [root]
import { scanFunctions, formatFaults } from './lib/function-consistency.mjs'

// No argument scans the shipped app (`src/` + `public/`, the default in the
// library). An argument narrows it to one tree, which is what the smoke
// controls and a person debugging a single module both use.
const { functions, faults, covered } = scanFunctions(process.argv[2] ? { root: process.argv[2] } : {})

const total = [...functions.values()].reduce((a, b) => a + b, 0)
const files = [...functions.keys()].length

// Call sites that rest on a page's own unhandled-rejection net are REPORTED, not
// hidden: the net is a real carrier (the page tells the person), but how much
// depends on it is a number a reader should be able to see.
const coverage = covered.length
  ? `\n\n${covered.length} async call site(s) rest on a page's rejection net (reported below, not faults):\n` +
    formatFaults(covered).map((l) => '  ' + l).join('\n')
  : ''

if (faults.length === 0) {
  console.log(`function consistency: clean — ${total} function(s) across ${files} file(s), no floating promise, silent catch or await lost in a sync callback${coverage}`)
  process.exit(0)
}

console.log(`function consistency: ${faults.length} fault(s) across ${files} file(s) (${total} function(s) scanned)\n`)
for (const line of formatFaults(faults)) console.log('  ' + line)
if (coverage) console.log(coverage)
console.log('\nA bare call to an async function is not a style question: its rejection')
console.log('is unhandled, and the code after it runs as if the work had happened. Fix it')
console.log('by awaiting it, by `void`-ing it where the drop is deliberate, or by declaring')
console.log('the exception in FUNCTION_POLICY (scripts/lib/function-consistency.mjs) with')
console.log('the reason it is intentional.')
process.exit(1)
