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
log('\n10. Unified settings + two notification channels per person')
{
  const page = await body(await req('/settings'))
  for (const section of ['You', 'Notifications', 'Sompitra', 'W.A.Y', 'Laoka']) {
    check(`/settings has the ${section} section`, page.includes(`>${section}<`), 'section heading missing')
  }
  // Both channels are personal: each either shows this person's topic or offers
  // to make one. Two blocks, never one — a person who can only see the feed
  // cannot subscribe to the activity one, and vice versa.
  // Titles are compared as they appear in the HTML — JSX escapes the "&" in
  // the feed card's title, and a check that misses that reads as a missing card.
  // Neither title carries an emoji any more: headings use the brand glyph set
  // (section 18), so these two are matched on their text alone.
  for (const [title, id, empty] of [
    ['Money &amp; chat feed', 'my-topic', 'No feed topic yet'],
    ['W.A.Y tracking', 'my-way-topic', 'No tracking topic yet'],
  ]) {
    // Either this person has that topic (the input is rendered) or they are
    // offered one — a blank card is not acceptable, because it hides which of
    // the two channels they are missing.
    check(
      `/settings offers the ${title} channel`,
      page.includes(title) && (page.includes(`id="${id}"`) || page.includes(empty)) && /🎲 (Generate|New) topic/.test(page),
      'no channel block'
    )
  }
  check('and each channel can be tested, rotated and turned off on its own',
    (page.match(/name="channel" value="feed"/g) || []).length >= 3 &&
    (page.match(/name="channel" value="tracking"/g) || []).length >= 3,
    'the two cards do not offer the same actions')

  // Every channel write is authenticated and self-scoped.
  const anonPost = await fetch(`${BASE}/settings/channel`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ action: 'rotate' }),
  })
  const anonLoc = anonPost.headers.get('location') || ''
  check('POST /settings/channel anonymous → /login', anonPost.status === 302 && anonLoc.includes('/login'), `${anonPost.status} → ${anonLoc || '(none)'}`)
}

// ─── 11. TWO channels per person ─────────────────────────────────
log('\n11. Two channels per person: the feed, and tracking')
{
  // Each person follows TWO topics and each sender must use ITS OWN: Sompitra
  // fans money out to every feed channel including the recorder's, while W.A.Y
  // routes activity to the recipient's tracking channel and never to the person
  // who triggered it (src/way/do/FleetDO.ts). Collapse the two onto one topic
  // and the second rule becomes impossible to obey — which is exactly the state
  // this app was in, with W.A.Y's own admin screen still advertising its old
  // way-db topic while the DO published to home-db.
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

    const html = await body(await req('/settings'))
    const topicOf = (id) => {
      const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? ''
      return (tag.match(/value="([^"]*)"/)?.[1] ?? '').trim()
    }
    const feed = topicOf('my-topic')
    const tracking = topicOf('my-way-topic')
    const wayUser = (d?.users ?? []).find((u) => String(u.username).toLowerCase() === USER.toLowerCase())

    // The cross-check that matters: whatever /settings calls this person's
    // TRACKING topic must be the exact topic the DO would publish their events
    // to, and it must not be the money channel.
    if (tracking) {
      check('WAY pushes to the TRACKING topic /settings shows',
        wayUser?.trackingTopic === tracking, `settings=${tracking} way=${wayUser?.trackingTopic ?? 'none'}`)
      if (feed) {
        check('the two channels are different topics',
          feed !== tracking, `both are ${feed} — the split has been undone`)
      }
    } else {
      check('a person with no tracking topic is null in WAY too',
        (wayUser?.trackingTopic ?? null) === null, `way=${wayUser?.trackingTopic}`)
    }

    // W.A.Y's OWN screen, which is where a phone actually gets its topic from.
    // It reads identity now; reading its own stale copy is how it once handed
    // out a topic that received nothing.
    const wayUsers = await req('/way/api/users')
    if (wayUsers.status === 200) {
      let list = null
      try { list = JSON.parse(await body(wayUsers)) } catch (e) {}
      const mine = (Array.isArray(list) ? list : []).find((u) => String(u.username).toLowerCase() === USER.toLowerCase())
      check("WAY's Users & topics screen shows the SAME tracking topic",
        mine && mine.ntfyTopic === (tracking || null),
        `screen=${mine?.ntfyTopic ?? '(missing)'} settings=${tracking || '(none)'}`)
      check('and says which side answered, so a dead topic cannot look live',
        !!mine && (mine.topicSource === 'identity' || mine.topicSource === 'way-db'),
        `topicSource=${mine?.topicSource}`)
    } else {
      bad("WAY's Users & topics screen answers", `status ${wayUsers.status}`)
    }

    // ── Quiet hours, said out loud ──
    // Between 22:00 and 06:00 W.A.Y drops EVERY non-chat event for that person
    // (way-db users.quiet_start/quiet_end). That is correct, and completely
    // invisible: a phone that goes quiet at night looks exactly like a push
    // pipeline that broke, and nothing on any screen told the two apart. The
    // card that owns the tracking channel has to name the window.
    check('/settings names the quiet window that mutes tracking',
      /Quiet hours \d{2}:00–\d{2}:00 \(household time\)/.test(html),
      'the tracking card does not say when it goes quiet')

    // ── The test button must not lie ──
    // It used to answer "Test sent to your … topic" for ANY outcome, including a
    // 401 from a server that wants a token and a host that does not resolve — so
    // pressing it the one time it matters (nothing is arriving) produced a green
    // tick and no explanation. The answer must come from the server.
    if (feed) {
      const t = await req('/settings/notifications/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({ channel: 'feed' }),
      })
      const loc = decodeURIComponent(t.headers.get('location') || '')
      check('the test button reports what ntfy answered, not merely that we tried',
        /[?&]ok=Test accepted for your feed topic — ntfy accepted it \(\d+\)/.test(loc) ||
          /[?&]err=Test NOT sent — (ntfy refused it \(\d+\)|could not reach |no ntfy server is set)/.test(loc),
        `redirected to ${loc || '(no location)'}`)
    }

    // ── Both halves publish to the SAME server ──
    // Sompitra resolves the server from the databases (home-db, then its own
    // app_settings), while W.A.Y's Durable Object resolves setting -> env ->
    // default. When the two answers differ, one half of the app notifies and the
    // other does not, and nothing on screen says which — so the value each side
    // reports is compared directly.
    const shown = (html.match(/Server: <span class="font-mono">([^<]*)<\/span>/) || [])[1]?.trim()
    const strip = (u) => String(u || '').replace(/\/+$/, '')
    check('the feed and tracking halves publish to the same ntfy server',
      !!shown && shown !== '— not set —' && strip(shown) === strip(d.server),
      `settings=${shown || '(none)'} way=${d.server}`)
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

// ─── 14. A template can be forgotten ─────────────────────────────
log('\n14. Laoka: discarding the template (the way back out of "this is the template")')
{
  // A saved-but-unconfirmed plan is only a proposal, so the household has to be
  // able to walk away from it — including the prices already typed into the
  // list it produced. The route is destructive by nature, so the checks below
  // are deliberately the ones that need no fixture: they prove it is routed,
  // that it looks weeks up, and that it is gated. The two that DO need a
  // fixture skip out loud rather than passing quietly.

  const ghost = await req('/laoka/api/weeks/999999/plan', { method: 'DELETE' })
  const ghostBody = await body(ghost)
  // 404 (no such week) rather than 400 (a missing guard) is the difference
  // between the route existing and being dispatched to the right handler.
  check('discarding demands a week that exists', ghost.status === 404 && /no such week/i.test(ghostBody),
    `${ghost.status} ${ghostBody.slice(0, 80)}`)

  const anon = await fetch(`${BASE}/laoka/api/weeks/1/plan`, { method: 'DELETE', redirect: 'manual' })
  const anonTo = anon.headers.get('location') || ''
  check('missing a template is session-gated like every other write',
    anon.status === 401 || (anon.status === 302 && anonTo.includes('/login')),
    `${anon.status} → ${anonTo || '(no redirect, and not a 401)'}`)

  const laokaJs = await body(await req('/laoka/app.js'))
  // Without this the server could be perfect and the button still absent: the
  // card is drawn client-side from exactly this string.
  check('the button is wired to the endpoint, not to a local repaint',
    laokaJs.includes("'/api/weeks/' + state.week.week.id + '/plan'") && laokaJs.includes('Discard the template'),
    'app.js does not call DELETE /api/weeks/:id/plan')

  let boot = null
  try { boot = JSON.parse(await body(await req('/laoka/api/bootstrap'))) } catch (e) {}
  const weeks = boot?.weeks || []

  const empty = []
  const settled = []
  for (const w of weeks) {
    if (w.status === 'archived') continue
    // bootstrap hands these rows over as they come out of D1 (snake_case),
    // unlike the state payload, which is camelCase.
    if (w.confirmed_at) settled.push(w)
    try {
      const st = JSON.parse(await body(await req(`/laoka/api/state?week=${w.id}`)))
      if (!st.planId) empty.push(w)
    } catch (e) {}
  }

  if (!empty.length) {
    // Not a failure: a household mid-week has a plan in every open week. The
    // destructive half was proven by hand against a throwaway week; this suite
    // will start asserting it here the next time a week is open and empty.
    log('  \x1b[90m– skipped: every open week has a plan, and this suite will not wipe a real one.\x1b[0m')
    log('  \x1b[90m  When changing this route, run it by hand against a throwaway week\x1b[0m')
  } else {
    const w = empty[0]
    const res = await req(`/laoka/api/weeks/${w.id}/plan`, { method: 'DELETE' })
    let st = null
    try { st = JSON.parse(await body(res)) } catch (e) {}
    check('forgetting an empty week leaves it open, not broken',
      res.status === 200 && st?.ok === true && st.planId === null && (st.days || []).length === 0,
      `${res.status} planId=${st?.planId} days=${(st?.days || []).length}`)
    // Every line left must be Pantry. A plan line surviving here would mean the
    // list outlived the plan that asked for it, which is the whole bug class the
    // sync exists to prevent.
    check('and every line it kept is a Pantry line',
      (st?.shopping || []).every((l) => l.origin === 'pantry'),
      `origins ${JSON.stringify([...new Set((st?.shopping || []).map((l) => l.origin))])}`)
  }

  if (!settled.length) {
    log('  \x1b[90m– skipped: no confirmed week to refuse\x1b[0m')
  } else {
    const res = await req(`/laoka/api/weeks/${settled[0].id}/plan`, { method: 'DELETE' })
    const text = await body(res)
    check('a settled week refuses to be forgotten',
      res.status === 409 && /confirmed/i.test(text), `${res.status} ${text.slice(0, 80)}`)
  }
}

// ─── 15. the map is drawn on a playback clock (visual only) ──────
log('\n15. W.A.Y: the smoothed map never changes what W.A.Y records')
{
  // The rendering rewrite is only trustworthy if the things around it did NOT
  // move, so this section asserts both halves against the SERVED page (not the
  // repo): the loop exists, the ping path no longer redraws, and every style
  // value that decides how a track looks is still exactly what it was.
  const way = await body(await req('/way/index.html'))

  // Pull one function body out by brace balance, so a check can talk about
  // what a function does instead of pattern-matching the whole file.
  const fnBody = (src, name) => {
    const at = src.indexOf(`function ${name}(`)
    if (at === -1) return null
    const open = src.indexOf('{', at)
    if (open === -1) return null
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1) }
    }
    return null
  }

  check('the playback loop is in the page that is actually served',
    way.includes('startPlaybackLoop()') && way.includes('PLAYBACK_LAG_SECONDS') && way.includes('function playbackTick('),
    'the served /way/index.html has no playback loop')

  const ping = fnBody(way, 'handleNewPing')
  check('a new ping no longer rebuilds the map',
    !!ping && !/redrawAllTracks|updateMarker\(|panTo\(/.test(ping),
    ping ? 'handleNewPing still redraws or pans' : 'handleNewPing is not in the page')

  const cam = fnBody(way, 'updateFollowCamera')
  const zone = fnBody(way, 'followDeadZonePx')
  check('the camera is the only thing that moves the map',
    !!cam && cam.includes('panBy(') && !!zone && zone.includes('FOLLOW_DEAD_ZONE_SCREEN_FRACTION') &&
    (way.match(/map\.panBy\(/g) || []).length === 1 &&
    // The per-ping pan is the bug this replaced: it must not come back anywhere.
    !/map\.panTo\(/.test(way),
    'the camera should be one panBy() from updateFollowCamera, off a screen-fraction box, and panTo() should be gone')

  // Styling is FROZEN by this feature: the same numbers must still decide what
  // a track looks like, or "visual only" stopped being true.
  const frozen = [
    "TRACK_GAP_SECONDS: 90",
    "TRACK_WEIGHT_DRIVING: 3.5",
    "TRACK_OPACITY_DRIVING: 0.9",
    "TRACK_WEIGHT_WALKING: 2.5",
    "TRACK_OPACITY_WALKING: 0.85",
    "WALK_TRACK_DASH_ARRAY: '6, 6'",
    "{ maxKmh: 10,       color: '#f1c40f' }",
    "{ maxKmh: 40,       color: '#2ecc71' }",
    "{ maxKmh: 70,       color: '#38bdf8' }",
    "{ maxKmh: Infinity, color: '#ef4444' }",
    "STATIONARY_DOT_CLUSTER_RADIUS_M: 20",
    "STATIONARY_DOT_RADIUS_PX: 5",
    "STATIONARY_DOT_COLOR: '#2ecc71'"
  ]
  const changed = frozen.filter((line) => !way.includes(line))
  check('every track style value is untouched (colour, dash, weights, dot)',
    changed.length === 0, `changed or missing: ${changed.join(' | ')}`)

  const commit = fnBody(way, 'commitTrail')
  const tail = fnBody(way, 'drawTail')
  check('the append-only path keeps the SAME break rules as the old loop',
    !!commit && commit.includes('TRACK_GAP_SECONDS') && commit.includes('isDriving !== st.runDriving') &&
    !!tail && tail.includes('TRACK_GAP_SECONDS') && tail.includes('pos.next.is_driving'),
    'the streaming trail no longer breaks on a gap + a mode change')

  // The Trips summary is a DIFFERENT data path on purpose, and it must stay one:
  // it is the household's own numbers, read from the database.
  const legs = fnBody(way, 'computeLegsForDay')
  check('the Trips summary still sums the complete ping list, not the playback buffer',
    !!legs && !/markerPositions|playbackClock|trailFor|drawnIdx/.test(legs),
    'computeLegsForDay reaches into the playback state')

  const totals = fnBody(way, 'loadMonthlyTotals')
  const historyOf = fnBody(way, 'fetchHistoryFor')
  check('monthly driven/walked still comes out of the database',
    !!totals && totals.includes('fetchHistoryFor(') && !!historyOf && historyOf.includes('/way/api/history') &&
    way.includes('(through yesterday)'),
    'the monthly totals no longer read /way/api/history')

  // The pace switch: Smooth is the fluid default, Live draws the newest ping the
  // moment it lands. It is display-only, so the guard is as much about what it
  // must NOT do -- and about the lag being ONE number the cursor reads.
  const lag = fnBody(way, 'playbackLagSeconds')
  const clock = fnBody(way, 'playbackClock')
  check('the cursor runs on the pace, and Live means zero lag',
    !!lag && /'live'\s*\?/.test(lag) && /\?\s*0\s*:/.test(lag) &&
    !!clock && clock.includes('playbackLagSeconds()') && !clock.includes('CONFIG.PLAYBACK_LAG_SECONDS'),
    lag ? 'the playback clock no longer reads the pace' : 'playbackLagSeconds is not in the served page')

  const paceSet = fnBody(way, 'setMapPace')
  const paceApply = fnBody(way, 'applyMapPace')
  check('switching pace touches nothing but the drawing',
    !!paceSet && !!paceApply && !/fetch\(|\/api\/|ws\.send/.test(paceSet + paceApply) &&
    paceSet.includes("localStorage.setItem('map_pace'") && paceApply.includes('redrawAllTracks()'),
    'the pace switch reaches the network, or no longer rebuilds the trails')

  // The switch lives in Settings -> Map, NOT floating over the map: the map's
  // own chrome stays about the device, and the HUD badge is how the map says a
  // pace exists at all.
  const mapSection = (() => {
    const at = way.indexOf("settingsSection('map'")
    return at === -1 ? '' : way.slice(at, at + 700)
  })()
  check('both paces are switchable from Settings -> Map, and the choice persists',
    mapSection.includes('data-pace="smooth"') && mapSection.includes('data-pace="live"') &&
    way.includes("localStorage.getItem('map_pace')") && way.includes("localStorage.setItem('map_pace'"),
    mapSection ? 'the pace pills are not in the Map settings section' : 'the Map settings section is gone from the served page')

  check('no pace switch floats over the map itself',
    !way.includes('pace-switch'),
    'a pace control is back in the map chrome — it belongs in Settings only')
}

// ─── 16. installable on Android + readable on both shapes ───────
log('\n16. Installable (Chrome/Brave on Android) and the chrome on both shapes')
{
  // Installation is refused outright when the manifest or an icon is wrong, so
  // this section reads the SERVED bytes. It exists because the brand kit once
  // shipped `pwa-maskable-512.png` as a byte-for-byte copy of `icon-512.png`:
  // the manifest said "maskable", Android masked it to a circle, and the house
  // lost its corners (44px of the mark, measured). A duplicate is invisible in
  // any HTML check — only the bytes catch it.
  const { createHash } = await import('node:crypto')
  const sha = (b) => createHash('sha1').update(Buffer.from(b)).digest('hex')
  const pngSize = (b) => {
    const buf = Buffer.from(b)
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }

  const manRes = await req('/manifest.webmanifest')
  const manBody = await body(manRes)
  check('the manifest is served AS a manifest',
    manRes.status === 200 && /manifest\+json/.test(manRes.headers.get('content-type') || ''),
    `${manRes.status} ${manRes.headers.get('content-type')}`)
  let man = null
  try { man = JSON.parse(manBody) } catch (e) {}
  check('the manifest is valid JSON with a name', !!man && !!man.name && !!man.short_name, manBody.slice(0, 60))

  // Everything Chrome for Android requires before it will offer "Install app".
  check('the manifest carries the fields an install needs',
    man?.start_url === '/' && man?.scope === '/' && man?.display === 'standalone' && !!man?.theme_color,
    `start_url=${man?.start_url} scope=${man?.scope} display=${man?.display} theme=${man?.theme_color}`)

  const icons = man?.icons || []
  const has = (size, purpose) => icons.some((i) => i.sizes === size && (i.purpose || 'any').split(' ').includes(purpose))
  check('it declares an any 192, an any 512 and a maskable 512',
    has('192x192', 'any') && has('512x512', 'any') && has('512x512', 'maskable'),
    icons.map((i) => `${i.sizes}/${i.purpose || 'any'}`).join(' ') || '(no icons)')

  // Each declared icon must exist AND be the size it advertises — a wrong-size
  // icon is rejected silently, and the manifest then has no usable icon at all.
  const fetched = []
  for (const icon of icons) {
    const r = await req(icon.src)
    const bytes = Buffer.from(await r.arrayBuffer())
    const dim = pngSize(bytes)
    const want = icon.sizes.split('x')
    check(`icon ${icon.src} is a ${icon.sizes} PNG`,
      r.status === 200 && /image\/png/.test(r.headers.get('content-type') || '') &&
      dim && dim.w === Number(want[0]) && dim.h === Number(want[1]),
      `${r.status} ${dim ? `${dim.w}x${dim.h}` : 'not a PNG'}`)
    if (dim) fetched.push({ src: icon.src, purpose: icon.purpose || 'any', hash: sha(bytes) })
  }

  // The regression guard: a "maskable" that is the same file as the plain icon
  // is not a maskable, it is a mislabel that Android crops.
  const anyHashes = new Set(fetched.filter((f) => f.purpose.split(' ').includes('any')).map((f) => f.hash))
  const maskables = fetched.filter((f) => f.purpose.split(' ').includes('maskable'))
  check('the maskable icon is its own artwork, not a copy of the plain one',
    maskables.length > 0 && maskables.every((m) => !anyHashes.has(m.hash)),
    'the maskable icon is byte-identical to an any icon — Android would clip the mark')

  const appleRef = await req('/icons/apple-touch-icon.png')
  const apple = pngSize(await appleRef.arrayBuffer())
  check('apple-touch-icon is a square PNG (iOS would letterbox a rectangle)',
    appleRef.status === 200 && !!apple && apple.w === apple.h && apple.w >= 180,
    apple ? `${apple.w}x${apple.h}` : `status ${appleRef.status}`)

  const swRes = await req('/sw.js')
  const sw = await body(swRes)
  check('the service worker is served and actually handles fetches',
    swRes.status === 200 && /javascript/.test(swRes.headers.get('content-type') || '') &&
    /addEventListener\(\s*'fetch'/.test(sw),
    `${swRes.status} ${swRes.headers.get('content-type')}`)

  // ── The chrome on every page, in both shapes ──
  // `md:` classes ARE the desktop/mobile split: the bar hides itself from md up
  // and the header nav appears, so a page missing either one breaks a shape.
  const CHROME_PAGES = ['/', '/budget', '/chat', '/way/', '/laoka/', '/settings']
  for (const p of CHROME_PAGES) {
    const html = await body(await req(p))
    const bar = tabBarHtml(html)
    if (!bar) { bad(`${p}: tab bar present`, 'no <nav id="home-tabbar">'); continue }

    // Split the bar into anchors and read each one as a whole tab.
    const tabs = bar.split('<a href=').slice(1).map((c) => '<a href=' + c).map((a) => ({
      href: (a.match(/href="([^"]+)"/) || [])[1],
      active: a.includes('aria-current="page"'),
      color: ((a.match(/background-color:(#[0-9a-fA-F]{6})/) || [])[1] || '').toLowerCase(),
      width: (a.match(/width:(\d+)px/) || [])[1],
      weight: a.includes('font-semibold') ? 'semibold' : 'medium',
      // Every `--tab:#hex` in the anchor: the pill (which carries the icon)
      // and the label. The colour arrives as a custom property, not a literal
      // `color:` — that is what lets dark mode lift the tint (see `.tab-tint`),
      // so reading the variable is exactly what "keeps its colour" means.
      tints: [...a.matchAll(/--tab:(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase()),
    }))
    const nav = (html.match(/<nav id="home-nav" class="([^"]*)"/) || [])[1] || ''

    check(`${p}: the bottom bar is for phones, the header nav for desktop`,
      /md:hidden/.test((bar.match(/^<nav[^>]*>/) || [''])[0]) && /hidden/.test(nav) && /md:flex/.test(nav),
      `bar="${(bar.match(/^<nav[^>]*>/) || [''])[0].slice(0, 60)}" nav="${nav}"`)

    const navHrefs = [...html.matchAll(/<nav id="home-nav"[\s\S]*?<\/nav>/g)]
      .flatMap((m) => [...m[0].matchAll(/href="([^"]+)"/g)].map((h) => h[1]))
    check(`${p}: both shapes carry the same six tabs`,
      tabs.length === 6 && navHrefs.length === 6 && tabs.every((t, i) => t.href === navHrefs[i]),
      `bar ${tabs.map((t) => t.href).join(',')} vs nav ${navHrefs.join(',')}`)

    // A tab keeps its OWN colour whether or not it is the one you are on — the
    // colours are how the modules stay recognisable at a glance.
    const colours = tabs.map((t) => t.color)
    check(`${p}: every tab carries its own colour (inactive ones included)`,
      colours.every((c) => /^#[0-9a-f]{6}$/.test(c)) && new Set(colours).size === 6,
      `colours ${colours.join(' ')}`)

    // …and not only as a background: BOTH the icon's wrapper and the label
    // carry the tab's own tint, on every tab, whether or not you are on it.
    // This is the property that stops an inactive tab collapsing back to grey.
    check(`${p}: every tab's icon AND label carry its own colour`,
      tabs.every((t) => t.tints.length >= 2 && t.tints.every((c) => c === t.color)),
      tabs.map((t) => `${t.href}=>${t.tints.join('/') || '(none)'} (want ${t.color})`).join(' '))

    check(`${p}: no inactive tab falls back to grey`,
      !/text-gray-[45]00/.test(bar) && !/color:#(6b7280|9ca3af)/.test(bar),
      'the tab bar still greys an inactive tab (text utility or literal grey)')

    // The desktop nav is the same rule at md+: same six tabs, same six colours.
    const navBlock = (html.match(/<nav id="home-nav"[\s\S]*?<\/nav>/) || [''])[0]
    const navTints = navBlock.split('<a href=').slice(1)
      .map((a) => [...a.matchAll(/--tab:(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase()))
    check(`${p}: the desktop nav keeps the same colours as the bottom bar`,
      navTints.length === 6 && navTints.every((cs, i) => cs.length >= 1 && cs.every((c) => c === tabs[i].color)),
      navTints.map((cs, i) => `${tabs[i]?.href}=>${cs.join('/') || '(none)'}`).join(' '))

    // …and being ON one is shown by shape and weight, not by being the only
    // coloured tab: one 26px bar, a bold label, and a theme colour to match.
    const active = tabs.filter((t) => t.active)
    check(`${p}: exactly one tab is marked active, by a bar + a bold label`,
      active.length === 1 && active[0].width === '26' && active[0].weight === 'semibold' &&
      tabs.filter((t) => !t.active).every((t) => t.width === '0' && t.weight === 'medium'),
      `active ${active.map((t) => t.href).join(',') || '(none)'} width=${active.map((t) => t.width).join(',')}`)

    const theme = (html.match(/<meta name="theme-color" content="([^"]+)"/) || [])[1]
    check(`${p}: the browser/status bar matches the module you are in`,
      !!theme && !!active[0] && theme.toLowerCase() === active[0].color,
      `theme-color=${theme} vs active tab ${active[0]?.color}`)

    check(`${p}: it declares the manifest, the touch icon and PWA viewport`,
      /<link rel="manifest" href="\/manifest\.webmanifest"/.test(html) &&
      /<link rel="apple-touch-icon"/.test(html) && /viewport-fit=cover/.test(html),
      'a page that misses these installs differently (or not at all)')
  }

  // The You tab is where installation is discoverable, and its button must stay
  // wired to the browser's own prompt (it cannot fire in this test).
  const you = await body(await req('/settings'))
  check('the You tab offers to install, wired to the real prompt',
    /id="install-app-card"/.test(you) && you.includes('beforeinstallprompt'),
    'no install card, or it is not wired to beforeinstallprompt')
}

// ─── 17. Laoka inside the shell: the list must scroll and clear the ribbon ──
log('\n17. Laoka as a tab: scrolling, the sticky nav, and the export ribbon')
{
  // These three are all "the embed rewrote the app's own layout" bugs, and every
  // one of them is invisible to a screenshot of the top of the page:
  //
  //   * the old embed set `overflow-x: hidden` on html/body. On the ROOT element
  //     that is a documented way to stop the document being the viewport
  //     scroller, which loses MOUSE-WHEEL scrolling of the whole page. It was
  //     hiding a symptom (the six nav buttons overflowed a phone-width frame and
  //     were clipped, so History and Settings were unreachable). The right fix is
  //     to let the nav wrap and never touch html/body overflow at all.
  //   * `#view { padding-bottom: 16px !important }` out-specifies the app's own
  //     `body.with-totals .view` rule, so the last rows of the shopping list end
  //     up permanently UNDER the fixed totals/export ribbon.
  //
  // So this section asserts the invariants, not the pixels.
  const laoka = await body(await req('/laoka/index.html'))
  const embedRaw = (laoka.match(/if \(window\.self !== window\.top\)[\s\S]*?<\\\/style>'\)/) || [''])[0]
  // The block's prose explains WHY there is no root overflow rule, so the
  // comments have to go before searching it — otherwise the explanation is read
  // as the bug it warns about.
  const embed = embedRaw.replace(/\/\*[\s\S]*?\*\//g, '')
  check('the Laoka module document still detects the Home embed',
    embed.length > 0 && /home-embed/.test(embed),
    'no embed block — the app would draw its own header and bottom nav inside the shell')

  check('the embed never sets overflow on html/body (that is what kills wheel scrolling)',
    !/html, body\s*\{[^}]*overflow/.test(embed) && !/overflow-x:\s*hidden/.test(embed),
    'a root overflow rule is back in the Laoka embed — the page will stop scrolling with the mouse wheel')

  check('Laoka\'s own nav wraps, so no tab is clipped off a phone-width frame',
    /#topnav \.inner\s*\{[^}]*flex-wrap:\s*wrap/.test(embed),
    'the nav does not wrap: History and Settings fall off the right edge and cannot be reached')

  // The two paddings have to disagree on purpose: 16px for the pages the shell
  // already ends, and room for the ribbon on the shopping list.
  const plainPad = (embed.match(/'#view \{ padding-bottom: calc\((\d+)px/) || [])[1]
  const totalsPad = (embed.match(/'body\.with-totals #view \{ padding-bottom: calc\((\d+)px/) || [])[1]
  check('the shopping list reserves room for the fixed totals/export ribbon',
    Number(totalsPad) >= 80 && Number(plainPad) < Number(totalsPad),
    `view padding-bottom ${plainPad}px, with-totals ${totalsPad}px — the last rows will sit under the ribbon`)

  // Inside the shell there is no Laoka bottom nav, so the ribbon belongs at the
  // frame's edge instead of floating one nav-height above it.
  check('the ribbon sits at the frame edge, not one dead nav-height above it',
    /\.totals \{ bottom: 0 !important; \}/.test(embed),
    'the totals bar still floats above a bottom nav this app no longer draws')

  // The Sompitra tab icon: a receipt (a slip with a torn edge and three rule
  // lines), not the wallet-ish card it used to be — at 24px a card says nothing
  // about expenses. Four subpaths (body + 3 rules) is the fingerprint, and it
  // also guards the WINDING: the body runs clockwise and the rules must run
  // counter-clockwise or they vanish into the fill instead of punching holes.
  const home = await body(await req('/'))
  const budgetTab = tabBarHtml(home).split('<a href=').slice(1).map((a) => '<a href=' + a)
    .find((a) => a.startsWith('<a href="/budget"')) || ''
  const moneyPath = (budgetTab.match(/<path d="([^"]+)"/) || [])[1] || ''
  check('the Sompitra tab icon is the receipt (body + 3 rule lines)',
    moneyPath.split('M').length - 1 === 4 && moneyPath.includes('18.6'),
    `money icon has ${moneyPath.split('M').length - 1} subpaths — expected the receipt's 4 (body + 3 rules)`)
  check('the Sompitra tab icon is no longer the old wallet/card',
    !moneyPath.includes('M17 10.5a1.5'),
    'the wallet path is back on the Sompitra tab')
}

// ─── 18. One brand: one typeface, brand glyphs, one colour per screen ──
log('\n18. The brand system: one typeface, brand glyphs, one colour per screen')
{
  // These are the "is it one app or three?" properties, and every one of them
  // was violated before this section existed:
  //   • three typefaces (Sompitra/Laoka/chat in Segoe UI, W.A.Y in Jakarta);
  //   • a colour picture (emoji) glued to every card title, so headings wore a
  //     different hue on every OS and never matched the module they sat in;
  //   • the module's colour existed only in the tab bar, so a Sompitra screen
  //     was green-and-red inside a teal tab.
  // None of them is visible to a functional test, which is exactly why they
  // survived this long.
  const PAGES = ['/', '/budget', '/chat', '/way/', '/laoka/', '/settings']
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
  const activeTabColour = (html) => {
    const bar = tabBarHtml(html)
    if (!bar) return null
    const active = bar.split('<a href=').slice(1).map((a) => '<a href=' + a)
      .find((a) => a.includes('aria-current="page"')) || ''
    return ((active.match(/--tab:(#[0-9a-fA-F]{6})/) || [])[1] || '').toLowerCase() || null
  }

  for (const p of PAGES) {
    const html = await body(await req(p))

    // ONE typeface. W.A.Y, Laoka and the chat room each shipped their own
    // family, so the same screen could render in two faces depending on which
    // tab you came from. Every document must load the one brand family, and
    // the family must be FIRST in the body rule (a fallback-only match would
    // pass while the page still renders in Segoe UI).
    check(`${p}: loads the one brand typeface`,
      /fonts\.googleapis\.com\/css2\?family=Plus\+Jakarta\+Sans/.test(html),
      'no Plus Jakarta Sans request — this page falls back to the system face')
    check(`${p}: the brand face is what the page actually uses`,
      /body\s*\{[^}]*font-family:\s*'Plus Jakarta Sans'/.test(html),
      'the body font stack does not start with the brand family')

    // ONE colour per screen, and it must be the SAME value as the tab that got
    // you there. The accent is what the headings, the header hairline and the
    // section sub-nav all read, so a mismatch here means the screen disagrees
    // with its own tab.
    const accent = ((html.match(/--accent:\s*(#[0-9a-fA-F]{6})/) || [])[1] || '').toLowerCase()
    const ink = ((html.match(/--accent-ink:\s*(#[0-9a-fA-F]{6})/) || [])[1] || '').toLowerCase()
    const active = activeTabColour(html)
    check(`${p}: the screen accent IS the active tab's colour`,
      !!accent && !!active && accent === active,
      `--accent=${accent || '(none)'} vs active tab ${active || '(none)'}`)
    // …and the filled variant exists and is darker, because white text on the
    // tint is under 4.5:1 (white on #0d9488 measures 3.9:1).
    check(`${p}: a filled surface uses the darker ink variant`,
      /^#[0-9a-f]{6}$/.test(ink) && ink !== accent,
      `--accent-ink=${ink || '(none)'} — using the tint as a button background is a contrast bug`)

    // The themed chrome: a module tab runs in a framed stage, and the ring is
    // what makes it a panel of Home rather than a second app underneath it.
    if (['/chat', '/way/', '/laoka/'].includes(p)) {
      check(`${p}: the module runs in the framed stage, not edge to edge`,
        /id="home-module-stage"/.test(html) && /id="home-module-frame"/.test(html),
        'the module is not inside #home-module-stage/#home-module-frame')
      check(`${p}: the stage is inset and rounded (one app, not a pasted-in app)`,
        /#home-module-stage\s*\{[^}]*padding/.test(html) && /#home-module-frame[^{]*\{[^}]*border-radius/.test(html),
        'the stage lost its inset or its rounding')
    }
  }

  // Headings wear a brand glyph, never an emoji. An emoji is a colour picture
  // the OS chooses: it cannot take the accent colour, it changes size and
  // baseline per platform, and it made every card title look like a different
  // app. Emoji that ENCODE something (the Kiné legend, category icons, the
  // per-person colour dots) are data and are not inside a heading, so reading
  // the headings is a safe way to assert this.
  for (const p of ['/', '/budget', '/settings']) {
    const html = await body(await req(p))
    const headings = html.match(/<h3[\s\S]*?<\/h3>/g) || []
    const withEmoji = headings.filter((h) => EMOJI.test(h))
    check(`${p}: no card heading is an emoji`, headings.length > 0 && withEmoji.length === 0,
      withEmoji.length ? `emoji heading: ${withEmoji[0].replace(/<[^>]*>/g, '').trim().slice(0, 40)}` : 'no headings found')
    check(`${p}: card headings carry the brand glyph in the screen accent`,
      headings.some((h) => h.includes('section-title') && h.includes('accent-mark')),
      'headings are plain text again — the icon set is not wired up')
  }

  // The horizontal-scroll trap: a grid item's automatic minimum size is its
  // min-content width, and a transaction description is rendered with
  // `truncate` (white-space: nowrap). One long description — a Laoka import
  // reads "Laoka shopping 2026-09-12 – 2026-09-18" — then widens the whole
  // page past the viewport, which is invisible on a screenshot of the top and
  // is exactly what a phone user hits.
  const dash = await body(await req('/'))
  // Names are matched as they appear in the HTML: JSX escapes the "&" in
  // "Debts &amp; Credits", and a check that misses it reads as a missing card.
  for (const card of ['Recent Transactions', 'Debts &amp; Credits']) {
    const at = dash.indexOf(card)
    check(`the ${card} card cannot push the page sideways`,
      at > 0 && dash.slice(Math.max(0, at - 700), at).includes('min-w-0'),
      'the card lost min-w-0 — a long description will force a horizontal scrollbar')
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
