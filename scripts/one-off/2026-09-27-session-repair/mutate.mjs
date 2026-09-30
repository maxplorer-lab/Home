#!/usr/bin/env node
// ─── Session repair: proof that smoke §8 can fail ──────────────────────
// Falsification driver for the retry mechanics the one repair rule
// (`src/lib/session-repair.ts`) and its module-API adapter (`withRepair` in
// `src/index.tsx`) own. smoke §8 grew the assertions these exist for on
// 2026-09-27, when the three repair sites became one rule with three
// adapters:
//
//   M1  the fresh cookie is joined into the retry's Cookie header with ", "
//       instead of "; " — the header stops being readable by cookie parsers,
//       so the retry is still signed out and the leg never reaches 200.
//   M2  the fresh Set-Cookie is appended and THEN deleted — Headers.delete
//       removes EVERY Set-Cookie, so the repair happens server-side and the
//       browser is handed nothing.
//
// Why each needs a guard of its own. M1 is invisible to a suite that only
// ever proved "the first request succeeded" (a retried 401 is still a
// response); M2 is invisible even to "the request succeeded", because the
// server-side repair did happen — it is the transaction with the BROWSER
// that breaks. smoke §8 therefore reports the status AND hands the cookie back on
// the wire AND replays it alone, so a broken join reds the first assertion
// and a lost cookie reds the delivery one.
//
//   node scripts/one-off/2026-09-27-session-repair/mutate.mjs
//
// Needs a RUNNING dev server (`npm run dev`), because smoke §8 reads live HTTP
// behaviour rather than sources — set BASE_URL (default
// http://127.0.0.1:8787), SMOKE_USER / SMOKE_PASS for a non-default account.
// It runs the whole suite per mutation, so allow ~2× a normal run. Each
// mutation is first confirmed LIVE with its own probe (wrangler rebuilds on
// a src change, and a suite run against the previous build would report a
// MISSED mutation that was never tried). Leaves the tree byte-identical, or
// it says so.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../../../', import.meta.url)          // the repo root (Home/)
const rootPath = fileURLToPath(root)
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const write = (p, s) => writeFileSync(new URL(p, root), s)
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex')

// ── line endings ─────────────────────────────────────────────────────
// This working tree is a WINDOWS checkout: files on disk may be CRLF while
// every anchor below is written with a plain \n. Matching raw bytes misses
// the anchor — and a missed anchor is a SKIPPED mutation, which changes no
// code and still exits 0. So anchors match a normalised copy and write back
// with the ending the file already had.
const normalized = (p) => read(p).replace(/\r\n/g, '\n')
function writeKeepingEol(p, text) {
  const crlf = read(p).includes('\r\n')
  write(p, crlf ? text.replace(/\n/g, '\r\n') : text)
}

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')
const USER = process.env.SMOKE_USER || 'maxx'
const PASS = process.env.SMOKE_PASS || 'adminpass123'

/** One module leg with ONLY a Home session in the Cookie header — the jar smoke §8
 * builds. */
const leg = (path, session) =>
  fetch(BASE + path, { redirect: 'manual', headers: { Cookie: 'home_session=' + session } })

/** A live Home session, taken the way the suite takes one. */
async function homeSession() {
  try {
    const res = await fetch(BASE + '/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: USER, password: PASS }).toString(),
    })
    const pair = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('home_session='))
    return pair ? pair.split(';')[0].slice('home_session='.length) : null
  } catch {
    return null
  }
}

const mutations = [
  {
    id: 'M1',
    file: 'src/lib/session-repair.ts',
    why: 'the retry joins its Cookie header with ", " instead of "; "',
    guard: 'repairs from home_session alone',
    from: "retryRequest.headers.set('Cookie', prior ? prior + '; ' + pair : pair)",
    to: "retryRequest.headers.set('Cookie', prior ? prior + ', ' + pair : pair)",
    // LIVE when a Home-session-only leg is refused: the retry's cookie header
    // is unreadable, so the module never sees the fresh session.
    probe: async (session) => (await leg('/way/api/devices', session)).status === 401,
  },
  {
    id: 'M2',
    file: 'src/index.tsx',
    why: 'the fresh Set-Cookie is appended and then deleted, so the browser is handed nothing',
    guard: 'hands the browser the fresh',
    from: "  out.headers.delete('Set-Cookie')\n  out.headers.append('Set-Cookie', plan.setCookie)",
    to: "  out.headers.append('Set-Cookie', plan.setCookie)\n  out.headers.delete('Set-Cookie')",
    // LIVE when the leg succeeds WITHOUT delivering a cookie: the repair
    // happened, the Set-Cookie is gone.
    probe: async (session) => {
      const res = await leg('/way/api/devices', session)
      return res.status === 200 && (res.headers.getSetCookie?.() ?? []).length === 0
    },
  },
]

/** Wait for the dev server to serve the mutation — a src change is rebuilt
 * asynchronously, and a suite run against the previous build would report a
 * MISSED mutation that was never tried.
 *
 * The login is INSIDE the loop on purpose: a reload window can refuse the
 * POST that mints the Home session, and a single attempt that lands in that
 * window reads as "the mutation never went live" — which is exactly what
 * happened the first time this driver ran. */
async function waitForProbe(m) {
  for (let i = 0; i < 60; i++) {
    const session = await homeSession()
    if (session) {
      try {
        if (await m.probe(session)) return true
      } catch { /* mid-reload: the next attempt re-logs in */ }
    }
    sleepMs(1000)
  }
  return false
}

function runSuite() {
  try {
    return execSync('npm run smoke', {
      cwd: rootPath, encoding: 'utf8', timeout: 600000,
      env: { ...process.env, BASE_URL: BASE },
    })
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '')
  }
}

// ── preflight: the probe distinguishes the clean tree from each mutation ──
{
  const session = await homeSession()
  if (!session) {
    console.error('PREFLIGHT FAILED — could not log in; is the dev server running?')
    process.exit(2)
  }
  for (const m of mutations) {
    if (await m.probe(session)) {
      console.error(`PREFLIGHT FAILED — ${m.id}'s probe fires on the CLEAN tree (${m.why})`)
      process.exit(2)
    }
  }
  console.log('preflight ok — the server is up and neither probe fires unmutated\n')
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
    if (!(await waitForProbe(m))) {
      console.log(`${m.id}  NOT LIVE — the dev server never served the mutated build, so no suite ran`)
      survived++
      continue
    }
    out = runSuite()
  } finally {
    writeKeepingEol(m.file, original)
  }
  const restored = sha(m.file) === before
  const red = out.includes('✗') && new RegExp(`✗[^\\n]*${m.guard}`).test(out)
  console.log(`${m.id}  caught=${red ? 'YES' : 'NO '}  restored=${restored ? 'yes' : 'NO'}  (${m.why})`)
  if (!red || !restored) survived++
}

console.log(survived === 0
  ? '\nboth retry mechanics are guarded by smoke §8; tree restored'
  : `\n${survived} mutation(s) survived — a guard is decoration`)
process.exit(survived === 0 ? 0 : 1)
