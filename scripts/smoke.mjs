#!/usr/bin/env node
// ─── Home smoke test ─────────────────────────────────────────────
// End-to-end local checks against a RUNNING wrangler dev server.
// No test framework, no dependencies — plain Node 18+ (fetch/getSetCookie,
// plus node:fs to read repo sources: CUTOVER.md, whose post-deploy step names
// a value the Durable Object has to report (section 12), and the WAY Durable
// Object, whose live push must carry the accuracy the HUD falls back to
// (section 9b)).
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
// The checks run in NUMBERED SECTIONS (banners in this file), and the docs
// (AGENTS.md, README.md, project.md) cite them by those numbers — so the
// numbers are a contract: renumbering a banner breaks every citation.
//   1. the server answers                11. two channels per person
//   2. one login, all cookies            12. the chat is the ONE feed
//   3. every tab renders                 13. Laoka's list reaches Sompitra
//   4. module APIs                       14. a template can be forgotten
//   5. chrome consistency                15. the map clock + the tracking laws
//   6. modules are session-gated         16. Android install, both shapes
//   7. bad credentials                   17. Laoka inside the shell
//   8. auto-repair from home_session     18. one brand, one colour per screen
//   9. no silent map reversion           19. the silent gates become readable
//   9b. the HUD reads what the tracker sends
//  10. unified settings & channels
// Exit code 0 = all green, 1 = something regressed.

import { readFileSync } from 'node:fs'

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

/** The desktop nav's markup only. Scoped on purpose: a check that searched the
    whole page for something BELOW the nav would pass on the tab bar's copy of
    it (this is how the unread-dot guard first passed while the dot was missing
    from the nav — found by falsifying it). */
function navHtml(html) {
  const m = html.match(/<nav id="home-nav"[\s\S]*?<\/nav>/)
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
  // The Chat tab's unread cue: one hook in the tab bar (bottom, phone) and one
  // in the header nav (desktop), because the bar is hidden from md up and a dot
  // in the hidden one would simply never be seen.
  check(`${p}: the Chat tab can show an unread dot in both bars`,
    bar.includes('data-chat-unread') && navHtml(html).includes('data-chat-unread'),
    bar.includes('data-chat-unread') ? 'the desktop nav has no unread hook' : 'no [data-chat-unread] in the tab bar')
  check(`${p}: the unread dot's poll runs on this page`,
    html.includes('chat_last_seen') && html.includes('/way/api/chat/latest'),
    'the dot has no state script — it could never light up')
}

// The watermark that dot polls. One row from the Durable Object, not D1: the
// flush is nightly, so today's messages exist only in the DO, and "has anything
// arrived since I last looked" is exactly the question D1 cannot answer.
{
  const r = await req('/way/api/chat/latest')
  let d = null
  try { d = JSON.parse(await body(r)) } catch (e) {}
  check('the chat watermark answers with a timestamp and an id (the nav dot polls this)',
    r.status === 200 && !!d && 'at' in d && 'id' in d,
    `status ${r.status} body=${JSON.stringify(d).slice(0, 80)}`)
  const savedJar = new Map(jar)
  jar.clear()
  const anon = await req('/way/api/chat/latest')
  jar.clear(); for (const [k, v] of savedJar) jar.set(k, v)
  check('the chat watermark is session-gated', anon.status === 401,
    `${anon.status} — an anonymous caller read the room's watermark`)
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

// ─── 9b. the HUD reads what the tracker actually sends ───────────
log('\n9b. WAY HUD says only what it knows')
// Three readouts on the same card were misleading in three different ways:
// a battery slot that can never fill (μlogger sends no level AND the live push
// never carried the field -> permanent "n/a"), an age that printed "-1s ago"
// whenever a phone's clock ran a second ahead, and an address that vanished on
// the next ping because renderBadges() rebuilds the badge it was written into.
{
  const way = await body(await req('/way/index.html'))
  check('no permanent n/a readout in the served WAY document',
    !/[:=]\s*'n\/a'/.test(way) && !way.includes('>n/a<'),
    'the dead battery placeholder is back in the HUD')
  check('the HUD health slot falls back to GPS accuracy',
    way.includes('id="hud-meta"') && way.includes('function accuracyLabel') && /accuracyLabel\(p\.accuracy\)/.test(way),
    'the accuracy fallback is gone, so the slot can only ever say n/a again')
  check('the client maps accuracy off the wire',
    /accuracy: \(raw\.accuracy !== undefined/.test(way),
    'toPing drops accuracy, so the HUD fallback can never fire no matter what the server sends')
  check("the HUD age is clamped (a phone a second ahead printed '-1s ago')",
    /Math\.max\(0, \(Date\.now\(\) - new Date\(p\.timestamp\)\.getTime\(\)\) \/ 1000\)/.test(way),
    'the negative clock skew is back')
  // The speed readout is the one number this card exists for. It was 38px;
  // the check asserts it is BIGGER than that rather than naming a size, so a
  // future tweak is free but shrinking it back is not silent.
  const spd = way.match(/\.spd-num \{ font-size: (\d+)px/)
  const speedBigger = !!spd && Number(spd[1]) > 38
  const cardWidened = /#speedo-container \{[^}]*width: 1[5-9]\dpx/.test(way)
  check('the speed readout is larger than it was (38px), and the card kept up',
    speedBigger && cardWidened,
    !spd ? 'the .spd-num size rule is gone'
      : !speedBigger ? `the speed is ${spd[1]}px — not larger than the 38px it was widened from`
      : 'the HUD card was not widened for the bigger number')
  // The two '--' placeholders (Waiting / No signal) are inline-styled, so they
  // do not follow `.spd-num`; they are checked here so a resize of the readout
  // cannot leave the empty states looking like a different size.
  check('the empty HUD states scaled with it',
    way.includes('font-size:26px;">--</div>') && way.includes('font-size:29px;">--</div>'),
    'the Waiting / No signal placeholders did not scale with the readout')
  check('address lines take the house number and never repeat a word',
    way.includes('function describeAddress') && way.includes('house_number') && /seen\[candidates\[i\]\]/.test(way),
    'address lines can repeat the same word or drop the street number')
  check('a resolved address is cached as TEXT and re-applied',
    way.includes('function cachedAddressLines') && way.includes('applyAddressLines(devId, lines)'),
    'the address is written once and dropped by the next badge rebuild')
  check('the address cache survives a reload',
    way.includes("localStorage.setItem('way_addresses'"),
    'the address vanishes on every page reload')
  check('Nominatim stays throttled (one resolve per 20 s / 150 m, never while parked where it is known)',
    /const parkedHere = !!last\.is_stationary/.test(way) && way.includes('>= 20 * 1000') && way.includes('movedM > 150'),
    'the fetch gate changed shape — check the request rate before trusting it')

  // Accuracy reaches the HUD live only if the Durable Object puts it in the
  // payload: the D1 history rows already carry it, the WebSocket push did not.
  let doSrc = ''
  try { doSrc = readFileSync(new URL('../src/way/do/FleetDO.ts', import.meta.url), 'utf8') } catch (e) {}
  check('the live position push carries accuracy',
    /type: "position"[\s\S]{0,400}?accuracy,/.test(doSrc),
    'the DO drops accuracy from the live push, so the HUD can only show it after a reload')
  check('the snapshot-on-connect (lastStatus) carries accuracy',
    /const lastStatus: LiveDeviceStatus = \{[\s\S]{0,300}?accuracy,/.test(doSrc),
    'the DO drops accuracy from lastStatus — a fresh page shows a dash until the next ping')
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

  // The household card and its POST handlers must follow the CENTRAL role, not
  // only Sompitra's `is_admin`: a Home admin whose module row predates the merge
  // carries is_admin = 0 there (CUTOVER.md §1c), which is how the links to
  // /admin and /admin/diagnostics vanished from this page for a real admin.
  let settingsSrc = ''
  try { settingsSrc = readFileSync(new URL('../src/routes/settings.tsx', import.meta.url), 'utf8') } catch (e) {}
  // Counted, not merely present: the first version of this check was satisfied by
  // the helper ALONE, so putting the rendered card back on the module flag left
  // it green — found by falsifying it. Each half is pinned separately: the
  // helper's read of the central role, the card's own judgement, all three POST
  // sites, and the absence of any handler left on the module flag alone.
  const adminSites = (settingsSrc.match(/isSettingsAdmin\(/g) || []).length - 1   // minus the definition
  // …and the helper's own body, not a window that could reach into the render
  // below it (a 900-char window did, and stayed green with the helper gutted).
  const adminFn = (() => {
    const at = settingsSrc.indexOf('async function isSettingsAdmin(')
    if (at === -1) return ''
    const end = settingsSrc.indexOf('\n}', at)
    return settingsSrc.slice(at, end === -1 ? at + 900 : end)
  })()
  check('the settings admin surface follows the central role, not only the module flag',
    /home\?\.role === 'admin'/.test(adminFn) &&
    /const isAdmin = home\?\.role === 'admin' \|\| user\.is_admin === 1/.test(settingsSrc) &&
    adminSites === 3 &&
    !/user\.is_admin !== 1/.test(settingsSrc),
    `settings gates on Sompitra's is_admin alone (helper reads the central role: ${/home\?\.role === 'admin'/.test(adminFn)}; card: ${/const isAdmin = home\?\.role === 'admin'/.test(settingsSrc)}; admin POST sites on the helper: ${adminSites}/3) — a central admin can be locked out of the household card, and with it the link to /admin`)
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

    // CUTOVER.md's post-deploy step tells a human to expect one specific build
    // marker, and that sentence rots the moment the marker is bumped -- it
    // already had (v3-system-chat -> v5-two-channels). A runbook whose
    // verification step names the wrong value is worse than no step, because
    // it reads as a failed deploy.
    let docMarker = null
    try {
      const doc = readFileSync(new URL('../CUTOVER.md', import.meta.url), 'utf8')
      docMarker = (doc.match(/expect build ([a-z0-9-]+)/) || [])[1] || null
    } catch (e) {}
    check("CUTOVER.md's DO build marker matches the DO",
      !!docMarker && docMarker === d?.build,
      `CUTOVER.md says "${docMarker ?? 'nothing'}", the DO reports "${d?.build ?? 'unreadable'}" — the runbook's verification step is stale`)
  }

  const chat = await body(await req('/chat/index.html'))
  // The composer's contract: a frame the socket refused must leave the text
  // where it was. The old order cleared the box first, so a message typed
  // while the phone was asleep vanished with no trace.
  check('a message typed on a dead socket is kept, not silently swallowed',
    /function sendWs[\s\S]{0,600}return true[\s\S]{0,120}return false/.test(chat) &&
    chat.includes('if (!sendWs(payload))') &&
    chat.indexOf("input.value = ''") > chat.indexOf('if (!sendWs(payload))'),
    'the composer clears before the send is known to have gone out, so a closed socket eats the message with no trace')
  check('chat styles expense events', /AUTO_STYLE[\s\S]{0,600}expense\s*:/.test(chat) && chat.includes('.system-msg.expense .text'), 'expense event type has no styling')
  check('chat styles income events', /AUTO_STYLE[\s\S]{0,600}income\s*:/.test(chat) && chat.includes('.system-msg.income .text'), 'income event type has no styling')
  check('chat styles kine events', /AUTO_STYLE[\s\S]{0,600}kine\s*:/.test(chat) && chat.includes('.system-msg.kine .text'), 'kine event type has no styling')
  // The entry timer ("MaxX is ~30s from Home") is an activity row like entry and
  // exit. Without a style it still renders -- as a plain grey system line,
  // which reads as "some event" rather than "someone is about to arrive".
  check('chat styles the WAY approach timer like the other activity rows',
    /AUTO_STYLE[\s\S]{0,900}approach\s*:/.test(chat) && chat.includes('.system-msg.approach .text'),
    'the "~30s from Home" row has no style or no entry in AUTO_STYLE')
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
  // between Sompitra actually READING the `laoka` database and merely echoing a
  // guard. (The probe label is the real database name, not `laoka-db`.)
  check(
    'an unknown week is a LOOKUP miss, so laoka is really read',
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
  const zone = fnBody(way, 'followZoneRadiusPx')
  const landing = Number((way.match(/FOLLOW_PULL_LANDING: ([0-9.]+)/) || [])[1])
  check('the camera is the only thing that moves the map',
    !!cam && cam.includes('panBy(') && !!zone && zone.includes('FOLLOW_ZONE_DIAMETER_FRACTION') &&
    // A circle, off the SHORTER side, so it can never reach the corners the
    // HUD and the badge strip own.
    zone.includes('Math.min(size.x, size.y)') &&
    (way.match(/map\.panBy\(/g) || []).length === 1 &&
    // The per-ping pan is the bug this replaced: it must not come back anywhere.
    !/map\.panTo\(/.test(way),
    'the camera should be one panBy() from updateFollowCamera, off a screen-fraction CIRCLE, and panTo() should be gone')

  // The camera is a CYCLE, and the cycle has three load-bearing parts: the zone
  // is a circle, the sweep goes to the OPPOSITE edge (the whole point of it --
  // twice the drift per recentre), and it lands a hair INSIDE that edge, since
  // landing exactly on it would re-arm the trigger on the same frame.
  check('the camera roams a circle, shoves through its edge, then sweeps to the far side',
    !!cam && /followCam\.phase = 'push'/.test(cam) && /followCam\.phase = 'pull'/.test(cam) &&
    cam.includes('followCam.pushUntil') && cam.includes('at.distanceTo(center) <= radius') &&
    cam.includes('at.subtract(center)') &&
    // the sweep runs from the edge crossed to the aim, one eased step at a time
    cam.includes('gap.add(aim.subtract(gap).multiplyBy(pullEase(t)))') &&
    // WHERE it lands, numerically: strictly inside the circle (a landing ON it
    // leaves the device outside on the frame the pull ends, and the trigger
    // then fires forever) and not so far inside that the sweep barely moves.
    landing > 0.6 && landing < 1 &&
    // the old box/edge-pinned shapes must be gone, not merely unused
    !/halfX|halfY/.test(way) && !way.includes('FOLLOW_GLIDE_DURATION') &&
    !way.includes('FOLLOW_DEAD_ZONE_SCREEN_FRACTION'),
    'the camera should run drift -> push -> sweep to the OPPOSITE edge of a circle, with the old box and its undo-the-overshoot glide gone')

  // A device that was TELEPORTED out of the circle -- a pace switch, a fresh WS
  // snapshot -- must land back INSIDE it, or the pull repeats for ever. The aim
  // is pinned to the circle for exactly that reason, and it is not the exit
  // offset mirrored.
  check('a teleported device lands back inside the circle, not outside it again',
    !!cam && cam.includes('followCam.aim = followCam.gap.multiplyBy(-(radius * CONFIG.FOLLOW_PULL_LANDING) / out)') &&
    cam.includes('const jump = out > radius * 2') && cam.includes('followCam.gap.distanceTo(L.point(0, 0))') &&
    // and a jump is not allowed to time the sweep as if it were a drift
    cam.includes('jump ? CONFIG.FOLLOW_PULL_MIN_MS'),
    'the sweep should aim at the point opposite the crossing ON the circle (never the mirrored exit offset, which a jump lands outside again), and a jump should not time it')

  // The sweep's LENGTH is measured, not configured: a ratio off the drift it
  // just watched, so the sweep looks the same relative to the movement at every
  // device speed. A fixed duration is what this replaced.
  check('the sweep is timed by the drift, not by a fixed number of seconds',
    !!cam && cam.includes('driftMs / CONFIG.FOLLOW_PULL_RATIO') &&
    cam.includes('CONFIG.FOLLOW_PULL_MIN_MS') && cam.includes('followCam.driftFrom = nowMs') &&
    !way.includes('FOLLOW_PULL_DURATION'),
    'the sweep should derive its duration from the drift it watched (FOLLOW_PULL_RATIO, floored by FOLLOW_PULL_MIN_MS), not a fixed FOLLOW_PULL_DURATION')

  check('the pull moves with the device instead of aiming at a point',
    !!cam && cam.includes('at.subtract(want)') &&
    cam.includes('map.panBy(delta, { animate: false, noMoveStart: true })') &&
    !cam.includes('setView('),
    'the pull should drive a live offset with per-frame panBy and no setView, so the device is still drawn while the gap closes')

  // Not just the ease's NAME -- its numbers, evaluated here. 0 -> 0 and
  // 1 -> 1 so the device lands ON the centre, and a small overshoot past it on
  // the way, which is the whole difference between a spring and a slide.
  {
    const pull = fnBody(way, 'pullEase')
    const spring = Number((way.match(/FOLLOW_PULL_SPRING: ([0-9.]+)/) || [])[1])
    let ok = false, why = 'pullEase is not in the served page'
    if (pull && spring) {
      try {
        const f = new Function('CONFIG', 'return function pullEase(t) ' + pull)({ FOLLOW_PULL_SPRING: spring })
        let peak = 0, peakAt = 0
        for (let i = 0; i <= 200; i++) { const v = f(i / 200); if (v > peak) { peak = v; peakAt = i / 200 } }
        ok = Math.abs(f(0)) < 1e-9 && Math.abs(f(1) - 1) < 1e-9 &&
             peakAt > 0.25 && peakAt < 0.9 && peak > 1.02 && peak < 1.12
        why = `pullEase(0)=${f(0).toFixed(4)} pullEase(1)=${f(1).toFixed(4)} peak=${peak.toFixed(4)} at t=${peakAt}`
      } catch (e) { why = 'pullEase would not evaluate: ' + e.message }
    }
    check('the pull eases out with a small overshoot (a spring, not a slide)', ok, why)
  }

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
    return at === -1 ? '' : way.slice(at, at + 1000)
  })()
  check('both paces are switchable from Settings -> Map, and the choice persists',
    mapSection.includes('data-pace="smooth"') && mapSection.includes('data-pace="live"') &&
    way.includes("localStorage.getItem('map_pace')") && way.includes("localStorage.setItem('map_pace'"),
    mapSection ? 'the pace pills are not in the Map settings section' : 'the Map settings section is gone from the served page')

  check('no pace switch floats over the map itself',
    !way.includes('pace-switch'),
    'a pace control is back in the map chrome — it belongs in Settings only')

  // The pace's one line moved OUT of the HUD (it was one readout too many on a
  // card about the device) and under the setting that owns it: blue, on a
  // transparent background, present on Smooth and REMOVED on Live.
  check('the pace readout left the HUD',
    !way.includes('hud-playback') && !way.includes('updatePlaybackBadge'),
    'the HUD is carrying the pace again — it belongs under the Map setting')
  const paceNote = fnBody(way, 'updatePaceNote')
  check('the pace line is under Settings -> Map, shown on Smooth and gone on Live',
    !!paceNote && paceNote.includes("mapPace === 'live'") && paceNote.includes("'none'") && paceNote.includes("'block'") &&
    mapSection.includes('id="pace-note"') && way.includes('.pace-note {') && way.includes('background: transparent'),
    paceNote ? 'the pace note is not tied to the pace, or has no transparent style' : 'updatePaceNote is not in the served page')

  // ── The approach pulse (the badge radar) ──
  // The push can be missed; the badge cannot, because it is on the screen while
  // the map is. The threshold that fires the push is the same one that arms the
  // pulse, and the pulse expires on WALL TIME -- 60s from the 60s trigger with
  // no 30s, 60s from the 30s trigger with no arrival -- never on a ping count.
  const handleApproachSrc = fnBody(way, 'handleApproach')
  const pulseFrom = fnBody(way, 'approachPulseFrom')
  check('the badge pulse is armed by the DO and expires on its own clock',
    !!handleApproachSrc && handleApproachSrc.includes('data.cleared') && handleApproachSrc.includes('dropExpiredPulses()') &&
    !!pulseFrom && pulseFrom.includes('APPROACH_PULSE_LINGER_MS') && pulseFrom.includes("'red'") && pulseFrom.includes("'yellow'") &&
    way.includes('APPROACH_PULSE_LINGER_MS: 60000'),
    'the approach pulse lost its 60s window, its two levels, or its clear handling')
  check('the pulse is yellow at 60s and red at 30s, on the card AND across the map',
    way.includes('.user-badge.approach-yellow') && way.includes('.user-badge.approach-red') &&
    way.includes('@keyframes approach-card-yellow') && way.includes('@keyframes approach-card-red') &&
    way.includes('@keyframes approach-sweep') && way.includes('prefers-reduced-motion'),
    'the pulse has no card styling, no second level, or no reduced-motion fallback')
  // The sweep must live OUTSIDE #badge-strip. That strip is a scroll container
  // (overflow-y: auto), so a ring growing out of a card is clipped to a ~170px
  // column — the first version of this cue was technically running and
  // practically invisible, which is what this check exists to prevent.
  check('the radar sweeps from its own layer, clear of the clipping badge strip',
    way.includes('id="approach-radar-layer"') &&
    way.indexOf('id="approach-radar-layer"') < way.indexOf('id="badge-strip"') &&
    /#approach-radar-layer \{ position: fixed;[^}]*pointer-events: none/.test(way) &&
    /#badge-strip \{[^}]*overflow-y: auto/.test(way),
    'the radar is inside the scrolling strip (or lost its own fixed layer), so the sweep is clipped to the badge column')
  // Two ways the sweep could go back to being a 170px smudge: a stroke that
  // thickens as the ring scales, or an outward ring drawn on the CARD (which
  // the strip clips). Kept as its own check so either one fails alone.
  // The stroke has to be inside the circles' OWN rule: a mention in a comment
  // satisfies a plain `includes()`, which is how this check first passed while
  // the declaration was mutated away (found by falsifying it).
  check('the rings stay a thin line on the way out, and nothing is drawn outside a card',
    /\.approach-radar circle \{[\s\S]{0,400}vector-effect: non-scaling-stroke/.test(way) &&
    /approach-card-yellow[\s\S]{0,400}inset 0 0 0 3px/.test(way) &&
    /approach-card-red[\s\S]{0,400}inset 0 0 0 3px/.test(way) &&
    // The card's emphasis is a 3px band drawn INWARD and nothing else: an
    // animated border-colour is an edge, and edges in this strip read thin.
    !/approach-card-(yellow|red)[\s\S]{0,400}border-color/.test(way),
    'either the stroke scales with the ring (a 2px line becomes a band at full stretch), the card band is no longer 3px inset, or the card animates an OUTWARD edge again')
  const rb = fnBody(way, 'renderBadges')
  check('a badge rebuild re-applies the pulse instead of dropping it',
    !!rb && rb.includes('dropExpiredPulses()') && rb.includes("'approach-' + pulse.level") &&
    rb.includes('badge-approach-note') && rb.includes('renderApproachRadar()'),
    'renderBadges no longer reads approachPulses (or no longer re-anchors the radar) — a ping mid-approach would wipe or misplace the cue')
  // The card is small: the countdown must TAKE the status line ("Live", "4 Min
  // Ago"), not add a row under it.
  check('the approach line replaces the status line without growing the card',
    /const statusRow = pulse[\s\S]{0,300}badge-status-row/.test(rb || '') &&
    /badge-status-row[\s\S]{0,220}badge-approach-note/.test(rb || '') &&
    !(rb || '').includes('pulseHtml') &&
    // One ellipsised line: a long fence name must not wrap it into rows.
    /\.badge-approach-note \{[^}]*white-space: nowrap/.test(way),
    'the pulse grew a line of its own again, stopped taking the status row, or can wrap a long place name into several rows')
  const radar = fnBody(way, 'renderApproachRadar')
  check('every radar is anchored on a real badge and finds its device',
    !!radar && radar.includes('data-device') && way.includes("badge.setAttribute('data-device', devId)") &&
    way.includes('function positionApproachRadar') && way.includes('getBoundingClientRect()'),
    'the radar is not tied to a badge element, so it would float in the wrong place (or not at all)')
  check('crossing into a fence stops the pulse without waiting for a frame',
    /is_inside_geofence && approachPulses\[devId\]/.test(way) && way.includes("data.type === 'approach'"),
    'the ping path does not clear the pulse on entry, or the frame is never handled')

  // A save that never reached the server must not look like nothing happened.
  // `fetch` REJECTS on a dead network, and both apiJson and its callers used to
  // let that rejection escape: no alert, no state change, no clue -- the exact
  // shape of "I set it and it did not save".
  check('a network failure answers like every other failure, not as silence',
    /async function apiJson[\s\S]{0,900}catch[\s\S]{0,220}ok: false[\s\S]{0,60}status: 0/.test(way),
    'a rejected fetch escapes apiJson again, so a save that never reached the server is invisible')
  check('a non-numeric radius is refused out loud, not silently discarded',
    /Number\.isFinite\(n\)[\s\S]{0,140}Entry radius must be a positive number/.test(way) &&
    /Number\.isFinite\(n\)[\s\S]{0,140}Exit radius must be a positive number/.test(way),
    'typing a unit or a comma into a radius field ("100m") silently falls back to the default instead of saying so')

  // …and the server half, in the DO's own source: the pulse must come from the
  // SAME code path as the notification, or the two can disagree about whether
  // someone is arriving at all.
  let doSrc = ''
  try { doSrc = readFileSync(new URL('../src/way/do/FleetDO.ts', import.meta.url), 'utf8') } catch (e) {}
  check('the DO arms the pulse from the notify threshold, and clears it on arrival / re-arm',
    /this\.setApproachPulse\(/.test(doSrc) &&
    // two call sites (arrival, re-arm) plus the helper's own body
    (doSrc.match(/clearApproachPulse\(/g) || []).length >= 3 &&
    /type: "approach"/.test(doSrc),
    'the DO no longer broadcasts the pulse, so the badge can only lag the notification')
  check('the snapshot carries in-flight pulses with their age',
    /approaches/.test(doSrc) && /ageMs/.test(doSrc),
    'a reload mid-approach would either lose the pulse or restart its window')
  // One crossed threshold has THREE effects and they must all come from the
  // same place: the badge pulse, the chat row, and the ntfy push. The chat row
  // is the one the family reads afterwards -- the push can be missed, muted or
  // eaten by quiet hours, so a threshold that only pushes is a threshold the
  // household cannot see. (Entry/exit have always written a row; the timer
  // never did, which is why the 60/30s push looked "missing" in the chat.)
  const thresholdBlock = (doSrc.match(/for \(const threshold of APPROACH_THRESHOLDS\) \{([\s\S]*?)break;/) || [])[1] || ''
  check('a crossed threshold arms the pulse, writes the chat row and pushes',
    !!thresholdBlock &&
    thresholdBlock.includes('setApproachPulse(') &&
    thresholdBlock.includes('handleChatMessage(') &&
    /eventType: "approach"/.test(thresholdBlock) &&
    thresholdBlock.includes('notifyEvent('),
    thresholdBlock ? 'the threshold block is missing one of its three effects (pulse / chat row / push)' : 'maybeNotifyApproach no longer loops APPROACH_THRESHOLDS')
  // And the row is UNCONDITIONAL, like entry/exit: it must not sit behind the
  // subscription check that notifyEvent does its own filtering inside.
  check('the approach chat row is written even when nobody subscribed',
    !!thresholdBlock && !/if \([^)]*subscriptions[^)]*\)[\s\S]{0,200}handleChatMessage/.test(thresholdBlock),
    'the chat row is inside a subscription guard — a quiet-hours or unsubscribed threshold would vanish from the record')

  // ── Anything above 120 km/h is GPS jitter, in BOTH directions the number can
  // arrive. The position check (isGlitch) catches a ping that MOVED impossibly
  // far; μlogger's speed field travels with the ping independently of the
  // coordinates it was captured at, so a device claiming 250 km/h while moving
  // plausibly slips past it — and that number then reaches the classification,
  // the rolling average, the live HUD, the stored row and the approach ETA.
  // Both halves must read ONE constant, and the report must be DISCARDED (null)
  // rather than clamped: a clamp would invent a 120 km/h drive out of jitter.
  // (Comments stripped first — the explaining comment here names the same
  // strings, which is how a source guard passes on its own prose.)
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  let cfgSrc = '', smSrc = '', doCode = ''
  try { cfgSrc = strip(readFileSync(new URL('../src/way/config.ts', import.meta.url), 'utf8')) } catch (e) {}
  try { smSrc = strip(readFileSync(new URL('../src/way/lib/state-machine.ts', import.meta.url), 'utf8')) } catch (e) {}
  try { doCode = strip(doSrc) } catch (e) {}
  check('the 120 km/h jitter limit lives in config and reaches both halves from there',
    /PRE_FILTER_SPEED_LIMIT:\s*120(\.0)?\b/.test(cfgSrc) &&
    /const PRE_FILTER_SPEED_LIMIT = WAY_CONFIG\.PRE_FILTER_SPEED_LIMIT/.test(doCode) &&
    /PRE_FILTER_SPEED_LIMIT/.test(smSrc),
    'the limit is missing from config.ts, from the DO\'s alias, or from the state machine — so the halves can drift apart')
  check('a reported speed above the limit is discarded before the state machine sees it',
    /reportedVel > PRE_FILTER_SPEED_LIMIT/.test(doCode) &&
    doCode.includes('ping.vel = null') &&
    doCode.indexOf('ping.vel = null') < doCode.indexOf('processPing(stored.motion'),
    'the intake keeps an impossible report (or filters it after processPing), so 250 km/h can reach the HUD and the stored rows')
  check('the report is discarded, not clamped into a 120 km/h drive',
    !/Math\.min\([^)]*PRE_FILTER_SPEED_LIMIT/.test(doCode),
    'the report is being clamped instead of dropped — that invents a fast drive out of a jitter ping')
  check('the state machine also refuses an impossible reported speed',
    /ping\.vel <= PRE_FILTER_SPEED_LIMIT/.test(smSrc),
    'a caller of processPing can still inject a >120 km/h report into the classification and the average')
  check('the position-implied jitter check still runs before the state machine',
    doCode.indexOf('isGlitch(') > -1 &&
    doCode.indexOf('isGlitch(') < doCode.indexOf('processPing(stored.motion'),
    'the glitch filter no longer precedes processPing, so an impossible jump would be classified as movement')

  // ── …and a pair stamped in the SAME SECOND is judged, not skipped. That
  // branch (dt <= 0 -> "not a glitch") let two same-second fixes kilometres
  // apart pass unnoticed — a latent hole, not the 2026-09-19 triangle's cause
  // (there the wild ping arrived alone after a multi-hour silence). The floor
  // is the stamp resolution (1 s), so at most 33 m at the 120 limit can hide
  // under it.
  const floorMatch = /GLITCH_TIME_FLOOR_S:\s*([0-9.]+)/.exec(cfgSrc)
  const limitMatch = /PRE_FILTER_SPEED_LIMIT:\s*([0-9.]+)/.exec(cfgSrc)
  const floorS = floorMatch ? Number(floorMatch[1]) : NaN
  const limitKmh = limitMatch ? Number(limitMatch[1]) : NaN
  const sameSecondKmh = (distKm) => (distKm / floorS) * 3600
  check('a same-second pair is judged against the stamp floor, never skipped',
    /dtSec > 0 \? dtSec : GLITCH_TIME_FLOOR_S/.test(smSrc) &&
    !/if \(dtSec <= 0\) return false/.test(smSrc) &&
    /const GLITCH_TIME_FLOOR_S = WAY_CONFIG\.GLITCH_TIME_FLOOR_S/.test(smSrc) &&
    /GLITCH_TIME_FLOOR_S/.test(cfgSrc),
    'the jitter gate steps aside for same-second pings again — a same-second teleport rides through the 120 limit unnoticed')
  check('the floor separates a harmless same-second pair from the teleport',
    sameSecondKmh(0.007) <= limitKmh && sameSecondKmh(2.360) > limitKmh,
    `at a ${floorS} s floor a 7 m same-second pair must pass and a 2.36 km one must fail (limit ${limitKmh})`)

  // ── …and the ACCURACY gate: the server-side half of µlogger's own
  // minimum-accuracy setting. The client filter works (production: 0 rows over
  // 10 m from Niri in 10,960, exactly one in all 14,353, from before the
  // setting), but it is a phone setting -- one config change, or a different
  // client, and the backend would trust whatever arrives. Note honestly what
  // it would NOT have caught: the 2026-09-19 wild fix claimed 9.6 m.
  check('the accuracy limit lives in config and reaches the gate from there',
    /PRE_FILTER_MAX_ACCURACY_M:\s*10(\.0)?\b/.test(cfgSrc) &&
    /const PRE_FILTER_MAX_ACCURACY_M = WAY_CONFIG\.PRE_FILTER_MAX_ACCURACY_M/.test(smSrc),
    'the accuracy limit is missing from config.ts or the state machine — only the phone-side setting would enforce it')
  check('an over-limit fix is dropped before the state machine sees it',
    doCode.indexOf('accuracyIsAcceptable(') > -1 &&
    doCode.indexOf('accuracyIsAcceptable(') < doCode.indexOf('processPing(stored.motion'),
    'the intake no longer refuses a fix its own receiver rated worse than the limit, or checks it after processPing')
  check('the accuracy gate accepts an omitted field (null is not a bad measurement)',
    /if \(accuracy === null\) return true/.test(smSrc),
    'a ping without the accuracy field is now dropped — an omitted measurement is not a bad one, and every real µlogger ping sets it')
  check('the accuracy gate keeps a fix at exactly the limit, not only below it',
    /accuracy <= PRE_FILTER_MAX_ACCURACY_M/.test(smSrc) &&
    !/accuracy < PRE_FILTER_MAX_ACCURACY_M/.test(smSrc),
    'the comparison is strict, so a fix µlogger itself accepts (exactly 10 m) would be dropped server-side')

  // ── The other half of "is this number real?": a REPORTED speed is believed
  // only when the coordinates corroborate it. A parked phone indoors reports
  // 5-30 km/h from its GNSS chip while its fixes stay inside a few metres — and
  // those fixes are accurate to a couple of metres, which is exactly why
  // ulogger's accuracy filter cannot catch it. Believed, that number makes a
  // device on a table look like it is driving: the point is persisted as a
  // track dot, its distance lands in the driven totals, and the approach ETA is
  // built from it.
  const flat = (s) => s.replace(/\s+/g, ' ')
  check('a reported speed is only used when the device actually moved',
    (smSrc.match(/reportedSpeedIsCredible\(/g) || []).length >= 2 &&
    /reportedSpeedIsCredible\(s\.lastLat, s\.lastLon, s\.lastTs/.test(flat(smSrc)),
    'processPing believes any report again, so a parked phone counts as driving')
  check('the movement threshold lives in config and the helper reads it',
    /REPORTED_SPEED_MIN_MOVE_M:\s*20(\.0)?\b/.test(cfgSrc) &&
    /const REPORTED_SPEED_MIN_MOVE_M = WAY_CONFIG\.REPORTED_SPEED_MIN_MOVE_M/.test(smSrc) &&
    />= REPORTED_SPEED_MIN_MOVE_M/.test(smSrc),
    'the threshold is missing from config.ts, or copied into the helper instead of read from it')
  const corrobAt = doCode.indexOf('!reportedSpeedIsCredible(')
  const corrob = corrobAt === -1 ? '' : doCode.slice(corrobAt, corrobAt + 600)
  check('the intake replaces an uncorroborated report before the state machine sees it',
    corrobAt > -1 && corrobAt < doCode.indexOf('processPing(stored.motion') &&
    /ping\.vel = speedFromPositions\(/.test(corrob),
    'the intake trusts the report (or filters it after processPing): a parked phone then draws a track and inflates the driven totals')
  check('…replaced, not blanked, so a parked device never reads "No signal"',
    // The assignment specifically: the `!== null` guards in the same block
    // contain "= null" too, so a loose regex passes while the field is dropped.
    !!corrob && /ping\.vel = speedFromPositions\(/.test(corrob) && !/ping\.vel = null/.test(corrob),
    'the uncorroborated report is discarded, which blanks the HUD speed on a device that is merely parked')
  check('a stationary device reads Stationary in the HUD, not a phantom number',
    /is_inside_geofence \|\| p\.is_stationary/.test(way) && /Stationary/.test(way),
    'the speedo has no stationary branch, so the phantom number would be printed')

  // ── An exit can only START from a crossing the app WATCHED. This is the
  // 2026-09-19 parked-phone triangle: the wild fix arrived ALONE after a
  // multi-hour silence, where the implied speed is ~0.5 km/h, so no distance
  // threshold can see it. It still started an exit, `exitBoundaryPoint`
  // interpolated a crossing nobody observed (that row sat exactly on the exit
  // radius, carrying the wild ping's timestamp but the confirming ping's
  // accuracy), and the guard then confirmed on wall time -- "left Home" at
  // 14:21:10, a 2.36 km leg and 2.146 km of phantom distance. The witness gap
  // must be checked BEFORE the EXITING transition, and everything about an
  // unwitnessed crossing must stay unwritten, undrawn and unannounced.
  const witnessGapMatch = /EXIT_WITNESS_GAP_S:\s*([0-9.]+)/.exec(cfgSrc)
  const witnessGapS = witnessGapMatch ? Number(witnessGapMatch[1]) : NaN
  const exitAt = smSrc.indexOf('s.geoState = "EXITING"')
  const witnessAt = smSrc.indexOf('gapS > EXIT_WITNESS_GAP_S')
  check('an exit can only start from a crossing the app watched leave',
    witnessAt > -1 && exitAt > -1 && witnessAt < exitAt &&
    /const EXIT_WITNESS_GAP_S = WAY_CONFIG\.EXIT_WITNESS_GAP_S/.test(smSrc) &&
    /EXIT_WITNESS_GAP_S:\s*120(\.0)?\b/.test(cfgSrc),
    'the exit transition no longer tests how long the device was silent — an interpolated fence crossing can start a track and a departure event again')
  check('the witness gap sits between the move cadence and a parked silence',
    witnessGapS >= 60 && witnessGapS <= 600,
    `EXIT_WITNESS_GAP_S = ${witnessGapS}: too tight (a real departure at a 15-30 s cadence would be unwitnessed) or too loose (a parked phone's multi-minute gaps would be)`)
  check('an unwitnessed crossing fabricates nothing and stays silent',
    /s\.geoState = "UNKNOWN"/.test(smSrc) &&
    /s\.pendingExitEdge = null/.test(smSrc) &&
    /s\.settlePending = true/.test(smSrc) &&
    /unwitnessed: true/.test(smSrc),
    'the unwitnessed branch must resolve to UNKNOWN, drop the stashed edge point and arm the settle re-anchor — otherwise a crossing nobody saw still draws and announces itself')
  check('the next ping after an unwitnessed crossing re-anchors with zero distance',
    /if \(s\.settlePending\)/.test(smSrc) &&
    /resetMotionAnchor\(s, lat, lon, dt\)/.test(smSrc) &&
    /distance: 0\.0, isStationary: false/.test(smSrc),
    'a jump nobody watched would keep its leg and its distance')
  check('the DO writes, announces and counts nothing for an unwitnessed ping',
    /!unwitnessed && this\.shouldPersistTrackPoint\(result\)/.test(doCode) &&
    /if \(!unwitnessed\) this\.maybeNotifyApproach/.test(doCode) &&
    /stored\.lastStatus && !unwitnessed/.test(doCode),
    'an unwitnessed ping can reach history, the approach timer or the movement pushes')
  // Scoped to the event function's own body (declaration -> the method after
  // it), so a later edit anywhere else in the DO cannot satisfy this check.
  const evAt = doCode.indexOf('private maybeLogGeofenceEvent(')
  const evEndAt = doCode.indexOf('private handleChatMessage(')
  const evBlock = evAt === -1 ? '' : doCode.slice(evAt, evEndAt > evAt ? evEndAt : evAt + 2000)
  check('no fence event fires from an unwitnessed crossing',
    evBlock.length > 0 &&
      !/UNKNOWN|unwitnessed/.test(evBlock) &&
      /next\.geoState === "CONFIRMED_INSIDE"/.test(evBlock) &&
      /prior\.geoState === "EXITING" && next\.geoState === "OUTSIDE"/.test(evBlock),
    'the arrival/departure branches must stay keyed on witnessed transitions only — an entry comes from outside, a departure is the completed EXITING -> OUTSIDE walk')
  check('the dashboard does not draw an unwitnessed ping either',
    /!raw\.unwitnessed && shouldDrawPoint\(ping\)/.test(way),
    'the live map adds the unwitnessed point to the trail — a leg nobody earned')

  // ── An exit must WALK all three phases: CONFIRMED_INSIDE -> EXITING ->
  // OUTSIDE. This is the phase rule itself, checked structurally: OUTSIDE has
  // exactly one assignment in the state machine, and it sits behind both the
  // witness test above and the 30 s exit guard, so no single ping can move a
  // device from "in" to "out". The only other OUTSIDE assignment in the whole
  // module is the DO's deleted-fence sweep -- a fence lifecycle reset, which
  // announces nothing.
  const outAssigns = (smSrc.match(/geoState = "OUTSIDE"/g) || []).length
  const outAt = smSrc.indexOf('geoState = "OUTSIDE"')
  const exitGuardAt = smSrc.indexOf('if (elapsed < EXIT_GUARD_SECONDS)')
  check('an exit walks all three phases — in, exiting, out',
    outAssigns === 1 && outAt > -1 && exitGuardAt > -1 && witnessAt > -1 &&
      outAt > witnessAt && outAt > exitGuardAt,
    'OUTSIDE is reachable without the witness test and the exit guard — one ping can skip the EXITING phase')
  const doOutAt = doCode.indexOf('geoState = "OUTSIDE"')
  check('the only other OUTSIDE assignment is the deleted-fence sweep',
    (doCode.match(/geoState = "OUTSIDE"/g) || []).length === 1 &&
      doOutAt > doCode.indexOf('reloadGeofences'),
    'a ping path assigns OUTSIDE outside the fence-deletion sweep — that is the in -> out shortcut the phase rule forbids')
  check('an unwitnessed crossing does not swallow the next arrival',
    /const wasInside =\s*prior\.geoState === "CONFIRMED_INSIDE" \|\| prior\.geoState === "EXITING"/.test(doCode) &&
      /if \(!wasInside && next\.geoState === "CONFIRMED_INSIDE"\)/.test(doCode),
    'the arrival is keyed on the literal OUTSIDE name, so after a silent crossing the next real arrival — and its gate push — is never announced')
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

  // ── The service workers: installable AND honest about what they cache ──
  // There are TWO of them, and the scope rule means the narrower one wins for a
  // /way/ URL — so the stricter policy is worthless if either file breaks it.
  // What they must never do is cache a DOCUMENT: every page here is rendered
  // for ONE signed-in person, on a device that may be shared, so a precached
  // shell (or an offline fallback to one) hands the next person a page that is
  // not theirs. /way/sw.js did exactly that until it was made static-only.
  for (const p of ['/sw.js', '/way/sw.js']) {
    const swRes = await req(p)
    const sw = await body(swRes)
    check(`${p}: served and actually handles fetches`,
      swRes.status === 200 && /javascript/.test(swRes.headers.get('content-type') || '') &&
      /addEventListener\(\s*'fetch'/.test(sw),
      `${swRes.status} ${swRes.headers.get('content-type')}`)

    const precache = (sw.match(/const (?:PRECACHE|SHELL) = \[([\s\S]*?)\]/) || [])[1] || ''
    const entries = precache.match(/'[^']*'/g) || []
    const documentish = entries.filter((e) => /\.html'$|^'\/'$|^'\/way\/'$|^'\/laoka\/'$|^'\/chat\/'$/.test(e))
    check(`${p}: precaches assets only, never a signed-in page`,
      entries.length > 0 && documentish.length === 0,
      documentish.length ? `it precaches ${documentish.join(' ')} — a shared device would be served someone else's page` : 'nothing is precached at all')
    check(`${p}: documents go straight to the network`,
      /req\.mode === 'navigate' \|\| req\.destination === 'document'/.test(sw) &&
      !/caches\.match\('\/(way\/)?index\.html'\)/.test(sw),
      'a navigation can be answered from (or fall back to) a cached document')
  }

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

    // The Sompitra sub-nav is the ONLY route to Kiné / Debts / Sales, so it must
    // not be width-gated: `hidden sm:block` on it left three of the four money
    // sections unreachable from the Sompitra tab on a phone — the shape most of
    // this app is used in — while looking perfectly fine on a desktop window.
    if (p === '/budget') {
      const kine = html.indexOf('href="/kine"')
      const around = kine === -1 ? '' : html.slice(Math.max(0, kine - 700), kine + 700)
      check('/budget: the Sompitra sub-nav renders at EVERY width',
        kine > -1 && !/hidden\s+sm:block/.test(around),
        kine === -1 ? 'the sub-nav is gone — Kiné/Debts/Sales have no route on any width'
          : 'the sub-nav is width-gated again, so Kiné/Debts/Sales are unreachable on a phone')
      check('/budget: the sub-nav offers all four money sections',
        ['/budget', '/kine', '/debts', '/sales'].every((h) => around.includes(`href="${h}"`)),
        'a Sompitra section is missing from the sub-nav')
    }

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

  // ── One meaning per money colour ──
  // green = money in, red = money out, teal = a period's net result, orange =
  // we owe, purple = owed to us. The rule is only worth stating if every money
  // screen obeys it, and two of them did not: /budget/reports and Sales printed
  // a POSITIVE result in blue (a hue the money palette uses for nothing), and
  // the Debts page printed credit — owed to us — in blue while the dashboard
  // printed the same money in purple. Reading the SERVED html is what makes
  // this a guard rather than a convention: the Tailwind class IS the colour,
  // and a screenshot only ever catches the screen you happened to open.
  for (const [p, label] of [['/budget/reports', 'Net'], ['/sales', 'Profit']]) {
    const html = await body(await req(p))
    const at = html.indexOf(`>${label}</p>`)
    const before = at > 0 ? html.slice(Math.max(0, at - 400), at) : ''
    check(`${p}: its period result wears the net colour (teal), not blue`,
      at > 0 && /teal-/.test(before) && !/blue-/.test(before),
      at < 0 ? `no ${label} tile on the page` : `${label} is not teal (${before.includes('blue-') ? 'it is blue' : 'no teal class found'}) — the same money in two colours`)
  }
  const debtsHtml = await body(await req('/debts'))
  check('the Debts page prints "owed to us" in purple, like the dashboard does',
    /purple[\s\S]{0,400}Owed to Us/.test(debtsHtml) && !/blue-[\s\S]{0,400}Owed to Us/.test(debtsHtml),
    'credit is in a colour the rest of the app does not use for it (blue) — orange stays "we owe"')

  // Two hardcoded people used to sit in Sompitra's logic and copy: the
  // transaction legend next to the list, and the account a Kiné payment syncs
  // into (`WHERE u.username='niri' AND ia.name='Kiné Privée'`). Both read the
  // data now — an admin can create anyone, and a rename must not leave a
  // stranger's name on a card or send money to an account nobody looked up.
  // Comments must be stripped before asserting on a source file, or a check
  // fires on the very comment that explains the fix (this one did, first run).
  const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  let budgetSrc = ''
  try { budgetSrc = code(readFileSync(new URL('../src/routes/budget.tsx', import.meta.url), 'utf8')) } catch (e) {}
  let kineSrc = ''
  try { kineSrc = code(readFileSync(new URL('../src/routes/kine.tsx', import.meta.url), 'utf8')) } catch (e) {}
  check('the transactions legend is derived from the rows, not from typed names',
    /new Set\(txns\.results\.map\(t => t\.added_by_display_name\)/.test(budgetSrc) &&
    !/align-middle"\s*\/>\s*(Niri|MaxX)/.test(budgetSrc),
    'the legend names people literally again — a third account gets no entry and a rename lies')
  check('the Kiné→budget sync resolves its income account instead of hardcoding one',
    !/username\s*=\s*'niri'/.test(kineSrc) && (kineSrc.match(/kineIncomeAccount\(/g) || []).length >= 3,
    'the account lookup is hardcoded again (or one of the two call sites bypasses the helper) — a second practitioner silently gets nothing')

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

// ─── 19. Diagnostics: every silent gate, every silent notification ──
log('\n19. Diagnostics: the silent gates and the silent notifications become readable')
{
  // The app is built to fail SILENTLY wherever failing loudly would land on a
  // person: µlogger must never see an upload error, and a push must never break
  // the action that triggered it. Both are right, and the price is that
  // "silently fine" and "silently broken" look identical from outside — which is
  // what made a real-world test of the tracking rules impossible to read. These
  // checks are about the surface that fixes that staying an answer.

  // ── It is an admin surface, in both of its forms.
  const anonDiag = await fetch(`${BASE}/admin/diagnostics.json`, { redirect: 'manual' })
  check('the diagnostics JSON is not readable anonymously',
    anonDiag.status === 403 || anonDiag.status === 302,
    `got ${anonDiag.status} — the ledger names people, topics and devices`)
  const anonPage = await fetch(`${BASE}/admin/diagnostics`, { redirect: 'manual' })
  check('the diagnostics page is not readable anonymously',
    anonPage.status === 302 || anonPage.status === 403, `got ${anonPage.status}`)

  const diagRes = await req('/admin/diagnostics.json')
  let diag = null
  try { diag = JSON.parse(await body(diagRes)) } catch (e) {}
  check('the diagnostics JSON answers', diagRes.status === 200 && !!diag, `status ${diagRes.status}`)

  const dbNames = (diag?.modules || []).map((m) => m.name)
  check('it probes all four databases',
    ['home-db', 'sompitra-db', 'way-db', 'laoka'].every((n) => dbNames.includes(n)),
    `saw ${dbNames.join(', ') || 'nothing'}`)
  const broken = (diag?.modules || []).filter((m) => !m.ok && m.name !== 'way-db indexes')
  check('every database answers on a healthy deployment',
    broken.length === 0, broken.map((m) => `${m.name}: ${m.detail}`).join(' | '))

  const pageRes = await req('/admin/diagnostics')
  const pageHtml = await body(pageRes)
  check('the page renders the three things it exists for',
    pageRes.status === 200 &&
    pageHtml.includes('Tracking intake') && pageHtml.includes('Notification ledger') &&
    pageHtml.includes('Databases'),
    `status ${pageRes.status}; the page is missing a section`)
  // The do-nothing gates have to be VISIBLE. The DO only stores gates it has
  // counted, so without seeding the list a fresh reading omits `drawn` — and
  // "0 drawn" is the number a parked-phone test is read by. A missing row reads
  // as "this gate does not exist", which is the opposite of the truth.
  // Matched as a gate ROW (the cell span), not as a word anywhere on the page:
  // an `includes()` version of this passed while the row was missing, because
  // the sum line below the grid also spells out `drawn` — found by falsifying it.
  const gateCell = (name) => new RegExp(`font-mono text-xs[^>]*>${name}<`).test(pageHtml)
  const missingGates = ['received', 'accepted', 'drawn', 'collapsed', 'unwitnessed'].filter((g) => !gateCell(g))
  check('the gates that did NOT fire are shown as rows, not omitted',
    missingGates.length === 0,
    `no gate row for ${missingGates.join(', ')} — the name appearing only in the sum line still leaves "0 drawn" reading as "there is no such gate"`)

  // ── The core claim, proven live rather than grepped: a REAL upload through the
  // μlogger path that the intake drops must leave the counter up and the reason
  // readable, while still answering the phone with success. A bad-accuracy ping
  // is the perfect probe — it writes nothing else at all, so a counter that
  // moved proves the ledger rather than some other side effect.
  const dbgRes = await req('/way/api/debug/notify')
  let device = null
  try { device = (JSON.parse(await body(dbgRes)).users || [])[0]?.username || null } catch (e) {}
  check('the DO names the devices the ledger keys by', !!device, 'no users in /way/api/debug/notify')

  const readDiagJson = async () => JSON.parse(await body(await req('/admin/diagnostics.json')))
  const counter = async (name) => {
    const d = await readDiagJson()
    return (d.ingest?.gates || []).find((g) => g.gate === name)?.n ?? 0
  }

  const beforeAcc = await counter('accuracy')
  const beforeRec = await counter('received')

  // The device login is CASE-SENSITIVE (the dashboard's is not) — the exact
  // username comes from the DO rather than from USER, which is the trap the run
  // doc records as having cost an hour.
  await req('/ulogger/client/index.php', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ action: 'auth', user: device || '', pass: PASS }),
  })
  const badFix = await req('/ulogger/client/index.php', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      action: 'addpos', trackid: '1', lat: '-19.8795533', lon: '47.0307533',
      time: String(Math.floor(Date.now() / 1000)), accuracy: '25', speed: '0',
    }),
  })
  const badBody = await body(badFix)
  check('a fix its receiver rated worse than the limit still answers success',
    /"error"\s*:\s*false/.test(badBody),
    `the silent-drop contract is gone: µlogger got ${badBody.slice(0, 60)}`)

  const afterAcc = await counter('accuracy')
  check('…and the dropped upload is COUNTED with a reason instead of vanishing',
    afterAcc === beforeAcc + 1,
    `accuracy counter ${beforeAcc} → ${afterAcc}; a drop that leaves no trace is the thing this ledger exists to end`)
  check('…and the drop is counted as received too, so a gate count always has a denominator',
    (await counter('received')) === beforeRec + 1,
    `received ${beforeRec} → ${await counter('received')}`)

  const after = await readDiagJson()
  check('the drop sample says WHY, in language a person can read',
    (after.ingest?.drops || []).some((x) => x.gate === 'accuracy' && /limit/.test(x.detail)),
    'the sampled drops carry no reason, so the sample adds nothing over the counter')
  // The counters are durable, so this sum is only meaningful because the DO
  // CLEARS them when its build marker changes (see ensureSchema). If you just
  // changed which gates count, this failing means the rows still describe the
  // old code: bump DO_BUILD, do not "fix" the counter.
  check('the gate sums hold, so the counters can be trusted',
    after.ingest?.checks?.sumInHolds === true && after.ingest?.checks?.sumOutHolds === true,
    `${JSON.stringify(after.ingest?.checks)} — if you just changed which gates count, bump the DO build marker so the stale rows are cleared (AGENTS.md rule 30)`)

  // ── The source contracts. A live check cannot reach every branch (no server
  // set, no channel configured, a push that throws), so the paths that cannot be
  // reached here are read instead.
  let notifySrc = '', diagSrc = '', adminSrc = '', idxSrc = '', doLedgerSrc = ''
  try { notifySrc = readFileSync(new URL('../src/lib/notify.ts', import.meta.url), 'utf8') } catch (e) {}
  try { diagSrc = readFileSync(new URL('../src/lib/diagnostics.ts', import.meta.url), 'utf8') } catch (e) {}
  try { adminSrc = readFileSync(new URL('../src/routes/admin.tsx', import.meta.url), 'utf8') } catch (e) {}
  try { idxSrc = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8') } catch (e) {}
  try { doLedgerSrc = readFileSync(new URL('../src/way/do/FleetDO.ts', import.meta.url), 'utf8') } catch (e) {}

  check('every way a push can fail to reach a phone is recorded',
    (notifySrc.match(/recordDiag\(/g) || []).length >= 4,
    'a notification can still disappear with only a console.log behind it — the ledger only answers "did it go out?" if EVERY non-delivery is written')
  // Counted, not merely present: a `kind: 'notify-refused'` left anywhere in the
  // file satisfied an `includes()` version of this check while one of its two
  // sites had drifted to a different kind — found by falsifying it (renaming
  // only the fan-out's refusal still passed). Two of each are real: skipped is
  // "no server" AND "nobody has a channel", refused is the fan-out AND the
  // single-channel test push.
  const skips = (notifySrc.match(/kind: 'notify-skipped'/g) || []).length
  const refusals = (notifySrc.match(/kind: 'notify-refused'/g) || []).length
  check('every way a notification fails is named, at every site',
    skips >= 2 && refusals >= 2 && notifySrc.includes("kind: 'notify-failed'"),
    `skipped=${skips} (need 2: no server, no channel), refused=${refusals} (need 2: the fan-out, the test push), failed=${notifySrc.includes("kind: 'notify-failed'")} — a site that records under a different or missing kind cannot be asked "did it go out?"`)

  const gateCalls = (doLedgerSrc.match(/this\.countGate\(/g) || []).length
  check('every gate and every non-draw in the intake counts what it did',
    gateCalls >= 8,
    `only ${gateCalls} countGate call sites — a gate exists that nobody records, which is the blind spot this removes`)
  // Each gate named individually, matched as the FIRST ARGUMENT of a countGate
  // call: a gate counted under one anonymous name would make "why did this ping
  // die?" unanswerable, which is the whole point of the ledger.
  const namedGates = ['accuracy', 'glitch', 'unwitnessed', 'report-unbelievable']
    .filter((g) => new RegExp(`countGate\\(\\s*"${g}"`).test(doLedgerSrc))
  check('every drop gate is named, not lumped together',
    namedGates.length === 4,
    `counted by name: ${namedGates.join(', ') || 'none'} — a drop with no name cannot be acted on`)
  // The page renders a FIXED list (its GATE_ORDER) because the DO only stores the
  // gates it has counted — so a gate the DO counts but the page does not render
  // disappears from the very reading it exists to explain, and a missing row
  // reads as "this gate does not exist". Both directions are checked: a name in
  // the list the DO never counts is just as misleading in reverse.
  const countedGates = [...new Set((doLedgerSrc.match(/countGate\(\s*"([a-z-]+)"/g) || [])
    .map((s) => s.match(/"([a-z-]+)"/)[1]))].sort()
  const pageGates = [...new Set((((adminSrc.match(/const GATE_ORDER = \[([\s\S]*?)\]/) || [])[1]) || '')
    .match(/'[a-z-]+'/g) || [])].map((s) => s.replace(/'/g, '')).sort()
  check('every gate the intake counts is rendered on the diagnostics page',
    countedGates.length > 0 && countedGates.join() === pageGates.join(),
    `the DO counts [${countedGates.join(', ')}], the page renders [${pageGates.join(', ')}] — a gate that is counted but not rendered reads as a gate that does not exist`)
  // The sums hold only while no ping is counted by two branches. A paused
  // device found outside its fence after a silence was counted as
  // `unwitnessed` AND `paused`, which makes the printed sum exceed `accepted`
  // and reads as "a gate nobody counts" — found by reading the branches against
  // the two equations, not by a test failing.
  check('no persistence branch can count the same ping twice',
    /else if \(stored\.recordingPaused && !unwitnessed\) \{/.test(doLedgerSrc),
    'the paused branch counts unwitnessed pings too, so one ping lands in two of the four branches and `accepted = drawn + collapsed + unwitnessed + paused` cannot hold')

  check('the intake ledger cannot itself break ingest',
    /private countGate[\s\S]{0,2500}?\} catch \{/.test(doLedgerSrc),
    'countGate can throw, so a ping that would have been dropped cleanly would 500 the upload route instead')
  // Durable counters only keep the sums honest if they are cleared when the
  // code that writes them changes — the failure mode is silent and permanent
  // (found by mutation-testing this very feature: the sum stayed broken after
  // the mutated code was restored).
  // The READ and the COMPARISON, not the mere presence of the words: a version
  // that still mentions `gate_build` and still writes do_meta while comparing
  // the stored value to itself (or not reading it at all) passed the first
  // attempt at this check — found by falsifying it.
  check('the durable gate counters are scoped to the build that wrote them',
    /const stored = meta\("gate_build"\)[\s\S]{0,300}?stored !== DO_BUILD/.test(doLedgerSrc) &&
    /DELETE FROM ingest_gates/.test(doLedgerSrc),
    'the build that wrote the durable counters is not read back and compared with DO_BUILD, so after a deploy they describe code that no longer exists and the sums stay skewed forever')
  // Exactly ONE quoted marker in the file: the constant. A second literal
  // anywhere (say, the debug response hardcoding it while the constant moves on)
  // makes the reported build and the reset build disagree — which clears the
  // counters on every single start, or never.
  const markerLiterals = (doLedgerSrc.match(/"notify-v\d+-[a-z-]+"/g) || []).length
  check('the build marker is one constant, not a string repeated in two places',
    markerLiterals === 1 && /const DO_BUILD = "notify-v\d+-[a-z-]+"/.test(doLedgerSrc),
    `${markerLiterals} quoted marker literals (need exactly 1, in DO_BUILD) — the reported build and the one that scopes the counters have drifted apart`)
  check('the drop sample stays bounded',
    /DELETE FROM ingest_drops WHERE id <= \(SELECT MAX\(id\) - \d+/.test(doLedgerSrc),
    'the sample is unbounded: a parked phone would grow it all night, and the whole point of counting in the DO was to keep the volume out of D1')
  check('the ledger reads are defensive too',
    /private readGateLedger[\s\S]{0,1800}?\} catch \(e\) \{/.test(doLedgerSrc),
    'the ledger read can throw, so a missing table would 500 the debug probe that exists to explain missing data')

  check('the ledger write itself can never become the failure it was recording',
    /export async function recordDiag[\s\S]{0,1500}?catch/.test(diagSrc),
    'recordDiag can throw, so diagnostics can now break the user action it was observing')
  check('the ledger is pruned without a human',
    /pruneDiag\(env\)/.test(idxSrc),
    'nothing prunes diag_events, so the table only grows — retention that needs somebody to remember is not retention')

  check('the diagnostics page is linked where an admin will find it',
    /href="\/admin\/diagnostics"/.test(adminSrc),
    'the surface exists but nothing links to it')
}

// ─── 20. the live share (the ONE page an outsider can open) ──────
// This is the only unauthenticated door into the app, so it is checked the way
// it was built: as though every request is hostile. The refusals that need a
// changed clock or a tampered row (an EXPIRED pin, a lockout) are guarded in the
// source below and proved by hand in the run doc — see the note on each.
log('\n20. The live share: one device, one code, until midnight UTC')
{
  let shareSrc = ''
  try { shareSrc = readFileSync(new URL('../src/lib/share.ts', import.meta.url), 'utf8') } catch (e) {}
  let idxShareSrc = ''
  try { idxShareSrc = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8') } catch (e) {}
  let doShareSrc = ''
  try { doShareSrc = readFileSync(new URL('../src/way/do/FleetDO.ts', import.meta.url), 'utf8') } catch (e) {}
  let adminSrc = ''
  try { adminSrc = readFileSync(new URL('../src/routes/admin.tsx', import.meta.url), 'utf8') } catch (e) {}
  let liveSrc = ''
  try { liveSrc = readFileSync(new URL('../public/live/index.html', import.meta.url), 'utf8') } catch (e) {}

  // The `/admin` tree is gated by its own `use('*', requireAuth)`, so a LIVE
  // anonymous request answers 302 → /login whatever the handler does — which is
  // how a handler that had lost its own gate still looked gated (found by
  // deleting the gate and watching all 354 checks stay green). Both revoke
  // routes are therefore read as source too, one slice each.
  const revokeOneBody = adminSrc.slice(
    adminSrc.indexOf("admin.post('/share/:id/revoke'"),
    adminSrc.indexOf("admin.post('/share/revoke-all'"))
  const revokeAllBody = adminSrc.slice(
    adminSrc.indexOf("admin.post('/share/revoke-all'"),
    adminSrc.indexOf("admin.post('/users'"))
  const hasOwnAdminGate = (src) =>
    /const gate = await requireCentralAdmin\(c\)/.test(src) &&
    /if \(!gate\) return c\.redirect\('\/settings\?err=only_admins'\)/.test(src)

  // ── public by design, and labelled as not-for-indexing ──
  const live = await req('/live') // signed in, but a viewer's request is anonymous
  const liveHtml = await body(live)
  const robots = live.headers.get('x-robots-tag') || ''
  check('/live answers without a session and is marked noindex',
    live.status === 200 && robots.includes('noindex'),
    `status ${live.status}, x-robots-tag "${robots}" — a public page that search engines may keep is a household's position in an index`)
  check('the live page mints no cookie, so a viewer can never hold a session',
    (live.headers.getSetCookie?.() ?? []).length === 0,
    'the public page set a cookie — a viewer must never be able to look like a household member')
  check('the live page carries no household chrome',
    !/id="home-tabbar"|id="home-nav"|\/logout/.test(liveHtml),
    'the outsider page contains the app chrome: it leaks the household structure and what else exists')
  // Not just the chrome: the DOCUMENT must not describe the app behind it either.
  // A path to the console, a module, or the session cookie's name is a map of
  // the house handed to a guest, and none of it is needed to draw one device.
  check('the outsider page leaks nothing of the app behind it',
    !/\/admin|\/way|\/laoka|\/budget|\/kine|\/debts|\/sales|\/chat|home_session/.test(liveHtml),
    'the live document names one of the app\'s own routes or its session cookie — a viewer needs none of that')

  // ── an admin mints one, and the code is shown ONCE ──
  const adminPage = await req('/admin')
  const adminHtml = await body(adminPage)
  const device = (adminHtml.match(/<option value="([^"]+)">[^<]*\(/g) || [])
    .map((m) => m.replace(/.*value="|".*/g, ''))[0]
  if (!device) {
    log('  \x1b[90m– skipped the mint flow: no W.A.Y device exists in way-db yet\x1b[0m')
  } else {
    const create = await req('/admin/share', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ device, label: 'Smoke viewer' }),
    })
    const created = await body(create)
    const pin = (created.match(/id="share-pin">(\d{6})</) || [])[1]
    // The create response lists the active codes newest-first, so the FIRST
    // revoke form in it is this share. (Taking it from the /admin page fetched
    // above would revoke whatever was active BEFORE this one — found by this
    // guard failing while the share stayed alive.)
    const shareId = (created.match(/\/admin\/share\/(\d+)\/revoke/) || [])[1] ?? '999999'
    check('an admin can mint a code, and it is shown in the response',
      create.status === 200 && !!pin && !create.headers.get('location'),
      `status ${create.status}, pin ${pin ?? 'missing'}, location ${create.headers.get('location') ?? 'none'} — a pin in a redirect URL is a pin in a browser history file and an access log`)
    check('the create response offers the one-tap link with the code in the fragment',
      !!pin && created.includes(`/live#${pin}`),
      'the card does not offer a link, or offers one with the code in the QUERY (which reaches access logs)')
    // A pin minted at 23:50 UTC lives ten minutes and reads exactly like one
    // minted at noon until the viewer is already locked out.
    check('the card says how long a code has left, not only until when',
      /in \d+ h|in \d+ min/.test(created),
      'the card prints the absolute instant only, so the cost of minting one at 23:50 UTC is invisible while it still matters')

    if (pin) {
      // ── a wrong code, and the receipt it must leave ──
      const wrong = await req('/live/api/state?pin=000000')
      const wrongBody = await wrong.json().catch(() => ({}))
      check('a wrong code is refused as a wrong code',
        wrong.status === 400 && wrongBody.code === 'bad_pin',
        `status ${wrong.status}, code ${wrongBody.code ?? 'none'} — a refusal must be distinguishable from an outage`)
      // Resolving a pin CLEARS this caller's failures, so the first failure of
      // every run writes a receipt again — which is what makes this checkable
      // live rather than by grepping. (Note: the guard reads this run's own
      // failure, so it must stay after it.)
      const diagBody = JSON.parse(await body(await req('/admin/diagnostics.json')))
      const refused = (diagBody.ledger?.counts ?? [])
        .find((c) => c.kind === 'share-refused' && c.outcome === 'refused')
      check('a refused code leaves a receipt an admin can find',
        !!refused && Number(refused.n) > 0,
        'a wrong pin wrote nothing to the ledger: guessing the only public door would be invisible after the fact')

      // ── and the real thing: the code resolves, and the payload is narrow ──
      const state = await req(`/live/api/state?pin=${pin}`)
      const stateBody = await state.json().catch(() => ({}))
      check('a correct code resolves and the viewer sees the device',
        state.status === 200 && stateBody.ok === true && !!stateBody.label,
        `status ${state.status}, body ${JSON.stringify(stateBody).slice(0, 200)}`)
      check('the state is never cacheable',
        (state.headers.get('cache-control') || '').includes('no-store'),
        `cache-control "${state.headers.get('cache-control')}" — a cached location is a location revoking the code cannot take back`)
      check('the viewer payload carries ONE device and no household data',
        stateBody.ok === true &&
        !('chat' in stateBody) && !('devices' in stateBody) && !('users' in stateBody) &&
        !('subject' in stateBody) && !('device' in stateBody),
        `keys: ${Object.keys(stateBody).join(', ')} — the outsider learns a LABEL, not the household's device names or anything else`)

      // ── a SECOND code, because "Revoke all" only means something while more
      //    than one is open (and that is exactly when the card offers it) ──
      const second = await req('/admin/share', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ device, label: 'Smoke viewer 2' }),
      })
      const secondHtml = await body(second)
      const secondPin = (secondHtml.match(/id="share-pin">(\d{6})</) || [])[1]
      check('two open codes are offered a way to end them together',
        !!secondPin && /action="\/admin\/share\/revoke-all"/.test(secondHtml),
        `second pin ${secondPin ?? 'missing'}, revoke-all form ${/action="\/admin\/share\/revoke-all"/.test(secondHtml) ? 'present' : 'missing'} — "she has arrived" must not mean revoking them one by one`)

      // ── revoking is what ends a share early, and only an admin can ──
      const id = shareId
      const anon = await fetch(`${BASE}/admin/share/${id}/revoke`, { method: 'POST', redirect: 'manual' })
      const anonTarget = anon.headers.get('location') || ''
      check('revoking a code is admin-only',
        anon.status !== 200 && /\/settings\?err=only_admins|\/login/.test(anonTarget) && hasOwnAdminGate(revokeOneBody),
        `anonymous revoke answered ${anon.status} → ${anonTarget || '(no redirect)'}, handler gate ${hasOwnAdminGate(revokeOneBody) ? 'present' : 'MISSING'} — an unauthenticated caller must not be able to change who can watch a person, and the handler has to hold its own gate: the /admin middleware would answer the live half identically if it had lost one`)

      const revoke = await req(`/admin/share/${id}/revoke`, { method: 'POST' })
      const after = await req(`/live/api/state?pin=${pin}`)
      const afterBody = await after.json().catch(() => ({}))
      check('a revoked code stops working, and says which',
        revoke.status === 302 && after.status === 410 && afterBody.code === 'revoked',
        `revoke ${revoke.status}, state ${after.status} ${afterBody.code ?? ''} — a revoked code that still resolves is a door with no lock`)

      // ── the one action for "she has arrived": every open code, at once ──
      const anonAll = await fetch(`${BASE}/admin/share/revoke-all`, { method: 'POST', redirect: 'manual' })
      const anonAllTarget = anonAll.headers.get('location') || ''
      check('revoking ALL codes is admin-only',
        anonAll.status !== 200 && /\/settings\?err=only_admins|\/login/.test(anonAllTarget) && hasOwnAdminGate(revokeAllBody),
        `anonymous revoke-all answered ${anonAll.status} → ${anonAllTarget || '(no redirect)'}, handler gate ${hasOwnAdminGate(revokeAllBody) ? 'present' : 'MISSING'} — one unauthenticated request must not be able to close every share at once`)

      const all = await req('/admin/share/revoke-all', { method: 'POST' })
      const afterAll = secondPin ? await req(`/live/api/state?pin=${secondPin}`) : null
      const afterAllBody = afterAll ? await afterAll.json().catch(() => ({})) : {}
      check('Revoke all ends every open code at once',
        all.status === 302 && (!secondPin || (afterAll.status === 410 && afterAllBody.code === 'revoked')),
        `revoke-all ${all.status}, second code ${afterAll?.status ?? 'not minted'} ${afterAllBody.code ?? ''} — a bulk revoke that leaves a code alive is worse than no button`)

      // The console has to KEEP what ended, and say which of the two clocks
      // ended it; and the ended code must leave the active list, or the card is
      // describing a state that is no longer true.
      const cardAfter = await body(await req('/admin'))
      check('the console keeps what ended, and says how',
        /Ended codes/.test(cardAfter) && /revoked 20\d\d-\d\d-\d\d/.test(cardAfter),
        'a revoked code vanishes from the console entirely, so "who stopped sharing, and when" has no answer')
      check('an ended code leaves the active list',
        !/\/admin\/share\/\d+\/revoke/.test(cardAfter),
        'the card still offers a revoked code as revocable — the two lists are not filtered apart')
    }
  }

  // ── the source contracts: the refusals a test cannot stage ──
  check('the code is hashed before it is ever stored',
    /hashPassword\(env, pin\)[\s\S]{0,600}?INSERT INTO share_links/.test(shareSrc),
    'the pin reaches the database before it is hashed, so home-db holds live codes in clear')
  check('the console never reads a pin hash into a page',
    /const SHARE_COLUMNS/.test(shareSrc) && !/SELECT \* FROM share_links/.test(shareSrc),
    'a `SELECT * FROM share_links` carries the hash into the rendered console')
  check('a pin is matched by verifying, not by looking it up',
    /verifyPassword\(env, pin/.test(shareSrc),
    'the resolve path compares hashes itself instead of using the tested constant-time compare')
  check('an expired or revoked code is reported as such, not as a wrong one',
    /code: 'expired'/.test(shareSrc) && /code: 'revoked'/.test(shareSrc),
    'both collapse into bad_pin — so a relative holding yesterday\'s link is told to check their typing, and an admin cannot tell a stale link from an attack')
  check('the code expires at the next 00:00 UTC, and cannot be extended',
    /Date\.UTC\(from\.getUTCFullYear\(\), from\.getUTCMonth\(\), from\.getUTCDate\(\) \+ 1\)/.test(shareSrc),
    'the expiry is not computed from the clock, so a share can outlive the day it was minted for')
  // Scoped to the HANDLER's body on purpose: the import line lists both names,
  // so a whole-file indexOf compares the import order and passes no matter what
  // the route does (found by this guard passing while the calls were swapped).
  const stateHandler = idxShareSrc.slice(idxShareSrc.indexOf("app.get('/live/api/state'"))
  const rateAt = stateHandler.indexOf('pinRateLimited(c.env, ip)')
  const resolveAt = stateHandler.indexOf('resolveSharePin(c.env, pin)')
  check('the rate limiter is consulted BEFORE a pin is resolved',
    rateAt > -1 && resolveAt > -1 && rateAt < resolveAt,
    `limiter at ${rateAt}, resolve at ${resolveAt} — the limiter runs after the verify, so guessing is unlimited work for the Worker even when the caller is locked out`)
  check('a resolved pin clears that caller\'s failures',
    /clearPinFailures\(c\.env, ip\)/.test(stateHandler),
    'failures accumulate across a legitimate viewer\'s typos, so two slips a day walk someone into a lockout')
  // Each refusal PATH in its own body, on purpose: there are two (a pin that
  // matches nothing, and a pin that matches a grant which has ended), and a
  // guard that searched the whole file needed only one of them to keep passing
  // -- found by mutating the stale-grant receipt and watching all 346 stay green.
  const notePinBody = shareSrc.slice(
    shareSrc.indexOf('export async function notePinFailure'),
    shareSrc.indexOf('export async function noteShareRefusal'))
  const noteStaleBody = shareSrc.slice(
    shareSrc.indexOf('export async function noteShareRefusal'),
    shareSrc.indexOf('export async function touchShare'))
  const receiptSites = [notePinBody, noteStaleBody]
  check('every refused attempt is receipted',
    receiptSites.every((src) =>
      (src.match(/kind: 'share-refused'/g) || []).length === 1 && /recordDiag\(env/.test(src)),
    'a refusal is only a console.log, so an attack on the only public door is invisible to the household',
  )
  // Both the SQL and the BIND are checked: a `WHERE device_id = ?` that is then
  // bound to a hardcoded id is scoped in appearance only.
  // Scoped to `buildShareState`'s own body: `loadDeviceState` issues the very
  // same `SELECT state_json FROM device_state WHERE device_id = ?` (with the
  // same bind), so a file-wide search stayed green while the PUBLIC read lost
  // its WHERE -- found by mutating exactly that.
  const shareReadBody = doShareSrc.slice(
    doShareSrc.indexOf('private buildShareState'),
    doShareSrc.indexOf('webSocketMessage(ws: WebSocket'))
  // The heartbeat, not a write per poll: the comparison has to live IN the
  // statement, since the viewer polls every few seconds and `last_used_at` is
  // read to the minute.
  check('the last-watched stamp is a heartbeat, not a write per poll',
    /UPDATE share_links SET last_used_at = \?1[\s\S]{0,140}?AND \(last_used_at IS NULL OR last_used_at < \?3\)/.test(shareSrc),
    'touchShare writes on every poll again — that is a D1 write every few seconds per viewer for a number nobody reads at that resolution')
  // An expired grant is ended by the CLOCK. Stamping it revoked would rewrite
  // what happened and credit an admin with an ending they never caused.
  check('a bulk revoke only touches grants the clock has not already ended',
    /UPDATE share_links SET revoked_at = \?1 WHERE revoked_at IS NULL AND expires_at > \?1/.test(shareSrc),
    'Revoke all stamps expired grants as revoked, so the Ended list lies about who ended them')
  const liveEndedBranch = liveSrc.slice(
    liveSrc.indexOf("code === 'expired'"), liveSrc.indexOf('function gateOpen'))
  check('a code that has ended is forgotten, not re-submitted on the next visit',
    /removeItem\(PIN_KEY\)/.test(liveEndedBranch),
    'the dead code stays in sessionStorage, so the next visit re-submits it and the page blames the viewer for a typo it did not make')
  check('the console asks the database for what ended',
    /listShares\(c\.env, 'ended'\)/.test(adminSrc) && /listShares\(c\.env, 'active'\)/.test(adminSrc),
    'the card only ever asks for active codes, so a revoked one is invisible rather than accountable')
  check('the DO hands out ONE device, and only by the grant\'s id',
    /SELECT state_json FROM device_state WHERE device_id = \?`, deviceId/.test(shareReadBody) &&
    /FROM pending_sync WHERE device_id = \? ORDER BY id`,\s*deviceId/.test(shareReadBody),
    'a live-share read is not scoped to one device by BOTH its query and its bind — a grant for one person could be widened into the whole household')
  // The declaration AND the stride, not just the name: `buildShareState`'s own
  // docstring explains the bound, so a guard that searches for the identifier
  // anywhere passes on the prose alone (found by this check staying green while
  // the constant was renamed out of the code).
  check('the live track is bounded, and says when it is sampled',
    /const SHARE_TRACK_MAX = \d+/.test(doShareSrc) &&
    /Math\.ceil\(rows\.length \/ SHARE_TRACK_MAX\)/.test(doShareSrc) &&
    /trackTotal/.test(doShareSrc),
    'the public read is unbounded, so a long drive is a payload nobody asked for')
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
