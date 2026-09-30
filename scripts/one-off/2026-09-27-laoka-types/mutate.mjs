#!/usr/bin/env node
// ─── The JavaScript type pass: proof that it can fail ────────────
// Falsification driver for `npm run audit:laoka-types`
// (scripts/lib/laoka-types.mjs), which the suite runs as smoke §29. The pass
// answers one question — does every `.js` file under `src/` typecheck under its
// one declared relaxation? — and it is the easiest scanner in this repo to
// disarm, for two reasons:
//
//   * its checked set is a WALK of src/, not a list of paths, so the question
//     "did it really look at the file I just added?" is worth asking with a
//     file that did not exist a second ago; and
//   * the flags it does not want are the ones it INHERITS from tsconfig.json,
//     so a pass that has been quietly loosened (strictNullChecks off to hide a
//     fault) would print a clean tree forever.
//
// Each mutation is applied to the real tree, the audit is run, and the tree is
// put back:
//
//   M1  a fixed fault comes back (a caught value read as an Error)
//   M2  a NEW .js file under src/, with a fault, is caught by the walk
//   M3  the pass is loosened past its pin — refused, not trusted
//   M4  the map's guard stops resolving when the audit script is renamed
//
//   node scripts/one-off/2026-09-27-laoka-types/mutate.mjs
//
// M4 runs the rule→guard audit instead, because it is the one that watches the
// declaration: rule 45's row names `audit:laoka-types`, and a rename that leaves
// the docs promising a script the repo no longer has must go red too.
//
// It needs no dev server and no database: both audits read files only, so this
// driver belongs in CI's `guards` job beside the others. Leaves the tree
// byte-identical, or it says so.

import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
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

function run(command) {
  try {
    return execSync(command, { cwd: rootPath, encoding: 'utf8' })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

const AUDIT = 'node scripts/laoka-types-audit.mjs'
const MAP = 'node scripts/rule-guards-audit.mjs'

// A file that has never existed, with one fault of the class the pass exists
// for: the CAUGHT value is `unknown` under `strict`, so `.message` cannot be
// read off it. (A parameter would not do — untyped parameters are the one thing
// this pass relaxes, so reading `.message` off one reports nothing.)
const STRAY_FILE = 'src/__laoka-types-driver__.js'
const STRAY_TEXT = 'export function read(fn) { try { return fn(); } catch (err) { return err.message; } }\n'

const mutations = [
  {
    id: 'M1',
    file: 'src/laoka/index.js',
    why: 'a fixed fault comes back (a caught value read as an Error)',
    from: "'request failed: ' + (messageOf(err) || 'unknown error')",
    to: "'request failed: ' + (err && err.message ? err.message : 'unknown error')",
    command: AUDIT,
    want: 'TS2339',
  },
  {
    id: 'M2',
    file: STRAY_FILE,
    why: 'a NEW .js file under src/, with a fault, is caught by the walk',
    create: true,
    createWith: STRAY_TEXT,
    command: AUDIT,
    want: `__laoka-types-driver__`,
  },
  {
    id: 'M3',
    file: 'scripts/lib/laoka-types.mjs',
    why: 'the pass is loosened past its pin — refused, not trusted',
    from: 'return { ...parsed.options, checkJs: true, noImplicitAny: false }',
    to: 'return { ...parsed.options, checkJs: true, noImplicitAny: false, strictNullChecks: false }',
    command: AUDIT,
    want: 'strictNullChecks: false — the declared set says true',
  },
  {
    id: 'M4',
    file: 'package.json',
    why: "the map's guard stops resolving when the audit script is renamed",
    from: '"audit:laoka-types": "node scripts/laoka-types-audit.mjs"',
    to: '"audit:laoka-types-x": "node scripts/laoka-types-audit.mjs"',
    command: MAP,
    want: 'rule 45: guard "audit:laoka-types" does not resolve',
  },
]

// ── preflight: both audits must be GREEN on the clean tree ────────
for (const [label, command] of [['laoka types', AUDIT], ['rule guards', MAP]]) {
  const out = run(command)
  if (!/clean —/.test(out)) {
    console.error(`PREFLIGHT FAILED — the ${label} audit is red on the CLEAN tree:\n` + out)
    process.exit(2)
  }
}
console.log('preflight ok — both audits are green on the tree as it stands\n')

let survived = 0
for (const m of mutations) {
  const created = Boolean(m.create)
  let original = null
  let before = null
  try {
    if (created) {
      if (existsSync(new URL(m.file, root))) {
        console.log(`${m.id}  STRAY FILE ALREADY EXISTS — ${m.file}`)
        survived++
        continue
      }
      write(m.file, m.createWith)
    } else {
      original = normalized(m.file)
      before = sha(m.file)
      if (!original.includes(m.from)) {
        console.log(`${m.id}  ANCHOR MISSING — ${m.from.slice(0, 60)}`)
        survived++
        continue
      }
      writeKeepingEol(m.file, original.replace(m.from, m.to))
    }
    const out = run(m.command)
    const caught = out.includes(m.want)
    console.log(`${m.id}  caught=${caught ? 'YES' : 'NO '}  (${m.why})`)
    if (!caught) survived++
  } finally {
    if (created) rmSync(new URL(m.file, root), { force: true })
    else if (original !== null) writeKeepingEol(m.file, original)
    if (!created && original !== null) {
      const restored = sha(m.file) === before
      if (!restored) {
        console.log(`    ${m.file} did NOT come back byte-for-byte`)
        survived++
      }
    }
  }
}

const strayLeft = existsSync(new URL(STRAY_FILE, root))
if (strayLeft) {
  console.log(`\n${STRAY_FILE} was left behind — remove it by hand`)
  process.exit(1)
}

console.log(survived === 0
  ? `\nall ${mutations.length} fault classes still go red; tree restored`
  : `\n${survived} mutation(s) survived — that fault class is no longer caught`)
process.exit(survived === 0 ? 0 : 1)
