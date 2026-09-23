#!/usr/bin/env node
// ─── Module-scope state audit ───────────────────────────────────
//   node scripts/module-state-audit.mjs        (or: npm run audit:module-state)
//
// Answers ONE question about the server source: **is any module-scope binding
// written from inside a function?** A yes means two concurrent requests in one
// Worker isolate can see each other's data, because the isolate interleaves
// them at every `await`.
//
// Why this exists. `src/identity.ts` carried a `let lastPassword` at module
// scope for a while: the login path set it, provisioning read it across several
// D1 round-trips, and a `finally` cleared it. Each request was individually
// correct, which is why it survived review, a rename and a merge. The failure
// needs overlap — so it has no symptom to notice, no error to read, and no
// line in any log; it is only visible by reading the code and asking whether
// this binding is the same one another request could be using.
//
// This is the readable form, for a person or for CI. `npm run smoke` §24 holds
// the same check plus the proof that it can still fail; that pairing is the
// point — a static check whose input silently empties reports a green tree
// forever, so the guard around this tool matters as much as the tool.
//
// It is READ-ONLY: it parses sources and writes nothing, so it is safe to run
// anywhere, and it exits 1 on a finding so it can gate a release.
//
// Scope note, so nobody "fixes" the wrong half: this applies to `src/` — the
// Worker, where requests are concurrent and share one isolate. The pages under
// `public/` keep timers, drag state and in-flight flags in module scope on
// purpose; a page has exactly one user and one thread, so there is nothing to
// share and nothing to report.
//
//   node scripts/module-state-audit.mjs src
import { scanModuleState, formatFindings } from './lib/module-state.mjs'

const root = process.argv[2] || 'src'
const findings = scanModuleState({ root })

if (findings.length === 0) {
  console.log(`module state: clean — no module-scope binding in ${root}/ is written from inside a function`)
  process.exit(0)
}

console.log(`module state: ${findings.length} fault(s) in ${root}/\n`)
for (const line of formatFindings(findings)) console.log('  ' + line)
console.log('\nA module-scope binding written by a request is shared state between')
console.log('concurrent requests in the same isolate. Thread the value through as a')
console.log('parameter instead (see `ensureModuleAccounts` in src/identity.ts).')
process.exit(1)
