#!/usr/bin/env node
// ─── The rule → guard map: proof that the audit can fail ─────────
// Falsification driver for `npm run audit:rules` (scripts/lib/rule-guards.mjs),
// which the suite runs as smoke §28. The audit answers one question — does
// every numbered rule's declared guard still exist, and does every § citation
// still point at a section? — and a scanner is only as good as its own
// falsifier: one whose input silently empties, or whose rule set silently
// stops being read, reports a clean tree forever. That is not hypothetical
// here. While this map was being written, the `audit:` cell resolved its
// script by the SUFFIX (`pkg.scripts['do-state']`) instead of the name the
// cell carries (`pkg.scripts['audit:do-state']`), so every audit row would
// have read as a missing script — and no test would have said so.
//
// Each mutation below is a fault class the audit claims to catch, applied to
// the real tree and then undone:
//
// A fixture writes its section sign as `\u00a7` on purpose: a literal one in
// this file would be a citation the audit has to resolve, and no document owns
// a section 99. The escape is only in the source text — the mutation is applied
// with the real character.
//
//   M1  a guard cell names a smoke section that does not exist
//   M2  a numbered rule loses its row
//   M3  a rule is renumbered, so every citation behind it means something else
//   M4  a rule's prose names a guard its rows omit
//   M5  the excused table loses a section (the census must hold)
//   M6  a citation loses its document name
//   M7  a CLAIMED smoke section is renamed away
//   M8  a declared `audit:` script is renamed (the lookup must carry the prefix)
//
//   node scripts/one-off/2026-09-27-rule-guards/mutate.mjs
//
// It needs no dev server and no database: the audit reads files only, so this
// driver belongs in CI's `guards` job beside the other two. Leaves the tree
// byte-identical, or it says so.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../../../', import.meta.url)          // the repo root (Home/)
const rootPath = fileURLToPath(root)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const write = (p, s) => writeFileSync(new URL(p, root), s)
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex')

// ── line endings ─────────────────────────────────────────────────────
// This working tree is a WINDOWS checkout: files on disk may be CRLF while
// every anchor below is written with a plain \n. Matching raw bytes misses the
// anchor — and a missed anchor is a SKIPPED mutation, which changes no code and
// still exits 0.
const normalized = (p) => read(p).replace(/\r\n/g, '\n')
function writeKeepingEol(p, text) {
  const crlf = read(p).includes('\r\n')
  write(p, crlf ? text.replace(/\n/g, '\r\n') : text)
}

function runAudit() {
  try {
    return execSync('node scripts/rule-guards-audit.mjs', { cwd: rootPath, encoding: 'utf8' })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

const mutations = [
  {
    id: 'M1',
    file: 'AGENTS.md',
    why: 'a guard cell names a smoke section that does not exist',
    from: '| smoke §15 |',
    to: '| smoke \u00a799 |',
    want: 'guard "smoke \u00a799" does not resolve',
  },
  {
    id: 'M2',
    file: 'AGENTS.md',
    why: 'a numbered rule loses its row',
    from: '| 24 | unread-watermark | smoke §5 | driver scripts/one-off/2026-09-23-unread-card/mutate.mjs |\n',
    to: '',
    want: 'rule 24: no row in the rule→guard map',
  },
  {
    id: 'M3',
    file: 'AGENTS.md',
    why: 'a rule is renumbered, so every citation behind it means something else',
    from: '43. **Kiné has ONE ledger',
    to: '45. **Kiné has ONE ledger',
    want: 'numbered rules are',
  },
  {
    id: 'M4',
    file: 'AGENTS.md',
    why: "a rule's prose names a guard its rows omit",
    from: 'Kiné has ONE ledger, and it is',
    to: 'Kiné has ONE ledger (smoke §26), and it is',
    want: 'rule 43: prose names "smoke §26"',
  },
  {
    id: 'M5',
    file: 'AGENTS.md',
    why: 'the excused table loses a section',
    from: "| smoke §1 | the harness's own prerequisite",
    to: '| smoke \u00a70 | x',
    want: 'smoke §1: neither claimed by a rule nor listed as excused',
  },
  {
    id: 'M6',
    file: 'AGENTS.md',
    why: 'a citation loses its document name',
    from: '| smoke §27 — "the delivered/paid row expressions',
    to: '| \u00a727 — "the delivered/paid row expressions',
    want: 'names no document',
  },
  {
    id: 'M7',
    file: 'scripts/smoke.mjs',
    why: 'a CLAIMED smoke section is renamed away',
    from: '// ─── 22. Two shopping lists',
    to: '// ─── 22b. Two shopping lists',
    want: 'guard "smoke §22" does not resolve',
  },
  {
    id: 'M8',
    file: 'package.json',
    why: 'a declared audit: script is renamed, so the lookup must carry the prefix',
    from: '"audit:do-state": "node scripts/do-state-audit.mjs"',
    to: '"audit:do-state-x": "node scripts/do-state-audit.mjs"',
    want: 'guard "audit:do-state" does not resolve',
  },
]

// ── preflight: the clean tree must be GREEN, or a "caught" reading is noise ──
{
  const out = runAudit()
  if (!/clean —/.test(out)) {
    console.error('PREFLIGHT FAILED — the audit is red on the CLEAN tree:\n' + out)
    process.exit(2)
  }
  console.log('preflight ok — the audit is green on the tree as it stands\n')
}

let survived = 0
for (const m of mutations) {
  const original = normalized(m.file)
  const before = sha(m.file)
  if (!original.includes(m.from)) {
    console.log(`${m.id}  ANCHOR MISSING — ${m.from.slice(0, 60)}`)
    survived++
    continue
  }
  writeKeepingEol(m.file, original.replace(m.from, m.to))
  let out = ''
  try {
    out = runAudit()
  } finally {
    writeKeepingEol(m.file, original)
  }
  const restored = sha(m.file) === before
  const caught = out.includes(m.want)
  console.log(`${m.id}  caught=${caught ? 'YES' : 'NO '}  restored=${restored ? 'yes' : 'NO'}  (${m.why})`)
  if (caught && !restored) console.log(`    the fault was caught, but ${m.file} was NOT restored byte-for-byte`)
  if (!caught || !restored) survived++
}

console.log(survived === 0
  ? `\nall ${mutations.length} fault classes still go red under the audit; tree restored`
  : `\n${survived} mutation(s) survived — that fault class is no longer caught`)
process.exit(survived === 0 ? 0 : 1)
