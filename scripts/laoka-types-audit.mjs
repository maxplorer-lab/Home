#!/usr/bin/env node
// ─── Home's JavaScript type audit ───────────────────────────────
//   node scripts/laoka-types-audit.mjs          (or: npm run audit:laoka-types)
//   node scripts/laoka-types-audit.mjs --print  (the pinned options + checked set)
//
// Answers ONE question about the source: **does every `.js` file under `src/`
// typecheck?** `npm run check` is the type gate for `.ts`/`.tsx` — `checkJs` is
// off there, on purpose, because JavaScript checked at full strictness reports
// one fault per unannotated parameter. This pass is the other half: the same
// compiler, the same strict settings, exactly ONE relaxation
// (`noImplicitAny`), over every `.js`/`.mjs`/`.cjs` under `src/`.
//
// Why it exists. Laoka's vendored source (17 files under `src/laoka/`, 3192
// lines) sat inside `include: ["src"]` and outside the gate — parsed, checked,
// and not one line of it looked at. Silencing the implicit-any noise leaves TEN
// real faults, every one of a shape worth catching: eight `err.message` reads
// off a caught `unknown`, one inferred result whose `value` could be absent,
// one route-table overload. Those are fixed; this keeps them fixed, and it
// catches the next one the moment it lands — including in a file nobody
// remembers to declare, because the checked set is a walk, not a list.
//
// The relaxation is PINNED inside `scripts/lib/laoka-types.mjs`: the pass
// asserts its own effective options and refuses to answer if any of them moved
// (loosening `strictNullChecks` to hide a fault is a finding here, not a
// workaround). `npm run smoke` §29 runs the same scan plus its controls, and
// `scripts/one-off/2026-09-27-laoka-types/mutate.mjs` proves the fault classes
// still go red.
//
// It is READ-ONLY (it reads files and runs the compiler in memory), needs no
// server, database or network, and exits 1 on a finding so it can gate a
// release.

import { scanLaokaTypes, formatLaokaFindings, describeCheckedSet, PINNED_OPTIONS } from './lib/laoka-types.mjs'

if (process.argv.includes('--print')) {
  const set = describeCheckedSet()
  console.log(`checked set: ${set.files.length} file(s), ${set.lines} line(s) under src/\n`)
  for (const f of set.files) console.log('  ' + f)
  console.log('\npinned options (everything else comes from tsconfig.json):')
  for (const [key, want] of Object.entries(PINNED_OPTIONS)) {
    const note = key === 'noImplicitAny' ? '   ← the one declared relaxation' : ''
    console.log(`  ${key.padEnd(30)} ${want}${note}`)
  }
  process.exit(0)
}

const findings = scanLaokaTypes()

if (findings.length === 0) {
  const set = describeCheckedSet()
  console.log(`JS types: clean — ${set.files.length} file(s), ${set.lines} line(s) under src/, one declared relaxation (noImplicitAny)`)
  process.exit(0)
}

console.log(`JS types: ${findings.length} fault(s)\n`)
for (const line of formatLaokaFindings(findings)) console.log('  ' + line)
console.log('\nEvery .js/.mjs/.cjs under src/ is checked here; the .ts/.tsx side is')
console.log('`npm run check`. Type the value (`err instanceof Error`, a declared')
console.log('result shape) or widen the declaration — never the option set: the')
console.log('relaxation is pinned to noImplicitAny, and only that one.')
process.exit(1)
