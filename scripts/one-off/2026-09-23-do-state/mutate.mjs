#!/usr/bin/env node
// ─── Durable Object state: proof that §25 can fail ───────────────────
// Falsification driver for the guards `npm run smoke` §25 grew on 2026-09-23.
// It extracts that section, mutates ONE thing at a time, and asks of each
// mutation: does the check that exists for it actually go red?
//
// Why §25 needs one more than most: the thing being guarded is an ANALYZER, and
// an analyzer's failure mode is a permanently green verdict. Three separate
// versions of that were written while building this pair of tools — a set of
// `SyntaxKind` NAMES compared against `node.kind` NUMBERS (module-state), a
// method's own parameters never seeded onto the scope stack, and that stack
// compared against names without being flattened. Each one made the scan report
// "clean" without reading a single function. M7 and M8 attack the analyzer
// directly for exactly that reason; M9 attacks the JSONC reader, whose failure
// would empty the Durable Object list this section checks.
//
//   node scripts/one-off/2026-09-23-do-state/mutate.mjs [M1 M4 …]
//
// Needs NO running dev server: every §25 check is a source read plus an
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

// ── extract §25 out of the shipping suite ────────────────────────────
const smoke = normalized('scripts/smoke.mjs')
const start = smoke.indexOf('// ─── 25. no request data parked on a DO')
const end = smoke.indexOf('// ─── summary')
if (start === -1 || end === -1) {
  console.error('could not find section 25 in scripts/smoke.mjs')
  process.exit(2)
}
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
  'log', 'ok', 'bad', 'check', 'readFileSync', 'URL',
  'scanDoState', 'formatDoFaults', 'stripJsonc', 'DO_STATE_POLICY', '__root',
  `return (async () => {\n${section}\n})()`
)

/** Load the analyzer FRESH every run: most mutations edit the analyzer itself,
    and a cached module would keep returning the old verdict — the same class of
    silent pass this driver exists to catch. */
async function run() {
  pass = 0
  failures.length = 0
  ran.length = 0
  const mod = await import(new URL('scripts/lib/do-state.mjs?run=' + Date.now(), root).href)
  await runSectionBody(
    log, ok, bad, check, readFileSync, URL,
    mod.scanDoState, mod.formatDoFaults, mod.stripJsonc, mod.DO_STATE_POLICY, smokeUrl
  )
  return { pass, failures: [...failures], ran: [...ran] }
}

// ── the check names, exactly as the section declares them ────────────
const ANALYZED = 'every Durable Object named in wrangler.jsonc is analyzed'
const UNDECLARED = 'no Durable Object instance field is undeclared'
const INTERLEAVE = 'no DO field carries request data across an interleaving point'
const WRONG_WRITE = 'every DO field is written only the way its declared kind allows'
const READERS = 'the diagnostics slot still decides nothing (its readers are declared)'
const REASON = 'every registry entry states a reason, not just a kind'
const NOTICES = 'the scan notices request data parked on `this` and read past an await'
const HONEST = '…and leaves a constructor handle, a database cache and a keyed map alone'
const JSONC = 'the jsonc reader keeps a URL value intact'

const FLEET = 'src/way/do/FleetDO.ts'
const LIB = 'scripts/lib/do-state.mjs'
const CONFIG = 'wrangler.jsonc'

const LASTNOTIFY = '  private lastNotify: { at: string; source: string; type: string; outcome: string } | null = null;'
const SQL_POLICY = "  'FleetDO.sql': {"
const FETCH_HEAD = '  async fetch(request: Request): Promise<Response> {\n    const url = new URL(request.url);'
const INGEST_TAIL = '      await this.handleIngest(body);\n      return new Response(null, { status: 204 });'
const INGEST_HEAD = '  private async handleIngest(body: IngestBody) {\n    const { ping, accuracy, altitude } = body;'
const GEOCACHE_POLICY = "  'FleetDO.geofenceCache': {\n    kind: 'db-cache',"
const ALLOWED_DBCACHE = "  'db-cache': ['db', 'invalidate'],"
const SQL_WHY = 'why: "the object\'s SQLite handle, captured once in the constructor",'
const SEED_PARAMS = 'if (member.body) walk(member.body, [paramsOf(member)])'
const JSONC_STRING = '    if (c === \'"\') { inString = true; out += c; continue }'
const LOBBY_BINDING = '{ "name": "LOBBY", "class_name": "Lobby" }'

const MUTATIONS = [
  {
    id: 'M1', why: 'request data is parked on `this` in fetch and read again past an await',
    edits: [
      // Declared as diagnostics WITH this reader so check 3 is the only thing
      // that can notice — the interleaving rule does not consult the registry.
      { file: LIB, from: SQL_POLICY, to: `  'FleetDO.probeSlot': {\n    kind: 'diagnostics',\n    readOnlyIn: ['fetch'],\n    why: 'a probe field the falsification driver parks request data on',\n  },\n${SQL_POLICY}` },
      { file: FLEET, from: LASTNOTIFY, to: `${LASTNOTIFY}\n  private probeSlot: string | null = null;` },
      { file: FLEET, from: FETCH_HEAD, to: `${FETCH_HEAD}\n    this.probeSlot = url.pathname;` },
      { file: FLEET, from: INGEST_TAIL, to: `      await this.handleIngest(body);\n      if (this.probeSlot) console.log('probe', this.probeSlot);\n      return new Response(null, { status: 204 });` },
    ],
    expects: [INTERLEAVE],
  },
  {
    id: 'M2', why: 'a new instance field arrives with nobody declaring what it is',
    edits: [{ file: FLEET, from: LASTNOTIFY, to: `${LASTNOTIFY}\n  private probeFlag = false;` }],
    expects: [UNDECLARED],
  },
  {
    id: 'M3', why: 'the geofence cache is declared a handle, so its database write is out of character',
    edits: [{ file: LIB, from: GEOCACHE_POLICY, to: "  'FleetDO.geofenceCache': {\n    kind: 'handle'," }],
    expects: [WRONG_WRITE],
  },
  {
    id: 'M4', why: 'the diagnostics slot gains a reader in another method',
    edits: [{ file: FLEET, from: INGEST_HEAD, to: `${INGEST_HEAD}\n    const probeLast = this.lastNotify;` }],
    expects: [READERS],
  },
  {
    id: 'M5', why: 'a registry entry stops stating a reason',
    edits: [{ file: LIB, from: SQL_WHY, to: 'why: "x",' }],
    expects: [REASON],
  },
  {
    id: 'M6', why: 'wrangler.jsonc names a Durable Object the source does not have',
    edits: [{ file: CONFIG, from: LOBBY_BINDING, to: '{ "name": "LOBBY", "class_name": "LobbyGone" }' }],
    expects: [ANALYZED],
  },
  {
    id: 'M7', why: 'the analyzer stops seeding a method’s own parameters, so request data reads as an unknown local',
    edits: [{ file: LIB, from: SEED_PARAMS, to: 'if (member.body) walk(member.body, [])' }],
    // Only the control notices. Check 5 goes green for the WRONG reason here —
    // with no request-classified writes it never runs — which is precisely what
    // the control is for.
    expects: [NOTICES],
  },
  {
    id: 'M8', why: 'the analyzer stops accepting a database cache, so honest object state looks guilty',
    edits: [{ file: LIB, from: ALLOWED_DBCACHE, to: "  'db-cache': []," }],
    expects: [HONEST, WRONG_WRITE],   // the real tree's two caches red the same rule
  },
  {
    id: 'M9', why: 'the jsonc reader stops tracking string literals, so a // inside a URL is eaten',
    edits: [{ file: LIB, from: JSONC_STRING, to: "    if (false) { inString = true; out += c; continue }" }],
    expects: [JSONC, ANALYZED],       // the config no longer parses, so the DO list empties too
  },
]

// ── run ──────────────────────────────────────────────────────────────
const only = process.argv.slice(2)
const selected = only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS
if (only.length && selected.length !== only.length) {
  console.error('unknown mutation id(s): ' + only.filter((id) => !MUTATIONS.some((m) => m.id === id)).join(', '))
  process.exit(2)
}

const touched = new Set()
for (const m of selected) for (const e of m.edits) touched.add(e.file)
const original = new Map([...touched].map((f) => [f, read(f)]))
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

// preflight: green on the untouched tree, and every check RUNS.
const pre = await run()
const expectedNames = [ANALYZED, UNDECLARED, INTERLEAVE, WRONG_WRITE, READERS, REASON, NOTICES, HONEST, JSONC]
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
  // Apply every edit in this mutation, refusing to guess at an ambiguous anchor.
  const working = new Map()
  let skip = null
  for (const e of m.edits) {
    const text = working.get(e.file) ?? normalized(e.file)
    const count = text.split(e.from).length - 1
    if (count === 0) { skip = `anchor not found in ${e.file}: ${e.from.slice(0, 70)}…`; break }
    if (count > 1) { skip = `anchor appears ${count}× in ${e.file}: ${e.from.slice(0, 70)}…`; break }
    working.set(e.file, text.replace(e.from, e.to))
  }
  if (skip) {
    console.log(`${m.id}  SKIPPED — ${skip}`)
    continue
  }

  restoreNeeded = true
  for (const [file, text] of working) writeKeepingEol(file, text)

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
  if (unexpected.length) console.log(`     cascade (legitimate, other checks): ${unexpected.length} — ${unexpected.join(' | ')}`)

  restoreNeeded = false
  for (const [f, text] of original) write(f, text)
}

// ── the tree must be exactly as we found it ──────────────────────────
const dirty = [...before].filter(([f, h]) => sha(f) !== h).map(([f]) => f)
console.log('')
if (dirty.length) {
  console.error('TREE NOT RESTORED: ' + dirty.join(', '))
  process.exit(2)
}
console.log(`restored: ${[...before.keys()].join(', ')} byte-identical`)
console.log(`\n${caught}/${selected.length} mutations caught.`)
process.exit(caught === selected.length ? 0 : 1)
