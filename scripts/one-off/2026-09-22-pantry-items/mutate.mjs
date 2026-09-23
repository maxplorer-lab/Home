#!/usr/bin/env node
// ─── one-off: does every NEW guard in this batch fail on its own fault? ───
//
// A guard that cannot go red is decoration. This batch added checks in TWO
// sections of scripts/smoke.mjs — §17 (the shell carrying an inner tab) and §22
// (one pantry item edited on its own, and the shape of the shelves on Home) — so
// this driver extracts BOTH and runs them together against a mutated tree, with
// the suite's own helpers, in ~6 seconds per mutation instead of ~3 minutes.
//
//   node scripts/one-off/2026-09-22-pantry-items/mutate.mjs          # all
//   node scripts/one-off/2026-09-22-pantry-items/mutate.mjs M3 M9    # a subset
//
// The extraction is the point: the code under test is the code that SHIPS in the
// suite, not a copy that can drift from it. Each mutation is a plain string
// replacement, each file's sha256 is checked before and after, and every mutation
// is restored in a `finally` — a driver that leaves a mutation behind would
// poison the next run. The rules this driver is built on (normalised line
// endings, preflight, NOT RUN and SKIPPED both failing the run) are the ones the
// earlier drivers paid for; see 2026-09-21-pantry-stock/mutate.mjs for the long
// form of why each of them exists.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8793').replace(/\/$/, '')
const USER = process.env.SMOKE_USER || 'maxx'
const PASS = process.env.SMOKE_PASS || 'adminpass123'
const root = new URL('../../../', import.meta.url)          // the repo root (Home/)
// The sections read their sources as `new URL('../' + p, import.meta.url)` — the
// path a file in scripts/ would use — so the extracted code is handed the URL of
// the very file it was cut from. Pointing it anywhere else reads every source as
// missing, and then every CODE guard is red for the same reason (a report that
// looks like a wall of catches and proves nothing).
const smokeUrl = new URL('scripts/smoke.mjs', root).href

const read = (p) => readFileSync(new URL(p, root), 'utf8')
const write = (p, s) => writeFileSync(new URL(p, root), s)
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex')

// A mutation left on disk poisons every later run — and the `finally` below only
// runs if the process is allowed to unwind. A closed pipe (piping this driver
// through `head`), Ctrl-C, or a hangup kills it with a file mid-mutation, which
// is exactly what happened once: app.js kept the M5 fault, the NEXT run's
// preflight went red on a clean-looking tree, and the fault looked like a guard
// bug. So the backups in flight are restored on any abnormal exit too.
const inFlight = []
function restoreInFlight() {
  for (const b of inFlight) { try { writeFileSync(new URL(b.file, root), b.text) } catch (e) { /* best effort */ } }
  inFlight.length = 0
}
for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
  process.on(signal, () => { restoreInFlight(); process.exit(130) })
}
process.on('uncaughtException', (err) => {
  restoreInFlight()
  console.error(`\n\x1b[31muncaught: ${err && err.message} — every mutation in flight was restored\x1b[0m`)
  process.exit(4)
})

// ── line endings ─────────────────────────────────────────────────────
// This working tree is a WINDOWS checkout: the files on disk are CRLF, while
// every anchor below is written with a plain \n. Matching raw bytes therefore
// misses multi-line anchors, and a missed anchor is a SKIPPED mutation that
// changed nothing and still exits 0. So anchors are matched against a normalised
// copy, the edit is applied there, and the file is written back with the ending
// it already had.
const normalized = (p) => read(p).replace(/\r\n/g, '\n')
function writeKeepingEol(p, text) {
  const crlf = read(p).includes('\r\n')
  write(p, crlf ? text.replace(/\n/g, '\r\n') : text)
}

// ── extract the two sections out of the shipping suite ───────────────
const smoke = read('scripts/smoke.mjs')
function cut(from, until) {
  const start = smoke.indexOf(from)
  const end = smoke.indexOf(until)
  if (start === -1 || end === -1 || end <= start) {
    console.error(`could not find "${from}" … "${until}" in scripts/smoke.mjs`)
    process.exit(2)
  }
  return smoke.slice(start, end)
}
// `import.meta` is not available inside the Function the sections run as, so the
// repo root travels in as a plain value instead.
const section = (
  cut('// ─── 17. Laoka inside the shell', '// ─── 18. One brand') +
  '\n' +
  cut('// ─── 22. Two shopping lists', '// ─── summary')
).replace(/import\.meta\.url/g, '__root')

let pass = 0
const failures = []
// Every check name that EXECUTED, pass or fail. Red-only bookkeeping cannot tell
// a guard that held from one that never ran: a walk that skipped, or an `expects`
// name that no longer exists, reads exactly like a caught mutation.
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

/** Pull one function body out by brace balance (the suite's own helper). */
function fnBody(src, name) {
  const at = src.indexOf(`function ${name}(`)
  if (at === -1) return null
  let i = src.indexOf('(', at)
  if (i === -1) return null
  let pdepth = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') pdepth++
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { i++; break } }
  }
  let open = src.indexOf('{', i)
  if (open === -1) return null
  for (;;) {
    if (!/[:|&]$/.test(src.slice(i, open).trimEnd())) break
    let depth = 0, j = open
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') { depth--; if (depth === 0) break }
    }
    let k = j + 1
    while (k < src.length && /\s/.test(src[k])) k++
    const next = src.indexOf('{', k)
    if (next === -1) return null
    open = next
  }
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1) }
  }
  return null
}
// §17 reads the tab bar's markup through the suite's own helper, so it travels in
// as a real function — cut from the same file, never re-typed here.
const tabBarHtml = new Function(
  'html', `return (function tabBarHtml(html) ${fnBody(smoke, 'tabBarHtml')})(html)`)

/** A request that survives the dev server reloading underneath it: rewriting a
 *  source file makes wrangler reload, and a fetch landing mid-reload is RESET.
 *  Losing a driver to that tells us nothing about the guard. */
async function tryReq(path, init) {
  for (let i = 0; i < 30; i++) {
    try { return await req(path, init) }
    catch (e) { await new Promise((r) => setTimeout(r, 500)) }
  }
  return null
}
async function settled(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await req('/login')
      if (res.status === 200) { await res.text(); return true }
    } catch (e) { /* still reloading */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** The trip half of §22 needs SOMETHING to buy and NO trip in progress. Both are
 *  state, and mutations can change it, so every run starts from a prepared pantry
 *  and puts back whatever this changed. */
async function preparePantry() {
  await settled()
  const cleared = await tryReq('/laoka/api/pantry/trip/clear', { method: 'POST' })
  if (!cleared) { log('  \x1b[33m· the dev server did not come back; skipping the state reset\x1b[0m'); return null }
  const pantryState = await tryReq('/laoka/api/pantry')
  if (!pantryState) { log('  \x1b[33m· no pantry state to read; skipping the state reset\x1b[0m'); return null }
  const state = JSON.parse(await body(pantryState))
  if ((state.toBuy || []).length) return null
  const items = []
  for (const g of state.pantry || []) for (const s of g.subgroups || []) for (const it of s.items || []) items.push(it)
  const first = items.find((it) => it.stock !== null && it.stock !== undefined)
  if (!first) return null
  const before = { id: first.id, stock: first.stock, stockMin: first.stockMin }
  await tryReq(`/laoka/api/pantry/items/${first.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stock: Math.max(0, Number(first.stockMin) - 1) }),
  })
  log(`  \x1b[90m· counted “${first.name}” below its level so the trip half has something to buy\x1b[0m`)
  return before
}
async function restorePrepared(prepared) {
  if (!prepared) return
  await tryReq(`/laoka/api/pantry/items/${prepared.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stock: prepared.stock, stockMin: prepared.stockMin }),
  })
}

// ── the mutations ────────────────────────────────────────────────────
// Each is a plausible next edit, not a synthetic corruption: the field a
// reviewer would drop while "simplifying", the check a reviewer would consider
// redundant, the value they would hardcode. `expects` is the check that MUST go
// red, by name (a prefix is enough).
const PANTRY = 'src/laoka/routes/pantry.js'
const QUERIES = 'src/laoka/data/queries.js'
const APPJS = 'public/laoka/app.js'
const DASH = 'src/routes/dashboard.tsx'
const SHELL = 'src/views/shell.tsx'

const MUTATIONS = [
  // ── ONE item, edited on its own ──
  {
    id: 'M1', file: PANTRY,
    why: 'the item route stops reading the name it was sent',
    from: '      if (body.name !== undefined) {',
    to: '      if (false) {',
    expects: ['a pantry item can be renamed, and filed under another pantry category',
      'renaming an item leaves its count and its level alone'],
  },
  {
    id: 'M2', file: PANTRY,
    why: 'the item route stops asking whether the destination is a PANTRY category',
    from: "        if (!await isPantryCategory(ctx.env, subgroupId)) return fail(400, 'no such pantry category');\n",
    to: '',
    expects: ['a pantry item can be renamed, and filed under another pantry category',
      'and a pantry item cannot be filed under a MEAL group'],
  },
  {
    id: 'M3', file: QUERIES,
    why: 'a rename carries a count nobody sent, so it wipes what is on the shelf',
    from: "  if (fields.name !== undefined) {\n    sets.push('name = ?' + (binds.length + 1));\n    binds.push(fields.name);\n  }",
    to: "  if (fields.name !== undefined) {\n    sets.push('name = ?' + (binds.length + 1));\n    binds.push(fields.name);\n    sets.push('stock = NULL');\n  }",
    expects: ['renaming an item leaves its count and its level alone'],
  },
  {
    id: 'M4', file: QUERIES,
    why: 'the edit stops writing the category, so an item can never be re-filed',
    from: "  if (fields.subgroupId !== undefined) {\n    sets.push('subgroup_id = ?' + (binds.length + 1));\n    binds.push(fields.subgroupId);\n  }\n",
    to: '',
    expects: ['an edit writes only the fields it was given, so a rename cannot wipe a count',
      'moving an item files it under the shelf it was sent to, count intact'],
  },
  {
    id: 'M5', file: APPJS,
    why: "the row's ✏️ edits the CATEGORY again, which is the whole bug this replaced",
    from: "  row.appendChild(h('button', { class: 'icon', title: 'Edit this item', text: '✏️', onclick: function () { editPantryItem(item); } }));",
    to: "  row.appendChild(h('button', { class: 'icon', title: 'Edit this item', text: '✏️', onclick: function () { editPantryCategory(item); } }));",
    expects: ['each pantry row edits and removes its OWN item, never the category'],
  },
  {
    id: 'M6', file: APPJS,
    why: 'the item sheet goes back to counts only',
    from: "  var fields = [\n    { name: 'name', label: 'Name', value: item.name, required: true }\n  ];",
    to: '  var fields = [];',
    expects: ['the item sheet carries the name and the category, not counts only'],
  },

  // ── the shape of the shelves, on Home ──
  {
    id: 'M7', file: DASH,
    why: 'the dashboard card stops asking the pantry and shows a plausible zero',
    from: '    pantry = await pantrySummary({ DB: c.env.LAOKA_DB })',
    to: '    pantry = { items: 0, categories: 0, toBuy: 0 }',
    expects: ["and its numbers are the pantry screen's own, not a second count"],
  },
  {
    id: 'M8', file: DASH,
    why: 'the pantry card stops carrying the tab, so it opens the week plan',
    from: '        <a href="/laoka/?tab=pantry" class="flex items-center gap-2 -mb-0.5 active:scale-[0.99] transition-transform">',
    to: '        <a href="/laoka/" class="flex items-center gap-2 -mb-0.5 active:scale-[0.99] transition-transform">',
    expects: ["Home's dashboard ends on a pantry card that opens the pantry itself"],
  },

  // ── an inner tab, reached by URL ──
  {
    id: 'M9', file: SHELL,
    why: 'the shell stops carrying ?tab into the frame at all',
    from: '  const src = innerTab ? `${mod.src}?tab=${innerTab}` : mod.src',
    to: '  const src = mod.src',
    expects: ['a link can open an inner tab of a module, not just the module'],
  },
  {
    id: 'M10', file: SHELL,
    why: 'the shell reflects whatever the address bar held into the frame URL',
    from: '  const innerTab = typeof tab === \'string\' && /^[a-z]{1,20}$/.test(tab) ? tab : null',
    to: '  const innerTab = typeof tab === \'string\' ? tab : null',
    expects: ['the shell drops'],
  },
  {
    id: 'M11', file: APPJS,
    why: 'the module stops honouring the tab it was opened with',
    from: 'if (NAV[n][0] === wanted) { state.tab = wanted; break; }',
    to: 'if (false) { state.tab = wanted; break; }',
    expects: ['and the module reads the tab it was opened with'],
  },
]

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

// NOTE the parameter names: the extracted sections read their sources as
// `new URL('../' + p, __root)`, so the repo-root value has to arrive bound to
// `__root`; `jar` travels in as the map itself, because §22 parks and restores
// the cookie jar to ask the pantry what an ANONYMOUS caller gets.
const runSection = new Function(
  'BASE', '__root', 'log', 'ok', 'bad', 'check', 'req', 'body', 'form', 'fnBody', 'tabBarHtml',
  'readFileSync', 'URL', 'fetch', 'jar',
  `return (async () => {\n${section}\n})()`
)

// ── preflight ────────────────────────────────────────────────────────
// A guard can only catch a fault if it RUNS and is GREEN on the clean tree. One
// already red, or one that never executes (a walk that skipped reports nothing),
// makes every verdict below meaningless while looking exactly like a wall of
// catches. So all expected checks are exercised once, unmutated, first.
{
  const expected = [...new Set(chosen.flatMap((m) => m.expects))]
  pass = 0
  failures.length = 0
  ran.length = 0
  const prepared = await preparePantry()
  try {
    await runSection(BASE, smokeUrl, log, ok, bad, check, req, body, form, fnBody, tabBarHtml, readFileSync, URL, fetch, jar)
  } catch (err) {
    bad('section ran to completion', `threw: ${err && err.message}`)
  } finally {
    await restorePrepared(prepared)
    await settled()
  }
  const reds = [...new Set(failures)]
  const absent = expected.filter((name) => !ran.some((n) => n.startsWith(name)))
  if (reds.length || absent.length) {
    console.error('\x1b[31mpreflight: the sections are not clean before any mutation, so the verdicts below would prove nothing.\x1b[0m')
    for (const f of reds) console.error(`  \x1b[31m✗\x1b[0m ${f}`)
    for (const a of absent) console.error(`  \x1b[33m· never ran:\x1b[0m ${a}`)
    console.error('Fix the tree (or the expectation) first — nothing was mutated.')
    process.exit(2)
  }
  log(`\x1b[32mpreflight: ${expected.length} expected check(s) ran, and all were green on the clean tree.\x1b[0m`)
}

const results = []
for (const m of chosen) {
  const edits = [{ file: m.file, from: m.from, to: m.to }].concat(m.also || [])
  const backups = edits.map((e) => ({ file: e.file, text: read(e.file), sha: sha(e.file) }))
  inFlight.length = 0
  inFlight.push(...backups)
  const missing = edits.find((e) => !normalized(e.file).includes(e.from))
  if (missing) {
    results.push({ id: m.id, verdict: 'SKIPPED — anchor missing' })
    log(`\x1b[33m${m.id}\x1b[0m could not be applied: anchor missing in ${missing.file}`)
    continue
  }
  log(`\n\x1b[1m${m.id}\x1b[0m ${m.why}`)
  pass = 0
  failures.length = 0
  ran.length = 0
  const prepared = await preparePantry()
  try {
    for (const e of edits) writeKeepingEol(e.file, normalized(e.file).replace(e.from, e.to))
    // Writing a file makes the dev server RELOAD, and the section's very first
    // fetches then land mid-reload: `/laoka/index.html` came back without its
    // embed block for one run (M5), which turned four §17 checks red for a reason
    // that had nothing to do with the mutation, and then threw `fetch failed`.
    // Wait for the watcher to be done before believing anything the section says.
    await settled()
    await new Promise((r) => setTimeout(r, 1200))
    await settled()
    await runSection(BASE, smokeUrl, log, ok, bad, check, req, body, form, fnBody, tabBarHtml, readFileSync, URL, fetch, jar)
  } catch (err) {
    bad('section ran to completion', `threw: ${err && err.message}`)
  } finally {
    for (const b of backups) write(b.file, b.text)
    inFlight.length = 0
    for (const b of backups) {
      if (sha(b.file) !== b.sha) {
        console.error(`\x1b[31mRESTORE FAILED for ${b.file} — fix this before anything else\x1b[0m`)
        process.exit(3)
      }
    }
    await restorePrepared(prepared)
  }

  const unique = [...new Set(failures)]
  const hit = m.expects.every((name) => unique.some((f) => f.startsWith(name)))
  const extra = unique.filter((f) => !m.expects.some((name) => f.startsWith(name)))
  // An expected check that never executed cannot have caught anything: the walk
  // it lives in skipped, or the name no longer exists in the suite. Reported as
  // NOT RUN and counted as a failure, never as a quiet pass.
  const unrun = m.expects.filter((name) => !ran.some((n) => n.startsWith(name)))
  const verdict = unrun.length
    ? `NOT RUN — ${unrun[0].slice(0, 60)}`
    : hit ? (extra.length ? `RED +${extra.length} extra` : 'RED — own check only') : 'GREEN — not caught'
  results.push({ id: m.id, verdict, extra })
  log(`  \x1b[90m${unique.length} red: ${unique.map((f) => f.split(' —')[0]).join(' | ') || '(none)'}\x1b[0m`)
  if (unrun.length) {
    log(`  \x1b[31m▲ NOT caught — the check it should turn red never ran: ${unrun.join('; ')}\x1b[0m`)
  } else {
    log(hit ? '  \x1b[32m▲ mutation caught\x1b[0m' : '  \x1b[31m▲ NOT caught\x1b[0m')
  }
  if (!(await settled())) log('  \x1b[31mthe dev server did not come back after the restore\x1b[0m')
  await new Promise((r) => setTimeout(r, 400))
}

// The driver restores CODE, not DATA: a mutation that strands a pantry trip
// (M3's wiped count can leave a to-buy line, and the suite's own walks price
// things) hands the next run a pantry mid-trip. One clear writes it off.
await tryReq('/laoka/api/pantry/trip/clear', { method: 'POST' })
if ((await body(await tryReq('/laoka/api/pantry')) || '').includes('"trip":{"id"')) {
  log('\x1b[33m· a pantry trip is still in progress after the run — clear it in Laoka → Pantry\x1b[0m')
}

log('\n── mutation report ────────────────────────────')
for (const r of results) {
  const colour = r.verdict.startsWith('RED') ? '32' : r.verdict.startsWith('GREEN') ? '31' : '33'
  log(`  \x1b[${colour}m${r.verdict.padEnd(22)}\x1b[0m ${r.id}`)
}
const uncaught = results.filter((r) => r.verdict.startsWith('GREEN')).length
const unrun = results.filter((r) => r.verdict.startsWith('NOT RUN')).length
// A skipped anchor changes NO code, so it proves nothing either — it fails the
// run the same way an uncaught fault does, instead of hiding in the report.
const skipped = results.filter((r) => r.verdict.startsWith('SKIPPED')).length
if (uncaught || unrun || skipped) {
  log(`\n\x1b[31m${uncaught} guard(s) did not catch their own fault${unrun ? `, ${unrun} never ran` : ''}${skipped ? `, ${skipped} anchor(s) missing (nothing was changed)` : ''}\x1b[0m`)
} else {
  log('\n\x1b[32mEvery mutation turned its own check red.\x1b[0m')
}
