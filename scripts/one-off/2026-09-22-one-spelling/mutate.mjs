#!/usr/bin/env node
// ─── One spelling, through the HUMAN door ────────────────────────────
// Falsification driver for the guards §19 of `npm run smoke` grew on
// 2026-09-22. It extracts that section, mutates ONE code path at a time, and
// asks of each mutation: does the check that exists for it actually go red?
//
// Why the human door needed its own guards: a rename leaks through the phone's
// door and the browser's door in the same way, but only one of them was pinned
// (rule 33). The browser's `way_user_session` also lasts 30 days, so a session
// minted before a rename opens /ws with the OLD casing; the upgrade used to
// forward it verbatim, and the DO stamps that onto every chat row. Two failures
// come out of one spelling: the person's own bubbles render as somebody else's,
// and `notifyEvent` — whose source lookup was an EXACT match — finds no account,
// so the other phone never rings while /debug-notify reports a send.
//
// A note on what each layer is for, because two of them overlap on purpose:
//   * the socket canonicalization (N1) and the folded source lookup (N2) each
//     route a differently-spelled source on their own, so NEITHER the live stamp
//     check nor the ledger check goes red for a single revert — and that is
//     correct. N5 removes BOTH, which is the fault the ledger check exists for.
//
//   BASE_URL=http://127.0.0.1:8793 node scripts/one-off/2026-09-22-one-spelling/mutate.mjs [N1 N4 …]
//
// Needs a RUNNING dev server (`npm run dev`), the local seed accounts, and
// `ws` — loaded from the tree wrangler already ships, since the handshake
// accepts no credential other than a Cookie header (the global WebSocket
// cannot send one). Leaves the tree byte-identical, or it says so.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8793').replace(/\/$/, '')
const USER = process.env.SMOKE_USER || 'maxx'
const PASS = process.env.SMOKE_PASS || 'adminpass123'
const root = new URL('../../../', import.meta.url)          // the repo root (Home/)
const smokeUrl = new URL('scripts/smoke.mjs', root).href

const read = (p) => readFileSync(new URL(p, root), 'utf8')
const write = (p, s) => writeFileSync(new URL(p, root), s)
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex')

// ── line endings ─────────────────────────────────────────────────────
// This working tree is a WINDOWS checkout: files on disk are CRLF while every
// anchor below is written with a plain \n. Matching raw bytes missed every
// multi-line anchor in the sibling driver — and a missed anchor is a SKIPPED
// mutation, which changes no code and still exits 0. So anchors are matched on
// a normalised copy and written back with the ending the file already had.
const normalized = (p) => read(p).replace(/\r\n/g, '\n')
function writeKeepingEol(p, text) {
  const crlf = read(p).includes('\r\n')
  write(p, crlf ? text.replace(/\n/g, '\r\n') : text)
}

// ── extract §19 out of the shipping suite ────────────────────────────
const smoke = read('scripts/smoke.mjs')
const start = smoke.indexOf('// ─── 19. Diagnostics')
const end = smoke.indexOf('// ─── 20. the live share')
if (start === -1 || end === -1) {
  console.error('could not find section 19 in scripts/smoke.mjs')
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
const log = (...a) => console.log(...a)
const ok = (name) => { pass++; ran.push(name); log(`  \x1b[32m✓\x1b[0m ${name}`) }
const bad = (name, detail) => { failures.push(name); ran.push(name); log(`  \x1b[31m✗\x1b[0m ${name} \x1b[31m${detail}\x1b[0m`) }
const check = (name, condition, detail = '') => { condition ? ok(name) : bad(name, detail || 'assertion failed') }

const jar = new Map()
function absorb(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';')
    const i = pair.indexOf('=')
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
async function req(path, init = {}) {
  const res = await fetch(BASE + path, {
    redirect: 'manual', ...init,
    headers: { ...(init.headers || {}), ...(jar.size ? { Cookie: cookieHeader() } : {}) },
  })
  absorb(res)
  return res
}
const body = async (res) => await res.text()
const form = (fields) => new URLSearchParams(fields).toString()

/** Rewriting a source file makes the dev server RELOAD, and a request that lands
 *  mid-reload is reset rather than answered — which would read as a red check
 *  that has nothing to do with the mutation. Wait for the server first. */
async function settled(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await req('/login')
      if (res.status === 200) { await res.text(); return true }
    } catch (e) { /* still reloading */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

const runSection = new Function(
  'BASE', '__root', 'log', 'ok', 'bad', 'check', 'req', 'body', 'form',
  'readFileSync', 'createHmac', 'createRequire', 'URL', 'fetch', 'jar', 'USER', 'PASS',
  `return (async () => {\n${section}\n})()`
)
const run = () => runSection(
  BASE, smokeUrl, log, ok, bad, check, req, body, form,
  readFileSync, createHmac, createRequire, URL, fetch, jar, USER, PASS
)

// ── the mutations ────────────────────────────────────────────────────
const WORKER = 'src/way/worker.ts'
const DO = 'src/way/do/FleetDO.ts'
const SHARE = 'src/lib/share.ts'
const CHAT = 'public/chat/index.html'

const SOCKET_OK = '  forwarded.headers.set("X-WAY-Username", account?.username ?? session.username);'
const SOURCE_FOLDED = `      const wanted = sourceUsername.trim().toLowerCase();
      const source = cfg.users.find((u) => u.username.toLowerCase() === wanted);`

const MUTATIONS = [
  {
    id: 'N1', file: WORKER,
    why: 'the /ws upgrade hands the DO the token’s own casing again',
    from: SOCKET_OK,
    to: '  forwarded.headers.set("X-WAY-Username", session.username);',
    expects: [
      'a socket opened with the pre-rename casing still stamps the account’s own name',
      '…the socket resolves the ACCOUNT before it hands the DO a name',
    ],
  },
  {
    id: 'N2', file: DO,
    why: 'the push lookup is an exact match on the source name again',
    from: SOURCE_FOLDED,
    to: `      const source = cfg.users.find((u) => u.username === sourceUsername);`,
    // The live routing check stays GREEN here on purpose: the socket above it
    // canonicalizes first. This is the read-the-code half of that pair.
    expects: ['…the push lookup folds case on the SOURCE name'],
  },
  {
    id: 'N3', file: DO,
    why: 'the reaction toggle stops folding an old spelling onto the current one',
    from: `      const key = Object.keys(users).find((k) => k.toLowerCase() === reactor.toLowerCase()) ?? reactor;
      const previous = users[key];
      delete users[key];
      if (previous !== emoji) users[reactor] = emoji;`,
    to: `      const previous = users[reactor];
      if (previous === emoji) delete users[reactor];
      else users[reactor] = emoji;`,
    expects: ['…the reaction toggle collapses an old spelling onto the current one'],
  },
  {
    id: 'N4', file: SHARE,
    why: 'a share code is resolved by exact name again (both lookups)',
    from: 'WHERE lower(username) = lower(?1) ORDER BY CASE WHEN username = ?1 THEN 0 ELSE 1 END LIMIT 1',
    to: 'WHERE username = ?1',
    expects: ['…a share code minted for any casing resolves to the account'],
  },
  {
    id: 'N5', file: WORKER,
    why: 'PAIR fault: neither the socket nor the lookup folds, so the routing really does hit "no such user"',
    edits: [
      { file: WORKER, from: SOCKET_OK, to: '  forwarded.headers.set("X-WAY-Username", session.username);' },
      { file: DO, from: SOURCE_FOLDED, to: `      const source = cfg.users.find((u) => u.username === sourceUsername);` },
    ],
    expects: ['…and the chat it carried reaches the routing stage instead of "no such user"'],
  },
  {
    id: 'N6', file: CHAT,
    why: 'the chat page goes back to exact-name "mine", and to one reaction key',
    edits: [
      {
        file: CHAT,
        from: '        const isMine = !!currentUser && sameName(msg.sender, currentUser.username);',
        to: '        const isMine = currentUser && msg.sender === currentUser.username;',
      },
      {
        file: CHAT,
        from: `    const reactedAs = reactionUsers && myName
        ? Object.keys(reactionUsers).find(function(k) { return sameName(k, myName); }) || null
        : null;`,
        to: '    const reactedAs = myName;',
      },
    ],
    expects: ['…and the chat page folds names when it decides what is YOURS'],
  },
]

// ── apply / restore ──────────────────────────────────────────────────
const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }]
const touched = [...new Set(MUTATIONS.flatMap((m) => editsOf(m).map((e) => e.file)))]
const originals = new Map(touched.map((p) => [p, read(p)]))
const hashes = new Map(touched.map((p) => [p, sha(p)]))

/** Apply every edit of one mutation on the normalised copy, then write back.
 *  Returns the list of anchors that could NOT be applied: an anchor that no
 *  longer matches is a SKIPPED mutation, and a skip must never read as a catch. */
function applyMutation(m) {
  const misses = []
  for (const e of editsOf(m)) {
    const src = normalized(e.file)
    if (!src.includes(e.from)) { misses.push(`${e.file}: ${e.from.trim().slice(0, 60)}`); continue }
    const patched = src.split(e.from).join(e.to)
    writeKeepingEol(e.file, patched)
  }
  return misses
}
function restoreAll() {
  for (const [p, text] of originals) write(p, text)
}

// ── run ──────────────────────────────────────────────────────────────
const wanted = process.argv.slice(2)
const chosen = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS
if (!chosen.length) {
  console.error(`no such mutation. known: ${MUTATIONS.map((m) => m.id).join(', ')}`)
  process.exit(2)
}

const login = await req('/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form({ username: USER, password: PASS }),
})
if (login.status !== 302) {
  console.error(`could not sign in (${login.status}) — is the dev server up on ${BASE}?`)
  process.exit(2)
}

// ── preflight ────────────────────────────────────────────────────────
// A guard can only catch a fault if it RUNS and is GREEN on the clean tree. One
// that is already red, or that never executes, makes every verdict below
// meaningless while looking like a wall of catches.
const expected = [...new Set(chosen.flatMap((m) => m.expects))]
{
  pass = 0
  failures.length = 0
  ran.length = 0
  await settled()
  log('\n\x1b[1mpreflight — the section, unmutated:\x1b[0m')
  try {
    await run()
  } catch (err) {
    bad('section ran to completion', `threw: ${err && err.message}`)
  }
  const reds = [...new Set(failures)]
  const absent = expected.filter((name) => !ran.some((n) => n.startsWith(name)))
  if (reds.length || absent.length) {
    console.error('\x1b[31mpreflight: the section is not clean before any mutation, so the verdicts below would prove nothing.\x1b[0m')
    if (reds.length) console.error(`  already red: ${reds.join(' | ')}`)
    if (absent.length) console.error(`  never ran: ${absent.join(' | ')}`)
    restoreAll()
    process.exit(2)
  }
  log(`\x1b[32mpreflight clean\x1b[0m — ${pass} checks ran, ${expected.length} expected names present and green`)
}

// ── per-mutation runs ────────────────────────────────────────────────
const verdicts = []
for (const m of chosen) {
  log(`\n\x1b[1m${m.id}\x1b[0m \x1b[90m${m.why}\x1b[0m`)
  const misses = applyMutation(m)
  await settled()
  pass = 0
  failures.length = 0
  ran.length = 0
  try {
    await run()
  } catch (err) {
    bad('section ran to completion', `threw: ${err && err.message}`)
  }
  const reds = [...new Set(failures)]
  const seen = (name) => ran.some((n) => n.startsWith(name))
  const caughtBy = m.expects.filter((name) => reds.some((r) => r.startsWith(name)))
  const absent = m.expects.filter((name) => !seen(name))
  const okRun = misses.length === 0 && absent.length === 0 && caughtBy.length === m.expects.length
  if (misses.length) log(`  \x1b[31mSKIPPED anchor:\x1b[0m ${misses.join(' | ')}`)
  if (absent.length) log(`  \x1b[31mNOT RUN:\x1b[0m ${absent.join(' | ')}`)
  log(okRun
    ? `  \x1b[32mCAUGHT\x1b[0m by ${caughtBy.join(' | ')}`
    : `  \x1b[31mNOT CAUGHT\x1b[0m (expected all of: ${m.expects.join(' | ')})`)
  const others = reds.filter((r) => !m.expects.some((name) => r.startsWith(name)))
  if (others.length) log(`  \x1b[33mother reds in this run:\x1b[0m ${others.join(' | ')}`)
  verdicts.push({ id: m.id, ok: okRun, misses, absent, caughtBy, others })
  restoreAll()
  await settled()
}

// ── the tree must be exactly as it was found ─────────────────────────
let dirty = []
for (const p of touched) if (sha(p) !== hashes.get(p)) dirty.push(p)
if (dirty.length) {
  console.error(`\n\x1b[31mRESTORE FAILED\x1b[0m — put these back before trusting anything: ${dirty.join(', ')}`)
  process.exit(1)
}

const caught = verdicts.filter((v) => v.ok).length
log(`\n\x1b[1mmutation report\x1b[0m — ${caught}/${verdicts.length} caught`)
for (const v of verdicts) log(`  ${v.ok ? '\x1b[32mCAUGHT    \x1b[0m' : '\x1b[31mNOT CAUGHT\x1b[0m'} ${v.id}`)
log(caught === verdicts.length
  ? '\n\x1b[32mEvery mutation turned its own check red.\x1b[0m'
  : '\n\x1b[31mSome mutations changed nothing a guard could see.\x1b[0m')
process.exit(caught === verdicts.length ? 0 : 1)
