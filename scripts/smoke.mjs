#!/usr/bin/env node
// ─── Home smoke test ─────────────────────────────────────────────
// End-to-end local checks against a RUNNING wrangler dev server.
// No test framework, no dependencies — plain Node 18+ (fetch/getSetCookie).
//
//   npm run dev                 # in one terminal (or the detached recipe)
//   npm run smoke               # in another
//
//   BASE_URL=http://127.0.0.1:8793 npm run smoke      # non-default port
//   SMOKE_USER=... SMOKE_PASS=... npm run smoke       # non-default account
//
// The defaults are the LOCAL DEV seed accounts created once via /bootstrap
// (see the run doc) — they are meaningless in production. Whatever account
// you pass must be an ADMIN, because the admin-console check needs it.
//
// What it proves, in order:
//   1. the Worker boots and serves the login page
//   2. ONE login mints ALL module session cookies
//   3. every tab (Sompitra pages + the WAY/Laoka/Chat shells) answers 200
//   4. every module API answers 200 through the same cookie jar
//   5. the chrome is consistent: real brand icons on EVERY tab, no emoji
//   6. the modules are session-gated (anonymous access redirects to /login)
//   7. bad credentials are rejected AND set no cookie
//   8. a jar holding ONLY home_session self-repairs on every module
// Exit code 0 = all green, 1 = something regressed.

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')
const USER = process.env.SMOKE_USER || 'maxx'
const PASS = process.env.SMOKE_PASS || 'adminpass123'
const ADMIN = process.env.SMOKE_ADMIN !== '0'   // set SMOKE_ADMIN=0 to skip /admin

let pass = 0
const failures = []
const log = (...a) => console.log(...a)

function ok(name, extra = '') {
  pass++
  log(`  \x1b[32m✓\x1b[0m ${name}${extra ? ` \x1b[90m${extra}\x1b[0m` : ''}`)
}
function bad(name, detail) {
  failures.push(`${name} — ${detail}`)
  log(`  \x1b[31m✗\x1b[0m ${name} \x1b[31m${detail}\x1b[0m`)
}
function check(name, condition, detail = '') {
  // `detail` is shown only on failure — a ✓ line with stale text reads as
  // a contradiction ("✓ labelled correctly … label missing").
  condition ? ok(name) : bad(name, detail || 'assertion failed')
}

/** The tab-bar markup only — page CONTENT may legitimately contain emoji
    (🌙 theme toggle, 📅 calendar, Sompitra's coloured dots). */
function tabBarHtml(html) {
  const m = html.match(/<nav id="home-tabbar"[\s\S]*?<\/nav>/)
  return m ? m[0] : ''
}

/** Cookie jar: name → value, sent as one `Cookie:` header. */
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
    redirect: 'manual',
    ...init,
    headers: { ...(init.headers || {}), ...(jar.size ? { Cookie: cookieHeader() } : {}) },
  })
  absorb(res)
  return res
}
const body = async (res) => await res.text()
const form = (fields) =>
  new URLSearchParams(fields).toString()

// ─── 1. the server answers ───────────────────────────────────────
log(`\n\x1b[1mHome smoke test\x1b[0m → ${BASE}\n`)
log('1. Boot & login page')
let res
try {
  res = await req('/login')
} catch (e) {
  log(`\n\x1b[31mCannot reach ${BASE} — is \`npm run dev\` running?\x1b[0m\n${e.message}\n`)
  process.exit(1)
}
check('/login serves the form', res.status === 200 && /password/i.test(await body(res)), `status ${res.status}`)

// ─── 2. one login, all cookies ───────────────────────────────────
log('\n2. One login → every module cookie')
res = await req('/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form({ username: USER, password: PASS }),
})
const redirect = res.headers.get('location') || ''
check('login redirects into the app', res.status === 302 && !/err=/.test(redirect), `${res.status} → ${redirect || '(no location)'}`)

const expectedCookies = ['home_session', 'session', 'way_user_session', 'laoka_session']
const missing = expectedCookies.filter((c) => !jar.has(c))
check('all four session cookies minted', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : expectedCookies.join(', '))

// ─── 3. every tab renders ────────────────────────────────────────
log('\n3. Every tab answers 200')
const pages = ['/', '/budget', '/kine', '/debts', '/sales', '/chat', '/way/', '/laoka/', '/settings']
for (const p of pages) {
  const r = await req(p)
  check(`${p} → 200`, r.status === 200, `status ${r.status}`)
}
if (ADMIN) {
  const r = await req('/admin')
  check('/admin → 200 (as admin)', r.status === 200, `status ${r.status}`)
}

// ─── 4. module APIs ──────────────────────────────────────────────
log('\n4. Module APIs behind the same login')
for (const p of ['/way/api/devices', '/laoka/api/bootstrap']) {
  const r = await req(p)
  check(`${p} → 200`, r.status === 200, `status ${r.status}`)
}

// ─── 5. chrome consistency (the bug class this project keeps hitting) ──
log('\n5. One chrome: real icons, no emoji, everywhere')
// Every tab is served either by Layout (Sompitra) or ModuleShell. Both must
// render the shared tab bar from src/views/app-chrome.tsx: the Home brand
// mark (/icon-64.png), the Sompitra label, all six hrefs, and NO emoji icon.
const TAB_HREFS = ['href="/"', 'href="/budget"', 'href="/chat"', 'href="/laoka/"', 'href="/way/"', 'href="/settings"']
for (const p of ['/', '/chat', '/way/', '/laoka/']) {
  const html = await body(await req(p))
  const bar = tabBarHtml(html)
  if (!bar) { bad(`${p}: tab bar present`, 'no <nav id="home-tabbar">'); continue }
  const emojis = [...new Set(bar.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || [])]
  const missingHrefs = TAB_HREFS.filter((h) => !bar.includes(h))
  check(`${p}: tab bar uses the real brand icons`, bar.includes('/icon-64.png') && emojis.length === 0,
    emojis.length ? `emoji tab icon(s): ${emojis.join(' ')}` : 'no /icon-64.png')
  check(`${p}: all six tabs linked`, missingHrefs.length === 0, `missing ${missingHrefs.join(' ')}`)
  check(`${p}: Sompitra tab labelled correctly`, bar.includes('Sompitra'), 'label missing')
}

// ─── 6. modules are session-gated ────────────────────────────────
log('\n6. Anonymous access is gated')
const anon = new Map(jar)          // park the real jar
jar.clear()
for (const p of ['/way/', '/laoka/', '/chat/', '/way/index.html', '/laoka/index.html', '/chat/index.html']) {
  const r = await req(p)
  const loc = r.headers.get('location') || ''
  check(`${p} anonymous → /login`, r.status === 302 && loc.includes('/login'), `${r.status} → ${loc || '(no location)'}`)
}
for (const [k, v] of anon) jar.set(k, v)   // restore

// ─── 7. bad credentials set nothing ──────────────────────────────
log('\n7. Bad credentials are rejected')
const saved = new Map(jar)
jar.clear()
const wrongPw = await req('/login', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form({ username: USER, password: 'definitely-not-the-password' }),
})
check('wrong password → back to /login?err=', (wrongPw.headers.get('location') || '').includes('err='), wrongPw.headers.get('location') || '(no location)')
check('wrong password sets no cookie', jar.size === 0, `${jar.size} cookies set`)
jar.clear(); for (const [k, v] of saved) jar.set(k, v)

// ─── 8. auto-repair from home_session alone ──────────────────────
log('\n8. Session auto-repair (one cookie, every module)')
const homeOnly = jar.get('home_session')
jar.clear()
if (homeOnly) jar.set('home_session', homeOnly)
else bad('home_session present for repair test', 'missing')
for (const p of ['/', '/way/api/devices', '/laoka/api/bootstrap']) {
  const r = await req(p)
  check(`${p} repairs from home_session alone → 200`, r.status === 200, `status ${r.status}`)
}

// ─── 9. no silent map reversion ──────────────────────────────────
log('\n9. WAY basemap stays where the user put it')
// Source-level guard: the 30-minute auto-revert to the lite basemap was
// removed on purpose. It cannot be exercised here (it needs a 30-minute
// wait), so assert the served document defines no such timer and still
// offers both manual layers.
{
  const way = await body(await req('/way/index.html'))
  check('no auto-revert timer in the served WAY document', !/scheduleTileRevert|tileRevertTimer/.test(way), 'an auto-revert to lite is back')
  check('both manual basemaps still offered', way.includes("setLayer('lite')") && way.includes("setLayer('osm')"), 'LITE / OSM buttons missing')
}

// ─── summary ─────────────────────────────────────────────────────
log('')
if (failures.length === 0) {
  log(`\x1b[32m\x1b[1mAll ${pass} checks passed.\x1b[0m\n`)
  process.exit(0)
}
log(`\x1b[31m\x1b[1m${failures.length} of ${pass + failures.length} checks FAILED:\x1b[0m`)
for (const f of failures) log(`  \x1b[31m•\x1b[0m ${f}`)
log('')
process.exit(1)
