#!/usr/bin/env node
// ─── Rule → guard map audit ──────────────────────────────────────
//   node scripts/rule-guards-audit.mjs          (or: npm run audit:rules)
//   node scripts/rule-guards-audit.mjs --print  (the map as the scan reads it)
//
// Answers ONE question: **is every numbered rule's declared guard real, and
// does every section reference in the repo still point at something?** The
// map is the table in AGENTS.md ("The rule → guard map"); this tool reads it
// the way the module-state scan reads sources.
//
// Why this exists. A guard named only in prose cannot go stale loudly: rename
// a smoke section, delete a check, move a driver, and the promise reads as
// well as it did the day it was written. Declaring the promises in a table
// turns them into names a scanner can resolve — and the scanner is only as
// good as its own falsifier, which is why smoke §28 holds the same scan plus
// fixtures, and `scripts/one-off/2026-09-27-rule-guards/mutate.mjs` proves
// each fault class can still go red.
//
// It is READ-ONLY: it reads files and prints; it exits 1 on a finding so it
// can gate a release.

import { scanRuleGuards, formatRuleFindings, loadSources, deriveMap } from './lib/rule-guards.mjs'

const args = process.argv.slice(2)
const rootArg = args.find((a) => !a.startsWith('-'))
const root = rootArg || '.'

if (args.includes('--print')) {
  const sources = loadSources(root)
  const map = deriveMap(sources)
  console.log(`rules ${map.ruleCount} · smoke sections ${map.sections.length} · excused ${map.excused.length} · unguarded rules ${map.noneCount}\n`)
  for (const r of map.rules) {
    console.log(`${String(r.n).padStart(2)}  ${r.slug || '(no slug)'}  →  ${r.guards.join(' | ') || 'NONE DECLARED'}`)
    if (r.prose.length) console.log(`      prose: ${r.prose.join(', ')}`)
  }
  if (map.excused.length) {
    console.log('\nexcused:')
    for (const e of map.excused) console.log(`  smoke §${e.section} — ${e.reason}`)
  }
  process.exit(0)
}

const findings = scanRuleGuards(loadSources(root))

if (findings.length === 0) {
  const map = deriveMap(loadSources(root))
  console.log(`rule guards: clean — ${map.ruleCount} rules (${map.noneCount} unguarded by declaration), ${map.sections.length} smoke sections all claimed or excused`)
  process.exit(0)
}

console.log(`rule guards: ${findings.length} fault(s)\n`)
for (const line of formatRuleFindings(findings)) console.log('  ' + line)
console.log('\nA guard is a name the suite can resolve: smoke §N (optionally with a')
console.log('check fragment), audit:<script>, or a driver path — declared in the')
console.log('rule→guard map in AGENTS.md. "none (convention)" is a declared answer;')
console.log('omission is the fault this audit exists to find.')
process.exit(1)
