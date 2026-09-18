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

// Query strings must survive the module adapters. Home strips the /laoka or
// /way prefix before dispatch, and an adapter that rebuilds the inner URL from
// the PATHNAME ALONE silently drops ?week=… — which is exactly what happened:
// Laoka's boot calls /api/state?week=N, got 400 "a week id is required", threw,
// and left the whole Laoka tab blank. Nothing without a query param noticed.
//
// The test needs no fixtures: an impossible week id must be answered by the
// LOOKUP (404 "no such week"), not by the guard (400 "required"). Getting 400
// means the parameter never arrived, whatever the data happens to be.
for (const [p, whenMissing] of [
  ['/laoka/api/state?week=999999', 'a week id is required'],
]) {
  const r = await req(p)
  const text = await body(r)
  check(
    `query strings reach the module: ${p} → 404, not 400`,
    r.status === 404 && !text.includes(whenMissing),
    `status ${r.status} body=${text.slice(0, 80)} — the adapter dropped the query string`
  )
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

// ─── 10. unified settings & per-person channels ──────────────────
log('\n10. Unified settings + one notification channel per person')
{
  const page = await body(await req('/settings'))
  for (const section of ['You', 'Notifications', 'Sompitra', 'W.A.Y', 'Laoka']) {
    check(`/settings has the ${section} section`, page.includes(`>${section}<`), 'section heading missing')
  }
  // The channel block is personal: either this person has a channel (show it)
  // or they are offered one. Both are correct — a blank block is not.
  check(
    '/settings shows this person\'s channel or offers one',
    page.includes('Your channel') && (page.includes('Generate my channel') || page.includes('New channel')),
    'no channel block'
  )

  // Every channel write is authenticated and self-scoped.
  const anonPost = await fetch(`${BASE}/settings/channel`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ action: 'rotate' }),
  })
  const anonLoc = anonPost.headers.get('location') || ''
  check('POST /settings/channel anonymous → /login', anonPost.status === 302 && anonLoc.includes('/login'), `${anonPost.status} → ${anonLoc || '(none)'}`)
}

// ─── 11. ONE channel, both senders ───────────────────────────────
log('\n11. WAY and Sompitra resolve the SAME notification channel')
{
  // Sompitra reads home-db live; W.A.Y's FleetDO resolves the same home-db
  // channels at cache-load time (this endpoint reports exactly what it would
  // push to). If the DO ever loses its HOME_DB binding or its lookup breaks,
  // WAY activity notifications would silently go to a different topic.
  const res = await req('/way/api/debug/notify')
  const okStatus = res.status === 200
  check('WAY debug-notify answers (DO can read home-db)', okStatus, `status ${res.status}`)
  if (okStatus) {
    let d = null
    try { d = JSON.parse(await body(res)) } catch (e) {}
    check(
      'WAY debug-notify reports channels + server',
      !!d && Array.isArray(d.users) && typeof d.server === 'string' && d.server.length > 0,
      'unexpected shape'
    )

    // The cross-check that matters: whatever /settings shows as THIS person's
    // channel must be the exact topic WAY would push theirs to. A mismatch
    // means the two senders have drifted onto different channels — which is
    // the bug this whole change exists to remove.
    const settingsHtml = await body(await req('/settings'))
    const tag = settingsHtml.match(/<input[^>]*id="my-topic"[^>]*>/)?.[0] ?? ''
    const mine = (tag.match(/value="([^"]*)"/)?.[1] ?? '').trim()
    const wayUser = (d?.users ?? []).find((u) => String(u.username).toLowerCase() === USER.toLowerCase())
    if (mine) {
      check('WAY pushes to the SAME channel /settings shows', wayUser?.topic === mine, `settings=${mine} way=${wayUser?.topic ?? 'none'}`)
    } else {
      check('a person with no channel is null in WAY too', (wayUser?.topic ?? null) === null, `way=${wayUser?.topic}`)
    }
  }
}

// ─── 12. the chat is the app's ONE activity feed ─────────────────
log('\n12. Chat carries every module\'s activity (WAY departures AND Sompitra money)')
{
  // WAY's geofence events and Sompitra's money events must render in the
  // SAME scrollback as centred system rows. Two independent halves have to
  // agree for that: the DO decides which event types are allowed in, and the
  // chat page decides how each type looks. A drift between them is invisible
  // in the code of either file, so it is asserted here.

  // The DO must be running the code that accepts them at all. Durable Objects
  // are NOT swapped by a plain deploy the way a Worker is, so a stale instance
  // is a real possibility -- especially right after a cutover. This marker is
  // what makes that answerable.
  const dbg = await req('/way/api/debug/notify')
  if (dbg.status === 200) {
    let d = null
    try { d = JSON.parse(await body(dbg)) } catch (e) {}
    const accepted = Array.isArray(d?.systemChatEvents) ? d.systemChatEvents : []
    check(
      'FleetDO accepts money events from Sompitra',
      accepted.includes('expense') && accepted.includes('income'),
      `build=${d?.build ?? 'unreadable'} accepts=[${accepted.join(', ')}] — the DO is serving older code`
    )
  }

  const chat = await body(await req('/chat/index.html'))
  check('chat styles expense events', /AUTO_STYLE[\s\S]{0,600}expense\s*:/.test(chat) && chat.includes('.system-msg.expense .text'), 'expense event type has no styling')
  check('chat styles income events', /AUTO_STYLE[\s\S]{0,600}income\s*:/.test(chat) && chat.includes('.system-msg.income .text'), 'income event type has no styling')
  check('chat styles kine events', /AUTO_STYLE[\s\S]{0,600}kine\s*:/.test(chat) && chat.includes('.system-msg.kine .text'), 'kine event type has no styling')
  // Money IN must not look like money OUT. Two separate classes alone is not
  // proof -- the whole point is that they render differently, so require the
  // income rules to differ from the expense rules.
  // Pull the declaration block for one system-row style, by plain string
  // search -- a CSS selector full of dots is not worth regex-escaping.
  const ruleFor = (cls) => {
    const marker = `.system-msg.${cls} .text {`
    const i = chat.indexOf(marker)
    if (i === -1) return ''
    return chat.slice(i + marker.length, chat.indexOf('}', i)).trim()
  }
  check(
    'income is visually distinct from expense',
    ruleFor('income').length > 0 && ruleFor('expense').length > 0 && ruleFor('income') !== ruleFor('expense'),
    'income and expense share the same styling'
  )
  check(
    'money in is green and money out is not',
    /#4ade80|\.4ade80/.test(ruleFor('income')) && !/#4ade80|\.4ade80/.test(ruleFor('expense')),
    `expense=${ruleFor('expense').trim().slice(0, 40)} income=${ruleFor('income').trim().slice(0, 40)}`
  )
  // Rows already in scrollback under the old single "budget" type must keep
  // rendering as a money row instead of degrading to the neutral fallback.
  check('legacy budget rows still render as money', /budget\s*:\s*\{\s*cls:\s*'expense'/.test(chat), 'the legacy budget alias is gone')
  check(
    'an unknown event type still renders as a system row',
    chat.includes('AUTO_FALLBACK') && /AUTO_STYLE\[msg\.event_type\]\s*\|\|\s*CONFIG\.AUTO_FALLBACK/.test(chat),
    'a new event type would fall through to a sender-less bubble'
  )
  // The renderer must branch on is_auto ALONE. It used to test for exactly
  // arrived/left, so any other auto message rendered as a chat bubble from
  // "System" -- which is how a money event would have appeared.
  check(
    'every is_auto message renders as a system row',
    /if\s*\(\s*msg\.is_auto\s*\)/.test(chat) && !/msg\.is_auto\s*&&\s*\(/.test(chat),
    'the renderer still special-cases only arrived/left'
  )

  // The intake is internal: it is reached through the DO binding, so no public
  // path may lead to it. Otherwise anyone could post into the household chat.
  const publicPaths = ['/system-chat', '/way/system-chat', '/api/system-chat']
  const reachable = []
  for (const p of publicPaths) {
    const r = await req(p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'injected', eventType: 'budget' }),
    })
    if (r.status === 204) reachable.push(`${p}→${r.status}`)
  }
  check('the system-chat intake is not publicly reachable', reachable.length === 0, reachable.join(', '))

  // ---- The real round trip: a Sompitra action lands in the chat ----
  // An auto-repair is not enough here: the only proof that the wiring exists is
  // causing a genuine event and finding it in the chat afterwards.
  if (ADMIN) {
    const probe = `smoke probe ${Date.now()}`
    const added = await req('/budget/add-expense', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ mode: 'quick', date: new Date().toISOString().slice(0, 10), category_id: 'cat_gas', amount: '1234', description: probe }),
    })
    if (added.status !== 302) {
      check('could not add an expense to test the chat wiring', false, `status ${added.status}`)
    } else {
      // The chat lives in the DO's own SQLite; /api/chat/history reads the copy
      // flushed to D1, so flush first (same work as the midnight cron).
      // This also exercises the flush itself: it is the ONLY thing that moves
      // chat rows out of the DO, and it fails as a whole if way-db is missing
      // the `devices` FK parent (see scripts/repair-way-messages-fk.sql).
      const flushed = await req('/way/api/flush', { method: 'POST' })
      let flushResult = null
      try { flushResult = JSON.parse(await body(flushed)) } catch (e) {}
      check('the DO flush completes (way-db schema is intact)', flushed.status === 200 && !flushResult?.error,
        `status ${flushed.status}: ${flushResult?.message || 'unreadable'}`)

      const hist = await req('/way/api/chat/history')
      // NOTE: like /way/api/users/me, this endpoint answers with the payload
      // DIRECTLY -- {start, end, messages} -- not wrapped in {data: ...}.
      let messages = []
      try { messages = JSON.parse(await body(hist))?.messages ?? [] } catch (e) {}
      const mine = messages.find((m) => String(m.message || '').includes(probe))
      check('a Sompitra expense reaches the chat', !!mine, 'no chat row for the probe expense')
      if (mine) {
        check('the chat row is a system message, not a person\'s', mine.is_auto === 1 || mine.is_auto === true, `is_auto=${mine.is_auto}`)
        check('and an expense is typed as one', mine.event_type === 'expense', `event_type=${mine.event_type}`)
        // D1's messages.sender is NOT NULL, so the DO writes "System" for an
        // auto row (a null would abort the whole flush). Attribution must never
        // be a real person's name.
        check('and attributed to nobody', mine.sender === 'System' || !mine.sender, `sender=${mine.sender}`)
      }

      // Money IN must be a DIFFERENT event type from money OUT -- otherwise a
      // salary landing reads exactly like an expense in the feed. This is the
      // half of the request that a styling assertion cannot prove.
      // The income form is its own route (GET /budget/add-income), not part of
      // the main budget list.
      const incomeForm = await body(await req('/budget/add-income'))
      const acct = incomeForm.match(/name="income_account_id"[\s\S]{0,600}?<option value="([^"]+)"/)?.[1]
      if (!acct) {
        check('could not find an income account to test with', false, 'no income_account_id option on /budget')
      } else {
        const incomeProbe = `smoke income ${Date.now()}`
        const addedIncome = await req('/budget/add-income', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form({ date: new Date().toISOString().slice(0, 10), income_account_id: acct, amount: '4321', description: incomeProbe }),
        })
        if (addedIncome.status !== 302) {
          check('could not add income to test the split', false, `status ${addedIncome.status}`)
        } else {
          await req('/way/api/flush', { method: 'POST' })
          const hist2 = await req('/way/api/chat/history')
          let msgs2 = []
          try { msgs2 = JSON.parse(await body(hist2))?.messages ?? [] } catch (e) {}
          const mineIncome = msgs2.find((m) => String(m.message || '').includes(incomeProbe))
          check('income also reaches the chat', !!mineIncome, 'no chat row for the probe income')
          check(
            'income is typed differently from expense',
            mineIncome?.event_type === 'income',
            `event_type=${mineIncome?.event_type} (must not be the expense type)`
          )
          check('and reads as money IN', /Income/.test(mineIncome?.message || ''), `message=${mineIncome?.message}`)
        }
      }

      // Self-cleaning: find each probe's own delete form on /budget and remove
      // it, so re-running the suite does not leave phantom money behind.
      const page = await body(await req('/budget'))
      let cleaned = 0
      for (const text of [probe, `smoke income`]) {
        const at = page.indexOf(text)
        const id = at === -1 ? null : page.slice(at).match(/action="\/budget\/delete\/([^"]+)"/)?.[1]
        if (id) {
          await req(`/budget/delete/${encodeURIComponent(id)}`, { method: 'POST' })
          cleaned++
        }
      }
      const after = await body(await req('/budget'))
      check(
        'probe transactions cleaned up',
        cleaned > 0 && !after.includes(probe) && !/smoke income/.test(after),
        cleaned === 0 ? 'could not locate any probe row on /budget' : 'a probe transaction is still listed'
      )
    }
  }
}

// ─── 13. Laoka's shopping list reaches Sompitra whole ────────────
log('\n13. Laoka shopping list → one itemized Sompitra expense (no CSV hop)')
{
  // The old hand-off was a downloaded file: Laoka exported a CSV, the person
  // opened Sompitra's itemized modal and re-picked it. These two endpoints
  // replace it, and they are load-bearing in a way compile checks cannot see:
  // one press has to become EXACTLY ONE expense, forever, however many times
  // it is pressed. So the assertions below are about identity and count, not
  // about whether the route merely answers.

  // (a) Guards. No fixtures needed, and nothing is written.
  const noWeek = await req('/budget/laoka-import')
  check('the hand-off status route demands a week id', noWeek.status === 400, `status ${noWeek.status}`)

  const ghost = await req('/budget/import-laoka', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: 999999 }),
  })
  const ghostBody = await body(ghost)
  // 404 (no such week) rather than 400 (no week given) is the difference
  // between Sompitra actually READING laoka-db and merely echoing a guard.
  check(
    'an unknown week is a LOOKUP miss, so laoka-db is really read',
    ghost.status === 404 && /no such week/i.test(ghostBody),
    `${ghost.status} ${ghostBody.slice(0, 90)}`
  )

  const anonImport = await fetch(`${BASE}/budget/import-laoka`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: 1 }),
  })
  const anonTo = anonImport.headers.get('location') || ''
  check('the hand-off is session-gated', anonImport.status === 302 && anonTo.includes('/login'), `${anonImport.status} → ${anonTo || '(none)'}`)

  // (b) The button is wired to the endpoint, not to a download. A served copy
  // of app.js that still only knew about /api/weeks/:id/export would look
  // perfectly healthy here and silently send nobody anywhere.
  const laokaJs = await body(await req('/laoka/app.js'))
  check('Laoka is wired to Sompitra\'s import, not just the CSV',
    laokaJs.includes("'/budget/import-laoka'") && laokaJs.includes("/budget/laoka-import?week="),
    'no reference to the Sompitra hand-off endpoint')

  // (c) The real round trip, against a week Laoka itself reports.
  let boot = null
  try { boot = JSON.parse(await body(await req('/laoka/api/bootstrap'))) } catch (e) {}
  const liveWeek = (boot?.weeks || []).find((w) => w.status !== 'archived')
  if (!liveWeek) {
    bad('a live Laoka week exists to hand over', 'no non-archived week in /laoka/api/bootstrap')
  } else {
    let st = null
    try { st = JSON.parse(await body(await req(`/laoka/api/state?week=${liveWeek.id}`))) } catch (e) {}
    const priced = (st?.shopping || []).filter((l) => l.price > 0)
    const expected = priced.reduce((s, l) => s + Math.trunc(l.price), 0)

    const status = await req(`/budget/laoka-import?week=${liveWeek.id}`)
    let note = null
    try { note = JSON.parse(await body(status)) } catch (e) {}
    check('the status route reports whether this week was sent',
      status.status === 200 && note?.ok === true && typeof note.sent === 'boolean',
      `status ${status.status} body ${JSON.stringify(note)?.slice(0, 80)}`)

    if (!priced.length) {
      log('  \x1b[90m– skipped the round trip: week ' + liveWeek.id + ' has no priced lines\x1b[0m')
    } else if (!note?.sent) {
      // A week that has NOT been sent is the one case where pressing send
      // would put NEW money in the budget. The suite must not do that behind
      // the household's back, so the in-place-update half is reported as
      // skipped instead of quietly passing. Press Send once in Laoka and this
      // becomes a real check; every later run keeps proving the ledger holds.
      log('  \x1b[90m– skipped the write half: week ' + liveWeek.id + ' has not been sent to Sompitra yet\x1b[0m')
    } else {
      // Count the transaction rows the history page is showing, by the id each
      // one carries on its details panel. Counting the id being tested alone
      // proves nothing about duplicates: it is on the page either way.
      const idsOf = (html) => [...html.matchAll(/data-tx-details="([^"]+)"/g)].map((m) => m[1])
      const beforeIds = idsOf(await body(await req('/budget/transactions')))
      check('a sent week is a real expense in Sompitra', beforeIds.includes(note.transactionId), `transaction ${note.transactionId} is not on /budget/transactions`)

      const again = await req('/budget/import-laoka', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ week: liveWeek.id }),
      })
      let sent = null
      try { sent = JSON.parse(await body(again)) } catch (e) {}
      check('re-sending counts the same items and total',
        sent?.ok === true && sent.itemCount === priced.length && sent.amount === expected,
        `amount=${sent?.amount} expected=${expected} items=${sent?.itemCount}/${priced.length}`)
      // THE assertion this feature exists for. A second press must land on the
      // same expense; a CSV could not tell the two apart at all.
      check('re-sending UPDATES that expense instead of adding another',
        sent?.action === 'updated' && sent.transactionId === note.transactionId,
        `action=${sent?.action} id=${sent?.transactionId} was=${note.transactionId}`)

      const page = await body(await req('/budget/transactions'))
      const afterIds = idsOf(page)
      check(
        'the re-send created no second transaction',
        afterIds.length <= beforeIds.length,
        `${beforeIds.length} transaction rows before, ${afterIds.length} after — a duplicate was created`
      )

      // Not a text blob: Sompitra parses the notes back into structured items,
      // which is what makes this an itemized expense rather than a paragraph.
      const panel = page.slice(page.indexOf(`data-tx-details="${note.transactionId}"`))
      const panelBody = panel.slice(0, panel.indexOf('</div>\n                  <div class="flex items-start'))
      check('and renders as an itemized list in Sompitra',
        panel.includes(`data-tx-details="${note.transactionId}"`) && panelBody.includes(`${priced.length} items`),
        `expected "${priced.length} items" in the details panel`)
    }
  }
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
