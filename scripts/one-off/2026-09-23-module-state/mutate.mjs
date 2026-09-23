#!/usr/bin/env node
// ─── Module scope: proof that §24 can fail ───────────────────────────
// Falsification driver for the guards `npm run smoke` §24 grew on 2026-09-23.
// It extracts that section, mutates ONE thing at a time, and asks of each
// mutation: does the check that exists for it actually go red?
//
// Why this section needs one more than most. §24 is the only section that
// guards a CHECK rather than a behaviour, and the failure mode of such a guard
// is silence: a scan whose input empties (wrong folder, unresolvable
// typescript, a set of `SyntaxKind` NAMES compared against `node.kind` NUMBERS)
// reports a clean tree for the rest of the project's life. That exact bug was
// written and caught while the analyzer was being built, which is why M2 and M3
// exist — they attack the analyzer itself, and the section's own controls are
// what notice.
//
//   node scripts/one-off/2026-09-23-module-state/mutate.mjs [M1 M4 …]
//
// Needs NO running dev server: every §24 check is a source read plus an
// in-memory parse. Leaves the tree byte-identical, or it says so.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const root = new URL('../../../', import.meta.url)          // the repo root (Home/)
const smokeUrl = new URL('scripts/smoke.mjs', root).href

const read = (p) => readFileSync(new URL(p, root), 'utf8')
const write = (p, s) => writeFileSync(new URL(p, root), s)
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex')

// ── line endings ─────────────────────────────────────────────────────
// This working tree is a WINDOWS checkout: files on disk are CRLF while every
// anchor below is written with a plain \n. Matching raw bytes misses every
// multi-line anchor — and a missed anchor is a SKIPPED mutation, which changes
// no code and still exits 0. So anchors match a normalised copy and write back
// with the ending the file already had.
const normalized = (p) => read(p).replace(/\r\n/g, '\n')
function writeKeepingEol(p, text) {
  const crlf = read(p).includes('\r\n')
  write(p, crlf ? text.replace(/\n/g, '\r\n') : text)
}

// ── extract §24 out of the shipping suite ────────────────────────────
const smoke = normalized('scripts/smoke.mjs')
const start = smoke.indexOf('// ─── 24. no request data lives in module scope')
// The NEXT section banner, not `// ─── summary`: §25 was added after this one
// and slices into the same region, so ending at the summary would run §25's
// checks here without any of their bindings and die with
// `scanDoState is not defined` — which is a driver fault, not a section one.
const end = smoke.indexOf('// ─── 25. no request data parked on a DO')
if (start === -1 || end === -1) {
  console.error('could not find section 24 in scripts/smoke.mjs')
  process.exit(2)
}
// `import.meta` is not available inside the Function the section runs as, so the
// repo root travels in as a plain value instead.
const section = smoke.slice(start, end).replace(/import\.meta\.url/g, '__root')

let pass = 0
const failures = []
// Every check name that EXECUTED — red-only bookkeeping cannot tell a guard that
// held from one that never ran.
const ran = []
const log = () => {}
const ok = (name) => { pass++; ran.push(name) }
const bad = (name, detail) => { failures.push(name); ran.push(name); log(`      ✗ ${name} — ${detail}`) }
const check = (name, condition, detail = '') => { condition ? ok(name) : bad(name, detail || 'assertion failed') }

const runSectionBody = new Function(
  'log', 'ok', 'bad', 'check', 'readFileSync', 'URL', 'scanModuleState', 'formatFindings', '__root',
  `return (async () => {\n${section}\n})()`
)

/** Load the analyzer FRESH for every run: two of the mutations edit the
    analyzer itself, and a cached module would keep returning the old verdict —
    which is the same class of silent pass this driver exists to catch. */
async function run() {
  pass = 0
  failures.length = 0
  ran.length = 0
  const mod = await import(new URL('scripts/lib/module-state.mjs?run=' + Date.now(), root).href)
  await runSectionBody(log, ok, bad, check, readFileSync, URL, mod.scanModuleState, mod.formatFindings, smokeUrl)
  return { pass, failures: [...failures], ran: [...ran] }
}

// ── the mutations ────────────────────────────────────────────────────
const IDENTITY = 'src/identity.ts'
const ADMIN = 'src/routes/admin.tsx'
const ANALYZER = 'scripts/lib/module-state.mjs'

const REAL_TREE = 'no module-scope binding in src/ is written from inside a function'
const CONTROL = 'the scan notices a reassigned `let` and a mutated Map it is not currently looking at'
const HONEST = 'read-only module constants are not reported'
const PARAMETER = 'the provisioning password arrives as a parameter'
const NO_DEFAULT = '…with no default, so a caller cannot skip credentials by silence'
const CALL_SITES = 'both provisioning call sites state the password explicitly'
const INSTANCE_GONE = 'the module-level password field itself is gone'

const MUTATIONS = [
  {
    id: 'M1', file: IDENTITY,
    why: 'a module-level field is written from inside the provisioning function again',
    from: 'export async function ensureModuleAccounts(env: Env, user: HomeUser, password: string | null): Promise<ModuleAccounts> {',
    to: 'let probeCache: string | null = null\nexport async function ensureModuleAccounts(env: Env, user: HomeUser, password: string | null): Promise<ModuleAccounts> {\n  probeCache = password',
    expects: [REAL_TREE],
  },
  {
    id: 'M2', file: ANALYZER,
    why: 'the analyzer cannot tell a function body from module scope, so it finds nothing',
    from: '      const inside = inFunction || FUNCTION_KINDS.has(node.kind)',
    to: '      const inside = false',
    // The real tree goes GREEN here — it IS clean. Only the positive control
    // notices, which is exactly the point of having one.
    expects: [CONTROL],
  },
  {
    id: 'M3', file: ANALYZER,
    why: 'the analyzer reports any two-operand expression as a write, so read-only constants look guilty',
    from: '      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {',
    to: '      if (ts.isBinaryExpression(node)) {',
    expects: [HONEST, REAL_TREE],   // the real tree also reds: honest constants exist there too
  },
  {
    id: 'M4', file: IDENTITY,
    why: 'the password parameter grows a default, so a caller can skip credentials by silence',
    from: 'password: string | null): Promise<ModuleAccounts> {',
    to: 'password: string | null = null): Promise<ModuleAccounts> {',
    expects: [NO_DEFAULT],
  },
  {
    id: 'M5', file: ADMIN,
    why: 'the admin create path stops stating the password',
    from: 'try { await ensureModuleAccounts(c.env, res.user, password) } catch { /* repair path covers it */ }',
    to: 'try { await ensureModuleAccounts(c.env, res.user, null) } catch { /* repair path covers it */ }',
    expects: [CALL_SITES],
  },
  {
    id: 'M6', file: IDENTITY,
    why: 'the module-level password field comes back, unused for now',
    from: 'export async function ensureModuleAccounts(env: Env, user: HomeUser, password: string | null): Promise<ModuleAccounts> {',
    to: 'let lastPassword: string | null = null\nexport async function ensureModuleAccounts(env: Env, user: HomeUser, password: string | null): Promise<ModuleAccounts> {',
    // An unused module field is already a landmine the moment anything writes
    // it, so this shape is pinned by name; REAL_TREE stays green because this
    // mutation writes nothing.
    expects: [INSTANCE_GONE],
  },
]

// ── run ──────────────────────────────────────────────────────────────
const only = process.argv.slice(2)
const selected = only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS

const touched = new Set(selected.map((m) => m.file))
const original = new Map()
for (const f of touched) original.set(f, read(f))
const before = new Map([...touched].map((f) => [f, sha(f)]))

let restoreNeeded = false
const restore = () => {
  if (!restoreNeeded) return
  for (const [f, text] of original) write(f, text)
  restoreNeeded = false
}
for (const sig of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
  process.on(sig, () => { restore(); console.error('\nrestored after ' + sig); process.exit(130) })
}
process.on('uncaughtException', (e) => { restore(); console.error('uncaught: ' + e.message); process.exit(2) })

// preflight: the section is green on the untouched tree, and every check RAN.
const pre = await run()
const expectedNames = [REAL_TREE, CONTROL, HONEST, PARAMETER, NO_DEFAULT, CALL_SITES, INSTANCE_GONE]
const missing = expectedNames.filter((n) => !pre.ran.includes(n))
if (pre.failures.length || missing.length) {
  console.error('PREFLIGHT FAILED — the section is not green before any mutation.')
  if (pre.failures.length) console.error('  red: ' + pre.failures.join(' | '))
  if (missing.length) console.error('  never ran: ' + missing.join(' | '))
  console.error('  (a mutation left behind by an earlier crashed run looks exactly like this)')
  process.exit(2)
}
console.log(`preflight ok — ${pre.pass} checks green, all ${expectedNames.length} named checks ran\n`)

let caught = 0
for (const m of selected) {
  const text = normalized(m.file)
  if (!text.includes(m.from)) {
    console.log(`${m.id}  SKIPPED — anchor not found in ${m.file}`)
    console.log(`     ${m.from.slice(0, 90)}…`)
    continue
  }
  // Guard against a duplicate anchor silently mutating the wrong site.
  if (text.split(m.from).length - 1 > 1) {
    console.log(`${m.id}  SKIPPED — anchor appears more than once in ${m.file}`)
    continue
  }
  restoreNeeded = true
  writeKeepingEol(m.file, text.replace(m.from, m.to))

  const res = await run()
  const reds = m.expects.filter((n) => res.failures.includes(n))
  const unexpected = res.failures.filter((n) => !m.expects.includes(n))
  const good = reds.length === m.expects.length

  console.log(`${m.id}  ${good ? 'CAUGHT' : 'MISSED'}  ${m.why}`)
  console.log(`     ${res.pass} green, ${res.failures.length} red`)
  if (good) caught++
  if (!good) {
    console.log(`     expected red: ${m.expects.join(' | ')}`)
    console.log(`     actually red: ${res.failures.join(' | ') || '(none)'}`)
  }
  if (unexpected.length) console.log(`     cascade (legitimate, other checks): ${unexpected.length}`)

  restoreNeeded = false
  write(m.file, original.get(m.file))
}

// ── the tree must be exactly as we found it ──────────────────────────
let dirty = []
for (const [f, h] of before) if (sha(f) !== h) dirty.push(f)
console.log('')
if (dirty.length) {
  console.error('TREE NOT RESTORED: ' + dirty.join(', '))
  process.exit(2)
}
console.log(`restored: ${[...before.keys()].join(', ')} byte-identical`)
console.log(`\n${caught}/${selected.length} mutations caught.`)
process.exit(caught === selected.length ? 0 : 1)
