#!/usr/bin/env node
// ─── Home smoke test ─────────────────────────────────────────────
// End-to-end local checks against a RUNNING wrangler dev server.
// No test framework, no dependencies — plain Node 18+ (fetch/getSetCookie,
// plus node:fs to read repo sources: CUTOVER.md, whose post-deploy step names
// a value the Durable Object has to report (section 12), and the WAY Durable
// Object, whose live push must carry the accuracy the HUD falls back to
// (section 9b)). Section 24 goes further and parses EVERY file under src/ with
// the compiler in node_modules — see scripts/lib/module-state.mjs.
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
//   1. the server answers                12. the chat is the ONE feed
//   2. one login, all cookies            13. Laoka's list reaches Sompitra
//   3. every tab renders                 14. a template can be forgotten
//   4. module APIs                       15. the map clock + the tracking laws
//   5. chrome consistency                16. Android install, both shapes
//   6. modules are session-gated         17. Laoka inside the shell
//   7. bad credentials                   18. one brand, one colour per screen
//   8. auto-repair from home_session     19. the silent gates become readable
//   9. no silent map reversion           20. the live share (one code, one device)
//   9b. the HUD reads what the tracker sends
//  10. unified settings & channels       21. Settings → Map: the share row
//  11. two channels per person           22. two shopping lists
//  23. a number is typed, never nudged   24. no request data in module scope
//  25. no request data on a DO's `this`
//  26. one design language (tokens, labels, the front door)
// Exit code 0 = all green, 1 = something regressed.

import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { scanModuleState, formatFindings } from './lib/module-state.mjs'
import { scanDoState, formatDoFaults, stripJsonc, DO_STATE_POLICY } from './lib/do-state.mjs'

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

/** Pull one function body out by brace balance, so a check can talk about what
    a function does instead of pattern-matching a whole file. Shared by the
    sections that read the served pages and the shared motion engine. */
function fnBody(src, name) {
  const at = src.indexOf(`function ${name}(`)
  if (at === -1) return null
  // Walk past the PARAMETER LIST first: parameters carry their own parens, and a
  // signature is not the body.
  let i = src.indexOf('(', at)
  if (i === -1) return null
  let pdepth = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') pdepth++
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { i++; break } }
  }
  let open = src.indexOf('{', i)
  if (open === -1) return null
  // …then past a brace-wrapped RETURN TYPE. `function computeDriving(...):
  // { isDriving: boolean; distance: number } {` opens with a brace before its
  // body, and taking the first one after the name returns the TYPE — which reads
  // as "this function has no walking returns at all" and makes a guard silently
  // vacuous (exactly what happened the first time the walking-anchor check ran).
  // The signature's braces are the ones that sit right after `:` (or `|`/`&`, for
  // a union), so those are the ones to hop over; a `Promise<X>`/`void` return type
  // has no brace of its own and the first brace after it IS the body.
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

// The Home page's unread card. It is the same watermark as the dot, told at the
// size the home screen has room for, so what is checked here is the two things
// that make it a CARD: where it sits, and the fact that it is filled from the
// server's answer rather than from anything this browser has rendered.
{
  const homeDoc = await body(await req('/'))
  // Scoped past </head> on purpose: `rooms-card` and `unread-card` are CSS rules
  // in the head, and an index taken from there would sit "before" the card
  // however the markup is ordered — a vacuous green. (Slicing on '<body' is not
  // enough, and that is not hypothetical: CHROME_CSS explains itself with the
  // words "not as Tailwind utilities on <body>", so the first '<body' in the
  // document is a COMMENT in the stylesheet. It was written that way first, and
  // the check reported rooms@9294 — before the figure it is meant to follow.)
  // The script at the end of the body carries the same [data-chat-unread-card]
  // string, and the markup comes first, so indexOf finds the card itself.
  const doc = homeDoc.slice(homeDoc.indexOf('</head>'))
  const anchorAt = doc.indexOf('Cash on hand')
  const cardAt = doc.indexOf('data-chat-unread-card')
  const roomsAt = doc.indexOf('rooms-card')
  check('Home can show unread chat as the SECOND box, under the month\u2019s own figure',
    anchorAt > -1 && cardAt > anchorAt && roomsAt > cardAt,
    `figure@${anchorAt} card@${cardAt} rooms@${roomsAt} — the card does not sit between the figure and the rooms`)
  check('…and it ships hidden, with the slots the script fills',
    /class="unread-card[^"]*"/.test(doc) && !/class="unread-card[^"]*\bon\b/.test(doc) &&
      doc.includes('data-unread-count') && doc.includes('data-unread-rows') && doc.includes('data-mine='),
    'the card is missing, already shown without a count in it, or one of its fill slots (or the "is this mine" name) is gone')
  // The card is a GRID ITEM whose content is a list of nowrap lines, and a grid
  // item's automatic minimum size is its min-content width -- which for a row of
  // nowrap text is the whole sentence. Without min-width: 0 the card does not
  // clip: it widens its own track, and on a 390px phone the home page measured
  // 498px with everything in the figure beside it pushed off the screen. (Found
  // exactly that way, after the single preview line became a list.)
  check('…and it cannot widen its own grid track',
    /\.unread-card \{[^}]*min-width:\s*0/.test(homeDoc),
    'the card lost min-width: 0 — its nowrap rows will widen the home page past the viewport on a phone')
  // The card says not just HOW MANY arrived but WHICH ones, so it prints one row
  // per unread message and the number of rows is not known when the page is
  // rendered: the script builds them as elements. That is also the one line that
  // makes the card safe -- the room carries whatever anyone typed and a module
  // notification carries a transaction note -- so what is checked is that the
  // rows are ELEMENTS filled with textContent, never a string of markup.
  const cardScript = (homeDoc.match(/var KEY = 'chat_last_seen';[\s\S]*?\}\)\(\);/) || [''])[0]
  // "paints a row" = creates an element AND writes the message into it through
  // textContent. Only textContent is required, not `data-unread-rows`, because a
  // script that appended to the wrong node would still be painting as text --
  // what is at stake in this check is injection, not placement.
  check('…and the script builds one text row per unread line, never markup',
    cardScript.length > 0 &&
      cardScript.includes('data-unread-rows') &&
      /paintCardRow[\s\S]*?createElement/.test(cardScript) &&
      /\.textContent\s*=/.test(cardScript) &&
      !/\.innerHTML\s*=/.test(cardScript),
    cardScript.length === 0
      ? 'the unread script is not on the page'
      : 'the card script does not build rows from the server\u2019s lines as text, or it builds markup')
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
  // The card needs more than a timestamp: a number to print, and the LINES to
  // print under it. One example of them is not the same answer (see below).
  check('…and enough to describe what arrived, not just when it did',
    !!d && 'count' in d && Array.isArray(d.messages),
    `keys: ${Object.keys(d || {}).join(',')}`)
  // `since` is the browser's own watermark, so the count means "since I last
  // looked" and not "the room's total". Two watermarks, same endpoint: an
  // endpoint that ignored `since` would answer both identically, which is the
  // shape this catches. "Everything" is only required to be non-zero when the
  // room is not empty, so a fresh database does not fail the suite.
  let allTime = null; let future = null
  try { allTime = JSON.parse(await body(await req('/way/api/chat/latest?since=1970-01-01T00:00:00.000Z'))) } catch (e) {}
  try { future = JSON.parse(await body(await req('/way/api/chat/latest?since=2999-01-01T00:00:00.000Z'))) } catch (e) {}
  check('the readout narrows to what arrived after the caller\u2019s own watermark',
    !!allTime && !!future && future.count === 0 && allTime.count >= future.count &&
      (allTime.at === null || allTime.count > 0),
    `since 1970 → ${allTime && allTime.count}, since 2999 → ${future && future.count} (an endpoint ignoring 'since' answers both alike)`)
  // The lines, and the two things about them the card depends on: there is one
  // per unread message (as many as the server is willing to send -- it bounds
  // them, hence min), and they arrive NEWEST FIRST. Two checks rather than one
  // because they are two faults: a readout that answered with ONE line
  // regardless of the count, and a readout that sent them oldest-first (under
  // which the card's own "+N earlier in the room" row would be a lie).
  const lines = (allTime && allTime.messages) || []
  check('…and one line per unread message, bounded',
    !!allTime && Array.isArray(allTime.messages) &&
      lines.length === Math.min(allTime.count, 6) &&
      lines.every((m) => 'id' in m && 'at' in m && 'sender' in m && 'message' in m && 'isAuto' in m),
    `count=${allTime && allTime.count} lines=${lines.length} (expected min(count, 6), each with id/at/sender/message/isAuto)`)
  check('…and they arrive newest first',
    lines.every((m, i) => i === 0 || lines[i - 1].at >= m.at),
    `order: ${lines.map((m) => m.at).join(' , ')} — the row under the count is meant to be the one that just happened, and the card's "+N earlier" row is only true if the omitted ones are the older ones`)
  check('…and nothing at all after a watermark in the future',
    !!future && Array.isArray(future.messages) && future.messages.length === 0,
    `since 2999 → ${future && JSON.stringify(future.messages)}`)
  // The clip is a claim about the PAYLOAD, not decoration: every page polls this
  // every 25 s, so one runaway message must not become a kilobyte poll. Asserted
  // two ways because either alone is weak -- the DO must actually clip (static,
  // and the only half that can bite in a room whose messages are all short), and
  // nothing returned may exceed the bound it declares (behavioural: that is what
  // a wrong cap breaks). Comments stripped first, since the constant's own
  // doc-comment names it.
  let doSrc = ''
  try { doSrc = readFileSync(new URL('../src/way/do/FleetDO.ts', import.meta.url), 'utf8') } catch (e) {}
  const doClip = doSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const clipApplied = /message:\s*clipChatLine\(/.test(doClip)
  const clipCap = Number((doClip.match(/CHAT_UNREAD_CHARS = (\d+)/) || [])[1] || 0)
  check('…and each line is clipped before it leaves the DO, so one long message cannot bloat every poll',
    clipApplied && clipCap > 0 &&
      lines.every((m) => typeof m.message === 'string' && m.message.length <= clipCap + 1),
    `clip applied: ${clipApplied}, cap=${clipCap}, longest line: ${Math.max(0, ...lines.map((m) => (m.message || '').length))} chars`)
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
  check('the layer menu is BUILT from the shared basemaps',
    way.includes('/shared/basemaps.js') && /Object\.keys\(HomeBasemaps\)/.test(way),
    'the page is back to hardcoded basemap buttons, so a basemap can be renamed in one place and drawn from another — which is how a button reading "OSM" kept promising a server that had started refusing this app')

  // The background, and why it is a shared file rather than two URLs: on
  // 2026-09-20 OSM's volunteer-run tile server answered every request that
  // identified this app with a BLANK 256x256 tile (https://osm.wiki/blocked,
  // "not following the tile usage policy"), which broke /live while the
  // household map — on Esri — looked perfect. A tile URL typed into a page is
  // a dependency on somebody else's policy, taken twice.
  const live = await body(await req('/live'))
  const basemaps = await req('/shared/basemaps.js')
  const basemapSrc = await body(basemaps)
  check('the share names no tile server of its own',
    live.includes('/shared/basemaps.js') && !/tile\.openstreetmap\.org/.test(live),
    'the outsider view points at a tile host directly again — the last time it did, every request that identified this app came back as a blank tile, and a blank tile reads as "she has not moved"')
  // The module's own header names the host that blocked us, so the URLs are
  // read as VALUES rather than by grepping the file: a guard that trips on the
  // comment explaining the fix is the documented trap (section 18) — and it
  // tripped here first.
  const basemapUrls = [...basemapSrc.matchAll(/url:\s*'([^']+)'/g)].map((m) => m[1])
  check('…and neither does the household map',
    !/tile\.openstreetmap\.org/.test(way) && way.includes('/shared/basemaps.js') &&
      !basemapUrls.some((u) => /tile\.openstreetmap\.org/.test(u)),
    `a tile URL is inlined in a page again (or a basemap points at the volunteer server): ${basemapUrls.join(' ') || 'none'} — one provider changing its mind can then break one map while the other looks fine, and nothing here would say which`)
  // Each basemap, read as its OWN block. The first version of this check grepped
  // the whole module for a credit: stripping ONE basemap's attribution passed,
  // because the other basemap's mention satisfied the grep — found by falsifying
  // it, which is the only reason to write a guard at all.
  const basemapBlocks = [...basemapSrc.matchAll(/([a-z]+):\s*\{([\s\S]*?)\n\s*\},/g)]
    .map((m) => ({ key: m[1], body: m[2] }))
  const credited = basemapBlocks.filter((b) =>
    /attribution:\s*'[^']*Esri[^']*'/.test(b.body) && /attribution:\s*'[^']*OpenStreetMap contributors[^']*'/.test(b.body))
  check('every basemap is https, and each one names who to credit',
    basemapUrls.length >= 2 && basemapUrls.length === basemapBlocks.length &&
      basemapUrls.every((u) => u.startsWith('https://')) && credited.length === basemapBlocks.length,
    `${basemapUrls.length} url(s) for ${basemapBlocks.length} basemap(s); credited: ${credited.map((b) => b.key).join(', ') || 'none'} — the credit is a condition of using someone's tiles rather than decoration, and an http tile on an https page is blocked by the browser before anyone sees it`)
  check('the tile path is Esri\u2019s {z}/{y}/{x}, not OSM\u2019s {z}/{x}/{y}',
    basemapUrls.every((u) => /\/tile\/\{z\}\/\{y\}\/\{x\}/.test(u)),
    `${basemapUrls.join(' ')} — row before column; swapping the two by hand draws the right zoom of the wrong place, which reads as "the map is wrong" rather than "the URL is wrong"`)
  check('the basemap module serves both maps',
    basemaps.status === 200 && /javascript/.test(basemaps.headers.get('content-type') || '') &&
      /HomeBasemaps/.test(basemapSrc) && /(^|\s)lite:\s*\{/.test(basemapSrc) && /(^|\s)streets:\s*\{/.test(basemapSrc),
    `status ${basemaps.status}, ${basemaps.headers.get('content-type')} — it is a separate request, so a 404 leaves the share drawing an empty square while the household map looks fine`)
  const defaultKey = (way.match(/BASEMAP_DEFAULT:\s*'([a-z]+)'/) || [])[1]
  check('the map defaults to a basemap the module actually defines',
    !!defaultKey && new RegExp(`(^|\\s)${defaultKey}:\\s*\\{`).test(basemapSrc),
    `default "${defaultKey ?? 'missing'}" is not defined in /shared/basemaps.js — setLayer falls back silently, so the map just draws the wrong background`)
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
  // A driving ping with no speed is not a parked one. The badge printed
  // `Math.round(last.speed || 0) + ' km/h'`, so a ping whose report the intake
  // DISCARDED (μlogger reports m/s and x 3.6 can land above the jitter limit)
  // read as "0 km/h" beside a HUD saying "-- / No signal" -- two answers to one
  // question, and one of them a claim the ping never made.
  check('a driving ping with no speed never reads 0 km/h',
    /const kmh = \(last\.speed === null \|\| last\.speed === undefined\) \? '--'/.test(way) &&
      !/Math\.round\(last\.speed \|\| 0\)/.test(way),
    'the badge turns an absent speed into "0 km/h", which reads as parked')
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

  check('the playback loop is in the page that is actually served',
    way.includes('startPlaybackLoop()') && way.includes('PLAYBACK_LAG_SECONDS') && way.includes('function playbackTick('),
    'the served /way/index.html has no playback loop')

  const ping = fnBody(way, 'handleNewPing')
  check('a new ping no longer rebuilds the map',
    !!ping && !/redrawAllTracks|updateMarker\(|panTo\(/.test(ping),
    ping ? 'handleNewPing still redraws or pans' : 'handleNewPing is not in the page')

  // ── the motion engine is SHARED with the public live share ─────────
  // The camera and the cursor were moved OUT of this page and into
  // /shared/playback.js, and the share loads the same file: "the share looks
  // exactly like the map" is then one implementation rather than two that
  // agree today. These guards therefore read the module -- where the motion
  // now lives -- and the pages only for DELEGATION, which is also what keeps a
  // private copy from growing back.
  const shared = await body(await req('/shared/playback.js'))
  check('both maps load the shared motion engine, and neither keeps a copy',
    way.includes('/shared/playback.js') && shared.includes('HomePlayback') &&
    way.includes('HomePlayback.cursorPosition(') && way.includes('HomePlayback.createFollowCamera(') &&
    !way.includes('function pullEase') && !way.includes('function cursorIndex') &&
    // the camera's own arithmetic must not come back here either
    !/map\.panBy\(/.test(way) &&
    // The per-ping pan is the bug this replaced: it must not come back anywhere.
    !/map\.panTo\(/.test(way),
    'the served /way page is not delegating its motion to /shared/playback.js, so the map and the share can drift apart again')

  const cam = fnBody(shared, 'createFollowCamera')
  const zone = fnBody(shared, 'followZoneRadius')
  const landing = Number((shared.match(/PULL_LANDING: ([0-9.]+)/) || [])[1])
  check('the camera is the only thing that moves the map',
    !!cam && cam.includes('panBy(') && !!zone &&
    // A circle, off the SHORTER side, so it can never reach the corners the
    // HUD and the badge strip own.
    zone.includes('Math.min(size.x, size.y)') &&
    (shared.match(/map\.panBy\(/g) || []).length === 1 &&
    !!fnBody(way, 'updateFollowCamera') && fnBody(way, 'updateFollowCamera').includes('followDriver.update('),
    'the camera should be one panBy() inside the shared engine, off a screen-fraction CIRCLE, and the page should only call it')

  // The camera is a CYCLE, and the cycle has three load-bearing parts: the zone
  // is a circle, the sweep goes to the OPPOSITE edge (the whole point of it --
  // twice the drift per recentre), and it lands a hair INSIDE that edge, since
  // landing exactly on it would re-arm the trigger on the same frame.
  check('the camera roams a circle, shoves through its edge, then sweeps to the far side',
    !!cam && /phase = 'push'/.test(cam) && /phase = 'pull'/.test(cam) &&
    cam.includes('pushUntil') && cam.includes('at.distanceTo(center) <= radius') &&
    cam.includes('at.subtract(center)') &&
    // the sweep runs from the edge crossed to the aim, one eased step at a time
    cam.includes('gap.add(aim.subtract(gap).multiplyBy(pullEase(t, FLUID.PULL_SPRING))') &&
    // WHERE it lands, numerically: strictly inside the circle (a landing ON it
    // leaves the device outside on the frame the pull ends, and the trigger
    // then fires forever) and not so far inside that the sweep barely moves.
    landing > 0.6 && landing < 1 &&
    // the old box/edge-pinned shapes must be gone, not merely unused
    !/halfX|halfY/.test(way + shared) && !way.includes('FOLLOW_GLIDE_DURATION') &&
    !way.includes('FOLLOW_DEAD_ZONE_SCREEN_FRACTION'),
    'the camera should run drift -> push -> sweep to the OPPOSITE edge of a circle, with the old box and its undo-the-overshoot glide gone')

  // A device that was TELEPORTED out of the circle -- a pace switch, a fresh WS
  // snapshot -- must land back INSIDE it, or the pull repeats for ever. The aim
  // is pinned to the circle for exactly that reason, and it is not the exit
  // offset mirrored.
  const plan = fnBody(shared, 'planPull')
  check('a teleported device lands back inside the circle, not outside it again',
    !!plan && plan.includes('gap.multiplyBy(-(radius * FLUID.PULL_LANDING) / out)') &&
    plan.includes('var jumped = out > radius * 2') && plan.includes('gap.distanceTo(pt(0, 0))') &&
    // and a jump is not allowed to time the sweep as if it were a drift
    plan.includes('FLUID.PULL_MIN_MS'),
    'the sweep should aim at the point opposite the crossing ON the circle (never the mirrored exit offset, which a jump lands outside again), and a jump should not time it')

  // The sweep's LENGTH is measured, not configured: a ratio off the drift it
  // just watched, so the sweep looks the same relative to the movement at every
  // device speed. A fixed duration is what this replaced.
  check('the sweep is timed by the drift, not by a fixed number of seconds',
    !!plan && plan.includes('driftMs / FLUID.PULL_RATIO') &&
    plan.includes('FLUID.PULL_MIN_MS') && !!cam && cam.includes('driftFrom = nowMs') &&
    !way.includes('FOLLOW_PULL_DURATION') && !shared.includes('PULL_DURATION'),
    'the sweep should derive its duration from the drift it watched (PULL_RATIO, floored by PULL_MIN_MS), not a fixed duration')

  check('the pull moves with the device instead of aiming at a point',
    !!cam && cam.includes('at.subtract(want)') &&
    cam.includes('map.panBy(delta, { animate: false, noMoveStart: true })') &&
    !cam.includes('setView('),
    'the pull should drive a live offset with per-frame panBy and no setView, so the device is still drawn while the gap closes')

  // Not just the ease's NAME -- its numbers, evaluated here. 0 -> 0 and
  // 1 -> 1 so the device lands ON the centre, and a small overshoot past it on
  // the way, which is the whole difference between a spring and a slide.
  {
    const pull = fnBody(shared, 'pullEase')
    const spring = Number((shared.match(/PULL_SPRING: ([0-9.]+)/) || [])[1])
    let ok = false, why = 'pullEase is not in the shared engine'
    if (pull && spring) {
      try {
        const f = new Function('return function pullEase(t, spring) ' + pull)()
        let peak = 0, peakAt = 0
        for (let i = 0; i <= 200; i++) { const v = f(i / 200, spring); if (v > peak) { peak = v; peakAt = i / 200 } }
        ok = Math.abs(f(0, spring)) < 1e-9 && Math.abs(f(1, spring) - 1) < 1e-9 &&
             peakAt > 0.25 && peakAt < 0.9 && peak > 1.02 && peak < 1.12
        why = `pullEase(0)=${f(0, spring).toFixed(4)} pullEase(1)=${f(1, spring).toFixed(4)} peak=${peak.toFixed(4)} at t=${peakAt}`
      } catch (e) { why = 'pullEase would not evaluate: ' + e.message }
    }
    check('the pull eases out with a small overshoot (a spring, not a slide)', ok, why)
  }

  // The cursor's own two rules, which are the reason it is shared: it never
  // passes a point that has not arrived (the exit guard holds pings back and
  // delivers them later), and it never crawls across a trail break.
  const cursorFn = fnBody(shared, 'cursorPosition')
  check('the shared cursor waits for late points and never crawls a break',
    !!cursorFn && cursorFn.includes('Math.min(clock, newestTs)') &&
    cursorFn.includes('FLUID.GAP_SECONDS * 1000') && cursorFn.includes('FLUID.GLIDE_MS'),
    'the cursor would run past a ping that has not arrived, or drag the marker across a hole in the trail')

  // The lag is ONE number, in the module: neither page may carry its own.
  check('the fluid lag lives in the shared engine, not in a page',
    /LAG_SECONDS: 25/.test(shared) && way.includes('HomePlayback.FLUID.LAG_SECONDS') &&
    !/PLAYBACK_LAG_SECONDS: [0-9]/.test(way),
    'a page has its own copy of the lag, so the map and the share can drift apart again')

  // ── and the engine RUNS here, on synthetic fixes ─────────────────
  // Grepping a shared file proves it is shared, not that it is right. The
  // module is pure arithmetic over a list of fixes, so the suite loads it into
  // a bare `window` and asks it where the marker is at a series of instants:
  // between two fixes, with no new data arriving, which is exactly what
  // "fluid" means and what a screenshot cannot prove.
  {
    const win = {}
    let HP = null
    try { new Function('window', shared)(win); HP = win.HomePlayback } catch (e) { HP = null }
    const FL = HP && HP.FLUID
    check('the shared engine loads and exposes the motion, not just the file',
      !!HP && !!FL && typeof HP.cursorPosition === 'function' && typeof FL.LAG_SECONDS === 'number',
      'the module the pages load does not define HomePlayback — both maps would move by no rule at all')
    if (HP) {
      const iso = (s) => new Date(Date.UTC(2026, 8, 20, 12, 0, s)).toISOString()
      const at = (s) => Date.UTC(2026, 8, 20, 12, 0, s)
      const fixes = [
        { latitude: -18.8,    longitude: 47.5, timestamp: iso(0) },
        { latitude: -18.7973, longitude: 47.5, timestamp: iso(10) },
        { latitude: -18.7946, longitude: 47.5, timestamp: iso(20) },
        { latitude: -18.7919, longitude: 47.5, timestamp: iso(30) },
      ]
      const half = HP.cursorPosition(fixes, at(5))
      const a = HP.cursorPosition(fixes, at(2)).lat
      const b = HP.cursorPosition(fixes, at(3)).lat
      const future = HP.cursorPosition(fixes, at(600))
      check('the cursor is BETWEEN two fixes, and advances with the clock',
        !!half && Math.abs(half.lat - -18.79865) < 1e-6 &&
        Math.abs(Math.abs(a - b) - 0.0027 / 10) < 1e-9 && b > a,
        `halfway=${half && half.lat}, one second moved ${(b - a).toExponential(3)}° — the marker is being snapped to fixes, not drawn between them`)
      check('the cursor waits at the newest fix instead of running past it',
        Math.abs(future.lat - fixes[3].latitude) < 1e-9 && future.alpha === 1,
        `alpha=${future && future.alpha} — the exit guard delivers pings late, so a cursor that runs ahead draws a device somewhere it has never been`)
      const gapped = [
        { latitude: -18.8, longitude: 47.5, timestamp: iso(0) },
        { latitude: -18.7, longitude: 47.5, timestamp: iso(180) },
      ]
      const inGap = HP.cursorPosition(gapped, at(90))
      const arriving = HP.cursorPosition(gapped, at(180 - FL.GLIDE_MS / 2000))
      check('a break in the trail holds the marker, then glides the last stretch',
        Math.abs(inGap.lat - -18.8) < 1e-9 && arriving.lat > -18.8 && arriving.lat < -18.7,
        'the marker is dragged across a hole in the record as if the device had driven through it')
      const slow = HP.easeFactor(FL.EASE_PER_SECOND, 0.1)
      const fast = 1 - (1 - HP.easeFactor(FL.EASE_PER_SECOND, 0.05)) * (1 - HP.easeFactor(FL.EASE_PER_SECOND, 0.05))
      check('the marker ease is frame-rate independent',
        Math.abs(slow - fast) < 1e-12,
        `0.1s frame lands at ${slow}, two 0.05s frames at ${fast} — a slow phone would draw a different journey`)
    }
  }

  // Where a trail BREAKS is shared too (the trail's threshold and the cursor's
  // are the same rule), so its number moved into the module with the rest of
  // the motion -- frozen there, and the page must point at it rather than
  // restate it.
  check('the trail break threshold is still 90s, out of the shared engine',
    /GAP_SECONDS: 90/.test(shared) && way.includes('TRACK_GAP_SECONDS: HomePlayback.FLUID.GAP_SECONDS'),
    'the gap rule is no longer one 90-second number the cursor and the trail both read')

  // Styling is FROZEN by this feature: the same numbers must still decide what
  // a track looks like, or "visual only" stopped being true. A line may MOVE
  // between the page and the shared motion module -- the speed ramp did, so the
  // household map and the share's dial read one list -- but its values may not
  // change, and the delegation guard below keeps a second copy from growing back.
  const frozen = [
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
  // Compared with runs of whitespace collapsed: these are VALUES frozen, not
  // column alignment, and the shared module writes the ramp on its own terms.
  const squash = (s) => s.replace(/\s+/g, ' ')
  const styleHay = squash(way + ' ' + shared)
  const changed = frozen.filter((line) => !styleHay.includes(squash(line)))
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

  // ── The map must agree with the ENGINE, not with a drawing of it ────────
  // Two surfaces can each be "right" and still contradict each other. Each
  // guard below is a place where that had already happened, so they are fixed
  // as laws rather than as the three bugs they were.
  //
  // Everything below reads the page with its COMMENTS STRIPPED, and that is not
  // tidiness: the fix for the monthly totals explains itself by naming
  // `distance_km`, so a guard matching the raw page would have red-flagged a
  // correct fix for mentioning the very thing it stopped doing. (It did, on
  // the first run.) The suite's usual rule — a source guard must not be able to
  // pass on its own prose — cuts both ways.
  const wayCode = strip(way)

  // (1) The fence circle. It was ONE hardcoded radius for every fence (90 m)
  // while the engine reads each fence's own row — and production carries three
  // fences resized to a 100 m exit radius, so the drawn boundary sat 10 m
  // inside where a departure actually confirms. The circle is what the eye
  // reads as "the fence", and the post-exit track starts where it crosses
  // that very edge, so it is the one drawn line that cannot be approximate.
  const exitRadiusFn = fnBody(wayCode, 'fenceExitRadiusM')
  const circlesFn = fnBody(wayCode, 'drawGeofenceCircles')
  check('a fence is drawn at its OWN exit radius, not one radius for all of them',
    !!exitRadiusFn && /\.exitRadiusM/.test(exitRadiusFn) &&
    !!circlesFn && circlesFn.includes('radius: fenceExitRadiusM(f)'),
    'the map draws a fixed circle instead of each fence\'s own exit radius — the drawing and the engine disagree about where the fence is')

  // …and the fallbacks for a fence that names neither must BE the backend's
  // numbers rather than lookalikes: a page-side 60/40 would draw every default
  // fence wrong while the engine kept triggering at its own radius.
  const feEntry = Number((wayCode.match(/GEOFENCE_ENTRY_RADIUS_M: ([0-9.]+)/) || [])[1])
  const feBuffer = Number((wayCode.match(/GEOFENCE_EXIT_BUFFER_M: ([0-9.]+)/) || [])[1])
  const beEntry = Number((cfgSrc.match(/DEFAULT_GEOFENCE_RADIUS_M: ([0-9.]+)/) || [])[1])
  const beBuffer = Number((cfgSrc.match(/EXIT_RADIUS_BUFFER_M: ([0-9.]+)/) || [])[1])
  check('the map\'s fence fallbacks are the backend\'s own two numbers',
    Number.isFinite(feEntry) && feEntry === beEntry && feBuffer === beBuffer,
    `the page uses ${feEntry}m + ${feBuffer}m where config.ts says ${beEntry}m + ${beBuffer}m`)

  // (2) The month's km. There is ONE rule for turning stored rows into
  // distance — computeLegsForDay, geometry between consecutive points, split
  // by classification — and the month must use the same one the day card does.
  // It used to sum each row's stored distance_km instead, and the backend
  // stores walking rows with distance 0 by design (computeDriving's walking
  // branch), so the month could never show a walked figure while the day
  // always could. Read against production when this was fixed: 0 rows out of
  // 14,000+ carried a walked distance, so it was 0.0 km, every month.
  const monthFn = fnBody(wayCode, 'loadMonthlyTotals')
  const legsFn = fnBody(wayCode, 'computeLegsForDay')
  check('the month adds its km up with the same rule as the day',
    !!monthFn && monthFn.includes('computeLegsForDay(') && !/distance_km/.test(monthFn) &&
    !!legsFn && legsFn.includes('walkedKm'),
    !monthFn ? 'loadMonthlyTotals is not in the page'
      : 'the monthly totals read a per-row distance again, so walked km can only read 0 while the day card shows a real one')

  // (3) The ETA the HUD promises and the approach push the phone gets are the
  // same judgement made twice, in two languages. The two thresholds have to
  // match, or the map shows an arrival countdown for a drive the notifier
  // never fires on (and the badge never pulses).
  const etaMin = Number((wayCode.match(/ETA_MIN_SPEED_KMH: ([0-9.]+)/) || [])[1])
  const etaBearing = Number((wayCode.match(/ETA_MAX_BEARING_DIFF_DEG: ([0-9.]+)/) || [])[1])
  const doMin = Number((doCode.match(/APPROACH_MIN_SPEED_KMH = ([0-9.]+)/) || [])[1])
  const doBearing = Number((doCode.match(/APPROACH_MAX_BEARING_DIFF = ([0-9.]+)/) || [])[1])
  check('the HUD\'s ETA uses the same thresholds as the approach notification',
    Number.isFinite(etaMin) && etaMin === doMin && etaBearing === doBearing,
    `the page uses ${etaMin} km/h / ${etaBearing}° where the DO uses ${doMin} km/h / ${doBearing}°`)

  // (3b) The meeting pill: the map's other ETA ("when will the two of you
  // cross"), and the only part of this page with real geometry in it. Each rule
  // below is a defect the one-off lab FOUND and measured
  // (scripts/one-off/2026-09-24-meet-eta-lab — its check-maths.mjs pins the same
  // rules from the other side), so dropping one puts that defect back on the
  // map: no `settled` ceiling gave a pair 2.1 km apart a 39 m "meeting" they
  // missed by 464 m; the strict fence rule made the pill go dark for 15 s in the
  // MIDDLE of a true meet, because every driver is inside their own home fence
  // for the first minute of a trip; and reading a phone's reported speed instead
  // of its fixes believes the same lie twice.
  // The verdict itself is ONE function on purpose: the pill and the gauge under
  // the map both ask it, so they cannot disagree about the same pair. These
  // checks therefore read meetDecision, not the pill.
  const meetFn = fnBody(wayCode, 'meetDecision')
  const meetPillFn = fnBody(wayCode, 'meetEtaFor')
  const meetStripFn = fnBody(wayCode, 'renderMeetStrip')
  const meetScaleFn = fnBody(wayCode, 'meetStripScale')
  const meetVelFn = fnBody(wayCode, 'meetVelocity')
  const meetSettled = Number((wayCode.match(/MEET_ETA_SETTLED_M: ([0-9.]+)/) || [])[1])
  const meetDcpa = Number((wayCode.match(/MEET_ETA_DCPA_MAX_M: ([0-9.]+)/) || [])[1])
  // The bar's ladder is BUILT by the page from a band spec, so these checks run
  // the real builder over the real bands: a copy of the numbers here would keep
  // passing while the bar stepped by something else entirely. The array is read
  // by BRACKET, not by regex: wayCode has its comments stripped, so a pattern
  // anchored on the prose that follows would depend on which comment happened to
  // sit there.
  const stripBands = (() => {
    const at = wayCode.indexOf('MEET_STRIP_BANDS_M:')
    if (at === -1) return []
    const open = wayCode.indexOf('[', at)
    if (open === -1) return []
    let depth = 0, i = open
    for (; i < wayCode.length; i++) {
      if (wayCode[i] === '[') depth++
      else if (wayCode[i] === ']') { depth--; if (depth === 0) { i++; break } }
    }
    try { return JSON.parse(wayCode.slice(open, i).replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')) } catch (e) { return [] }
  })()
  const stripShrink = Number((wayCode.match(/MEET_STRIP_SHRINK_AT: ([0-9.]+)/) || [])[1])
  const stripLadder = (() => {
    const src = fnBody(wayCode, 'meetStripLadder')
    if (!src || !stripBands.length) return []
    try {
      return new Function('CONFIG', 'return function meetStripLadder() ' + src)({ MEET_STRIP_BANDS_M: stripBands })()
    } catch (e) { return [] }
  })()
  /** The page's own rung chooser, over the page's own ladder, with a FRESH
   *  remembered index: every call starts where a first render would. */
  const stripScaleAt = (dist) => {
    const src = fnBody(wayCode, 'meetStripScale')
    if (!src || !stripLadder.length) return null
    try {
      const f = new Function('CONFIG', 'MEET_STRIP_LADDER', 'let meetStripScaleIdx = 0;\nlet meetStripScaleKey = null;\nreturn function meetStripScale(dist, subjectKey) ' + src)
      return f({ MEET_STRIP_SHRINK_AT: stripShrink }, stripLadder)(dist)
    } catch (e) { return null }
  }
  check('the meeting pill only trusts its own estimate once the pair is close',
    !!meetFn && Number.isFinite(meetSettled) && meetSettled > 0 && meetSettled <= 2000 &&
    /range > CONFIG\.MEET_ETA_SETTLED_M/.test(meetFn),
    !meetFn ? 'meetDecision is not in the page'
      : `settled=${meetSettled} m — without a ceiling the extrapolation is fiction at range, which is exactly where the lab's first false positive came from`)
  check('the meeting pill refuses a crossing that passes wide, and one that is not closing',
    !!meetFn && Number.isFinite(meetDcpa) && meetDcpa > 0 &&
    /dcpa > CONFIG\.MEET_ETA_DCPA_MAX_M/.test(meetFn) &&
    /closing < CONFIG\.MEET_ETA_CLOSING_MIN_KMH/.test(meetFn),
    !meetFn ? 'meetDecision is not in the page'
      : 'the miss distance is the only gate that separates a meeting from two people on parallel roads pointed at each other')
  check('the meeting pill derives each velocity from that device\'s own fixes',
    !!meetVelFn && /timestamp/.test(meetVelFn) && /MEET_ETA_TELEPORT_KMH/.test(meetVelFn) &&
    !/\.speed/.test(meetVelFn),
    !meetVelFn ? 'meetVelocity is not in the page'
      : 'the velocity reads a reported speed, or no longer rejects an impossible one: a phone whose speed column lies would be believed twice')
  check('the meeting pill will not promise anything from a stale fix',
    !!meetFn && /MEET_ETA_FRESH_S/.test(meetFn) && /if \(!fresh\(mine\)/.test(meetFn),
    !meetFn ? 'meetDecision is not in the page'
      : 'the freshness test stopped gating the pill: a five minute old fix is a memory of where somebody was, not a prediction of where they will be')
  check('a peer parked in a fence is home, a peer driving through one is not',
    !!meetFn && /is_inside_geofence && theirs\.kmh < CONFIG\.ETA_MIN_SPEED_KMH/.test(meetFn),
    !meetFn ? 'meetDecision is not in the page'
      : 'the fence test is stricter than "inside a fence AND not moving", so the pill goes dark whenever the driver passes their own house')
  check('the meeting pill hands the moment over to the Together pill inside the together radius',
    !!meetFn && /range <= CONFIG\.TOGETHER_DISTANCE_M/.test(meetFn),
    !meetFn ? 'meetDecision is not in the page'
      : 'two pills would be saying the same thing to the same pair')
  // The gauge is the pill's own answer on a distance ruler, so it reads the same
  // verdict rather than a second copy of the gates.
  check('the pill and the gauge under the map ask one verdict function',
    !!meetPillFn && !!meetStripFn && /meetDecision\(/.test(meetPillFn) && /meetEtaFor\(/.test(meetStripFn),
    !meetStripFn ? 'renderMeetStrip is not in the page'
      : 'the gauge grew its own copy of the gates, so the bar under the map can show a crossing the pill would not have drawn')
  // Which way the bar runs IS the reading, not a style choice: the fill is how
  // much of the current scale is still LEFT, so it grows as the two of them close.
  // Filled with the distance instead -- which is how it was drawn first -- a
  // widening gap looks like the bar filling UP, the opposite of what it is.
  {
    const fillSrc = fnBody(wayCode, 'meetStripFillFraction')
    let ok = false, why = 'meetStripFillFraction is not in the page'
    if (fillSrc) {
      try {
        const fill = new Function('return function meetStripFillFraction(dist, scale) ' + fillSrc)()
        // Halfway along a 1 km bar is 500 m apart; 0 m is the full bar and 1 km the
        // empty one, which is the inversion itself.
        const points = [[0, 1000, 1], [250, 1000, 0.75], [500, 1000, 0.5], [1000, 1000, 0],
          [1500, 2000, 0.25], [0, 2000, 1], [2000, 2000, 0]]
        const bad = points.filter(([d, s, want]) => Math.abs(fill(d, s) - want) > 1e-9)
        // …and driven by the distance: every further fix has to DRAIN it, never
        // fill it, or the bar is monotone the wrong way whatever it is scaled by.
        const walk = []
        for (let d = 0; d <= 1000; d += 25) walk.push(fill(d, 1000))
        const drains = walk.every((v, i) => i === 0 || v <= walk[i - 1] + 1e-9) &&
          walk[0] === 1 && walk[walk.length - 1] === 0
        // …and it bottoms out past the top of the scale rather than going negative.
        const clamped = fill(50000, 1000) === 0 && fill(-5, 1000) === 1
        ok = !!fillSrc && bad.length === 0 && drains && clamped
        why = `500 m apart fills ${fill(500, 1000)} of a 1 km bar while 1 km fills ${fill(1000, 1000)} · the same bar walked out from 0 to 1 km drains ${walk[0]} → ${walk[walk.length - 1]} · 50 km on a 1 km bar reads ${fill(50000, 1000)}`
      } catch (e) { why = 'the fill would not evaluate: ' + e.message }
    }
    check('the bar fills as the pair closes and drains as they part, 0 at the far end of the scale', ok, why)
  }
  check('the dot rides the head of the fill, so the mark and the shading are one reading',
    !!meetStripFn && /meetStripFillFraction\(m, scale\)/.test(meetStripFn) &&
    /pct\(target\.dist\)/.test(meetStripFn) &&
    /dot\.style\.left = headPct/.test(meetStripFn) && /fill\.style\.width = headPct/.test(meetStripFn),
    !meetStripFn ? 'renderMeetStrip is not in the page'
      : 'the dot, the fill and the scale became independent again, so the bar can shade one fraction of the scale and mark another')
  check('the gauge rescales at once when the pair outgrows the bar, and reluctantly back',
    !!meetScaleFn && /while \(i < L\.length - 1 && dist > L\[i\]\) i\+\+/.test(meetScaleFn) &&
    /dist < L\[i - 1\] \* CONFIG\.MEET_STRIP_SHRINK_AT/.test(meetScaleFn) &&
    Number.isFinite(stripShrink) && stripShrink > 0.4 && stripShrink < 1,
    !meetScaleFn ? 'meetStripScale is not in the page'
      : `shrink threshold=${stripShrink} — without the hysteresis half a pair sitting on a ladder boundary rescales the whole bar on every fix, and ±6 m of fix noise crosses 1,000 m repeatedly`)
  // The bands ARE the rule (200 m under a km, then 1, 5, 10, 20, 50 km, then
  // 100 km up to a ceiling), so they are pinned literally: a "tidier" ladder
  // here is a different bar, not a refactor.
  check('the bar\'s scale steps are the bands it claims: 200 m under a km, then 1, 5, 10, 20, 50, 100 km',
    JSON.stringify(stripBands) === JSON.stringify(
      [[1000, 200], [10000, 1000], [50000, 5000], [100000, 10000], [200000, 20000], [300000, 50000], [1000000, 100000]]) &&
    stripLadder.length > 30 && stripLadder.every((v, i) => i === 0 || v > stripLadder[i - 1]),
    stripBands.length ? `MEET_STRIP_BANDS_M is ${JSON.stringify(stripBands)}` : 'MEET_STRIP_BANDS_M is missing or unparseable')
  // …and the reading of them is a distance landing on the smallest rung that
  // still CONTAINS it, which is the half that a band spec can get subtly wrong.
  {
    const want = [[150, 200], [200, 200], [300, 400], [700, 800], [1000, 1000], [1001, 2000],
      [2500, 3000], [10000, 10000], [11000, 15000], [49999, 50000], [50001, 60000], [99999, 100000],
      [100001, 120000], [200000, 200000], [200001, 250000], [300000, 300000], [300001, 400000],
      [1000000, 1000000], [2000000, 1000000]]
    const got = want.map(([d]) => [d, stripScaleAt(d)])
    const bad = got.filter(([d, r], i) => r !== want[i][1])
    check('a distance lands on the smallest rung that still contains it',
      stripLadder.length > 0 && bad.length === 0,
      !stripLadder.length ? 'the ladder would not build'
        : bad.length ? 'wrong rung: ' + bad.map(([d, r], i) => `${d} m → ${r} m (want ${want[got.findIndex((g) => g[0] === d)][1]} m)`).join(', ')
        : `${want.length} boundaries, e.g. 1.001 km → 2 km, 11 km → 15 km, 210 km → 250 km, 310 km → 400 km, and past the ceiling the dot clamps while the number stays true`)
  }
  // Hysteresis is a BEHAVIOUR, so it is run rather than pattern-matched -- the
  // same trick the pull easing above uses. The fixture is the real thing that
  // would break it: a pair hovering on the 1 km boundary, ±6 m of fix noise.
  {
    const scaleSrc = fnBody(wayCode, 'meetStripScale')
    let ok = false, why = 'meetStripScale is not evaluable'
    if (scaleSrc && stripLadder.length) {
      try {
        const f = new Function('CONFIG', 'MEET_STRIP_LADDER', 'let meetStripScaleIdx = 0;\nlet meetStripScaleKey = null;\nreturn function meetStripScale(dist, subjectKey) ' + scaleSrc)
        const scale = f({ MEET_STRIP_SHRINK_AT: stripShrink }, stripLadder)
        const hover = []
        for (let i = 0; i < 200; i++) hover.push(scale(1000 + (i % 2 ? 6 : -6)))
        const settled = hover.slice(50).every((s) => s === hover[50])
        const up = []
        for (let d = 0; d <= 60000; d += 50) { const s = scale(d); if (up[up.length - 1] !== s) up.push(s) }
        // The walk out has to be a PREFIX of the ladder (never skipping a rung in
        // the middle) and it has to end on the rung that holds 60 km.
        const monotone = up.every((s, i) => i === 0 || s > up[i - 1]) &&
          up[0] === stripLadder[0] && stripLadder.indexOf(up[0]) === 0 &&
          up.every((s) => stripLadder.indexOf(s) >= 0) && up[up.length - 1] === stripScaleAt(60000)
        // Coming back down, 400 m settles one rung ABOVE itself at most -- that is
        // the hysteresis working, not a failure.
        const back = scale(400)
        ok = settled && monotone && (back === 400 || back === 600)
        why = `hovering on the 1 km boundary settles at ${hover[199]} m · the walk out reads ${up.length} rungs, [${up.slice(0, 6).join(', ')} … ${up[up.length - 1]}] · 400 m apart reads ${back} m`
      } catch (e) { why = 'meetStripScale would not evaluate: ' + e.message }
    }
    check('the bar rescales once on a boundary wobble, not on every fix', ok, why)
  }
  // The colour is closeness RELATIVE TO THE RUNG, and that is a behaviour rather
  // than a decoration: read off the dot's own position instead -- which is what
  // "closeness" naturally suggests -- and with rungs this fine the bar is amber
  // at every range, saying nothing. So it is run here, over the real ladder.
  {
    const closeSrc = fnBody(wayCode, 'meetStripCloseness')
    const tintSrc = fnBody(wayCode, 'meetStripTint')
    let ok = false, why = 'meetStripCloseness / meetStripTint are not in the page'
    if (closeSrc && tintSrc && stripLadder.length) {
      try {
        const close = new Function('CONFIG', 'MEET_STRIP_LADDER',
          'return function meetStripCloseness(dist, i) ' + closeSrc)({ MEET_STRIP_SHRINK_AT: stripShrink }, stripLadder)
        const tint = new Function('return function meetStripTint(t) ' + tintSrc)()
        // The 400 m rung's band runs 200..400: green at its floor, amber at its top.
        const i400 = stripLadder.indexOf(400)
        const lo = close(200, i400), hi = close(400, i400)
        // …and the SAME real distance wears two different colours on two different
        // rungs, which is what "not real distance" has to mean in practice.
        const on2 = close(2000, stripLadder.indexOf(2000))
        const on5 = close(2000, stripLadder.indexOf(5000))
        const painted = "style.background = 'rgb(' + tint + ')'"
        ok = i400 > 0 && Math.abs(lo) < 1e-9 && Math.abs(hi - 1) < 1e-9 && on5 < on2 &&
          tint(0) === '46,204,113' && tint(1) === '245,196,81' &&
          /meetStripCloseness\(/.test(meetStripFn || '') && (meetStripFn || '').includes(painted)
        why = `closeness is ${lo} at the floor of the 400 m rung and ${hi} at its top · 2 km reads ${on2} on the 2 km rung but ${on5} on the 5 km one · green ${tint(0)}, amber ${tint(1)}`
      } catch (e) { why = 'the colour would not evaluate: ' + e.message }
    }
    check('the bar\'s colour is closeness within the scale, green to amber', ok, why)
  }
  // The bar can measure to a PLACE instead of a person -- the second thing it is
  // for -- and the switch for that belongs in Settings -> Map, next to the pace.
  // The load-bearing part is what place mode must NOT inherit: the HUD pill only
  // speaks up for a fence you are pointed at (a 55-degree cone), and a ruler that
  // hid what is behind you would not be a ruler.
  {
    const targetFn = fnBody(wayCode, 'meetStripTarget')
    const setFn = fnBody(wayCode, 'setStripSource')
    const mapAt = wayCode.indexOf("settingsSection('map'")
    const mapBlock = mapAt === -1 ? '' : wayCode.slice(mapAt, mapAt + 2400)
    const switchInMap = mapBlock.includes('data-strip="user"') && mapBlock.includes('data-strip="fence"') &&
      mapBlock.includes('setStripSource(')
    check('the bar can be told to measure to the nearest place, with no direction test',
      !!targetFn && /stripSourceMode === 'fence'/.test(targetFn) && /GEOFENCES/.test(targetFn) &&
      /getDisplayName\(/.test(targetFn) && !/bearingDegrees|angularDiff/.test(targetFn) &&
      !!fnBody(wayCode, 'applyStripSource') && /target\.kind === 'user'/.test(meetStripFn || ''),
      !targetFn ? 'meetStripTarget is not in the page'
        : /bearingDegrees|angularDiff/.test(targetFn)
          ? 'place mode inherited the pill\'s direction test, so the nearest place stops being the nearest place whenever it happens to be behind you'
          : 'place mode no longer reads the setting, no longer names the fence, or the pill\'s "a place has no crossing" guard is gone')
    check('the person-or-place switch is persisted and lives in Settings -> Map',
      (setFn || '').includes("localStorage.setItem('map_strip_source'") &&
      wayCode.includes("localStorage.getItem('map_strip_source')") && switchInMap,
      !setFn ? 'setStripSource is not in the page'
        : !switchInMap ? 'the switch is not in the Map settings section, so the bar would be stuck on one source'
          : 'the choice is not remembered across a reload')
  }
  // ---- The bar's reference is the USER's, not the nearest one's ------------
  // What the picker buys: the bar stops following whoever is nearest and answers
  // about ONE person or place, so its number can grow while you drive. Both halves
  // are RUN rather than pattern-matched -- "the pick quietly loses to the nearest
  // peer" is a one-line bug that reads perfectly fine in a diff. Fixture: MaxX at
  // the origin, Niri 300 m north, Kofi 2 km south, Home1 500 m north.
  const stripAt = (lat, lon) => ({ latitude: lat, longitude: lon, timestamp: new Date().toISOString(), is_driving: true, is_inside_geofence: false })
  const stripFixture = () => ({
    MaxX: stripAt(-18.9137, 47.5361),
    Niri: stripAt(-18.9137 + 300 / 110540, 47.5361),
    Kofi: stripAt(-18.9137 - 2000 / 110540, 47.5361)
  })
  const STRIP_FENCES = [{ name: 'Home1', displayName: 'Home 1', lat: -18.9137 + 500 / 110540, lng: 47.5361 }]
  /** The page's OWN bar functions, over that fixture, with one reference injected. */
  /** A page function as a DECLARATION, parameters included: fnBody returns the
   *  braces only, and the bar's functions are not all zero-argument shapes. */
  const stripDecl = (n) => {
    const at = wayCode.indexOf(`function ${n}(`)
    const body = at === -1 ? null : fnBody(wayCode, n)
    return body ? wayCode.slice(at, wayCode.indexOf(body, at)) + body : null
  }
  const stripRun = (fns, ref, mode) => {
    const bodies = fns.map(stripDecl)
    const distDecl = stripDecl('distanceMeters')
    if (!distDecl || bodies.some((b) => !b)) return null
    const src = `var stripRef = ${JSON.stringify(ref)};\n` + [distDecl, ...bodies].join('\n') +
      `\nreturn { ${fns.join(', ')} };`
    return new Function('latestPing', 'GEOFENCES', 'DEVICES', 'stripSourceMode', 'getDisplayName', src)(
      stripFixture(), STRIP_FENCES, ['MaxX', 'Niri', 'Kofi'], mode || 'user',
      (n) => (n === 'Home1' ? 'Home 1' : n))
  }
  {
    const auto = stripRun(['stripRefTarget', 'meetStripTarget'], null)
    const picked = stripRun(['stripRefTarget', 'meetStripTarget'], { kind: 'user', id: 'Kofi' })
    const silent = stripRun(['stripRefTarget', 'meetStripTarget'], { kind: 'user', id: 'Nobody' })
    const place = stripRun(['stripRefTarget', 'meetStripTarget'], { kind: 'fence', id: 'Home1' })
    let ok = false, why = 'meetStripTarget / stripRefTarget / distanceMeters are not in the page'
    if (auto && picked && silent && place) {
      const a = auto.meetStripTarget('MaxX', null)
      // The pill is talking about Niri in this call; the pick must still win.
      const p = picked.meetStripTarget('MaxX', 'Niri')
      const g = silent.meetStripTarget('MaxX', 'Niri')
      const f = place.meetStripTarget('MaxX', 'Niri')
      const near = (v, want) => !!v && typeof v.dist === 'number' && Math.abs(v.dist - want) < 25
      ok = !!a && a.id === 'Niri' && near(a, 300) &&
        !!p && p.id === 'Kofi' && near(p, 2000) &&
        !!g && g.id === 'Nobody' && g.dist === null &&
        !!f && f.kind === 'fence' && f.name === 'Home 1' && near(f, 500)
      why = `nearest → ${a && a.id} ${a && Math.round(a.dist)} m · picked Kofi → ${p && p.id} ${p && Math.round(p.dist)} m even though Niri is ${a && Math.round(a.dist)} m AND is what the pill is talking about · a pick with no fix → ${g && g.id}, still the subject, dist ${g && g.dist} · a picked place → ${f && f.name} ${f && Math.round(f.dist)} m`
    }
    check('the bar measures to what was picked, even when that is not the nearest', ok, why)
  }
  {
    const rows = stripRun(['stripPickerRows'], { kind: 'user', id: 'Kofi' })
    const placeRows = stripRun(['stripPickerRows'], null, 'fence')
    let ok = false, why = 'stripPickerRows is not in the page'
    if (rows && placeRows) {
      const r = rows.stripPickerRows('MaxX')
      const pr = placeRows.stripPickerRows('MaxX')
      const marked = r.people.concat(r.places).filter((x) => x.active).map((x) => x.id).join()
      ok = r.people.map((x) => x.id).join(' < ') === 'Niri < Kofi' &&
        r.places.map((x) => x.id).join(' < ') === 'Home1' && marked === 'Kofi' &&
        !!r.auto && r.auto.id === 'Niri' && r.autoLabel === 'nearest person' &&
        !!pr.auto && pr.auto.id === 'Home1' && pr.autoLabel === 'nearest place'
      why = `people read ${r.people.map((x) => x.id).join(' < ')}, places ${r.places.map((x) => x.id).join(' < ')}, marked ${marked || 'nothing'}; in place mode Auto is ${pr.auto && pr.auto.id}`
    }
    check('the picker lists every person and place, nearest first, with the pick marked', ok, why)
  }
  // ---- The bar's DIRECTION half --------------------------------------------
  // "2.4 km" is half of "where is it": the other half is WHICH WAY, and it is
  // drawn twice from ONE bearing -- the chip on the bar and the arrow on the map.
  // Two things are worth RUNNING rather than admiring, because both are quiet
  // when they are wrong: that the two halves really are one reading, and that the
  // bearing maths is right (a compass point is a rounding rule, and pointAhead has
  // to land north when it is asked for north).
  {
    const dirFn = fnBody(wayCode, 'renderDirection')
    const pointsSrc = (wayCode.match(/const COMPASS_POINTS = \[[^\]]*\]/) || [])[0]
    const compassDecl = stripDecl('compassPoint')
    const aheadDecl = stripDecl('pointAhead')
    let dirRun = null
    if (pointsSrc && compassDecl && aheadDecl) {
      try {
        dirRun = new Function(pointsSrc + '\n' + [compassDecl, aheadDecl].join('\n') +
          '\nreturn { compassPoint, pointAhead };')()
      } catch (e) { dirRun = null }
    }
    let ok = false, why = 'renderDirection / compassPoint / pointAhead are not in the page'
    if (dirFn && dirRun) {
      const lat = -18.9137, lng = 47.5361
      // The page's own metres-per-degree (111320), NOT the fixture's 110540: the
      // point of this half is that the two agree on where "1 km north" is.
      const north = dirRun.pointAhead(lat, lng, 0, 1000)
      const east = dirRun.pointAhead(lat, lng, 90, 1000)
      const south = dirRun.pointAhead(lat, lng, 180, 1000)
      const nLat = (north.lat - lat) * 111320
      const eLng = (east.lng - lng) * 111320 * Math.cos(lat * Math.PI / 180)
      const cp = dirRun.compassPoint
      const oneReading = dirFn.includes('bearingDegrees(') && dirFn.includes('markerPositions[') &&
        dirFn.includes('meet-strip-bearing-arrow') && dirFn.includes('direction-head') &&
        dirFn.includes('CONFIG.DIRECTION_MIN_M') && dirFn.includes('CONFIG.DIRECTION_MAX_M')
      const barHands = /renderDirection\(selectedDevice, target, tint\)/.test(meetStripFn || '')
      const barClears = /renderDirection\(selectedDevice, null, null\)/.test(meetStripFn || '')
      ok = Math.abs(nLat - 1000) < 5 && Math.abs(north.lng - lng) < 1e-9 &&
        Math.abs(east.lat - lat) < 1e-9 && Math.abs(eLng - 1000) < 5 &&
        north.lat > lat && south.lat < lat &&
        cp(0) === 'N' && cp(22) === 'N' && cp(23) === 'NE' && cp(45) === 'NE' &&
        cp(89) === 'E' && cp(180) === 'S' && cp(270) === 'W' && cp(315) === 'NW' &&
        cp(359) === 'N' && cp(-10) === 'N' &&
        oneReading && barHands && barClears
      why = `1 km north lands ${nLat.toFixed(1)} m up (${(north.lng - lng).toFixed(9)} off in longitude), 1 km east ${eLng.toFixed(1)} m across; ` +
        `0/22/45/89/180/270/315/359 read ${cp(0)}/${cp(22)}/${cp(45)}/${cp(89)}/${cp(180)}/${cp(270)}/${cp(315)}/${cp(359)}; ` +
        (oneReading ? 'one bearing drives the chip, the map arrow and the dot' : 'the chip and the map arrow are not driven by one bearing (or the stand-down distances are gone)') +
        (barHands && barClears ? ', and the bar hands it the target it measures to and clears it when there is none' : ', but the bar never hands it a target (or never takes the arrow back)')
    }
    check('the bar\'s bearing is ONE reading, drawn on the bar and on the map', ok, why)
  }
  {
    const pickSrc = fnBody(wayCode, 'pickStripRef')
    const offSrc = fnBody(wayCode, 'deactivateStripRef')
    const keepSrc = fnBody(wayCode, 'persistStripRef')
    const clickSrc = fnBody(wayCode, 'stripPickerClick')
    const panelJs = fnBody(wayCode, 'renderStripPicker') || ''
    const bootAt = wayCode.indexOf('async function boot()')
    const boot = bootAt === -1 ? '' : wayCode.slice(bootAt, bootAt + 3000)
    const header = (wayCode.match(/<button class="who" id="meet-strip-who"[\s\S]{0,260}?>/) || [''])[0]
    const panel = (wayCode.match(/<div id="strip-picker"[\s\S]{0,140}?>/) || [''])[0]
    check('the pick is remembered, and Auto (or the lit row again) clears it',
      !!pickSrc && !!offSrc && !!keepSrc && !!clickSrc &&
      !!fnBody(wayCode, 'toggleStripPicker') && !!fnBody(wayCode, 'stripPickerAway') &&
      keepSrc.includes("localStorage.setItem('map_strip_ref'") &&
      keepSrc.includes("localStorage.removeItem('map_strip_ref'") &&
      wayCode.includes("localStorage.getItem('map_strip_ref')") &&
      header.includes('toggleStripPicker()') && panel.includes('role="listbox"') &&
      /data-id=/.test(panelJs) && /pickStripRef\(|deactivateStripRef\(/.test(clickSrc) &&
      boot.includes('stripPickerClick') && boot.includes('stripPickerAway'),
      !pickSrc || !offSrc || !keepSrc || !clickSrc ? 'the picker\'s own functions are missing'
        : !header.includes('toggleStripPicker()') ? 'the name on the bar is not a control any more, so the list cannot be opened where the bar is'
          : !panel.includes('role="listbox"') || !/data-id=/.test(panelJs) ? 'the panel is not in the bar\'s own markup, or its rows carry no id to pick'
            : !boot.includes('stripPickerClick') ? 'the delegated row click is never bound, so a tap does nothing'
              : 'the pick is not persisted, or nothing clears it back to Auto')
  }
  {
    const rateDecl = stripDecl('rangeRateKmh')
    const trendSrc = fnBody(wayCode, 'meetStripTrend')
    let ok = false, why = 'rangeRateKmh / meetStripTrend are not in the page'
    if (rateDecl) {
      try {
        const rate = new Function(rateDecl + '\nreturn rangeRateKmh;')()
        const a = { latitude: -18.9137, longitude: 47.5361 }
        const b = { latitude: a.latitude + 1000 / 110540, longitude: a.longitude }   // 1 km due north
        const at = rate(a, b, { x: 0, y: 10 }, { x: 0, y: 0 })    // 10 m/s at it
        const away = rate(a, b, { x: 0, y: -10 }, { x: 0, y: 0 })  // 10 m/s away from it
        const headOn = rate(a, b, { x: 0, y: 10 }, { x: 0, y: -10 })
        ok = Math.abs(at - 36) < 0.1 && Math.abs(away + 36) < 0.1 && Math.abs(headOn - 72) < 0.2 &&
          !!trendSrc && /rangeRateKmh\(/.test(trendSrc) && /rangeRateKmh\(/.test(meetFn || '') &&
          /meetStripTrend\(/.test(meetStripFn || '') && wayCode.includes('id="meet-strip-trend"')
        why = `1 km apart: driving at it reads ${at.toFixed(1)} km/h, driving away ${away.toFixed(1)}, head-on ${headOn.toFixed(1)} — the arrow and the pill must read the same number, or the bar can say "closing" for a pair the pill just called off`
      } catch (e) { why = 'rangeRateKmh would not evaluate: ' + e.message }
    }
    check('the trend arrow is the same range rate the verdict gates on', ok, why)
  }
  {
    const scaleKeySrc = fnBody(wayCode, 'meetStripScale')
    let ok = false, why = 'meetStripScale is not in the page'
    if (scaleKeySrc && stripLadder.length) {
      try {
        const f = new Function('CONFIG', 'MEET_STRIP_LADDER', 'let meetStripScaleIdx = 0;\nlet meetStripScaleKey = null;\nreturn function meetStripScale(dist, subjectKey) ' + scaleKeySrc)
        const scale = f({ MEET_STRIP_SHRINK_AT: stripShrink }, stripLadder)
        for (let i = 0; i < 10; i++) scale(12000, 'user:MaxX')
        const held = scale(11900, 'user:MaxX')
        const fresh = scale(150, 'fence:Home1')
        ok = held === 15000 && fresh === 200
        why = `12 km holds at ${held} m, and a new reference at 150 m reads ${fresh} m (want 200): the old rung was carried onto somebody else's bar`
      } catch (e) { why = 'meetStripScale would not evaluate: ' + e.message }
    }
    check('a new reference starts on its own rung instead of walking down the old one', ok, why)
  }
  // The gauge and the pill differ on exactly one thing, deliberately: a distance
  // reading is still true when it is old, a promise about the next few seconds is
  // not. So this one must NOT bail on staleness, only label it.
  check('the gauge still draws a stale peer and says how old the reading is',
    !!meetStripFn && /MEET_ETA_FRESH_S/.test(meetStripFn) && /old'/.test(meetStripFn) &&
    !/if \(stale\) return/.test(meetStripFn),
    !meetStripFn ? 'renderMeetStrip is not in the page'
      : 'the gauge hides (or keeps silent about) a stale peer: "he was 3 km away, four minutes ago" is still worth showing, with its age')
  // Layout, not maths: the Layer button and the badge strip live in the map's
  // bottom corners, so a strip pinned there as an overlay would sit on one of
  // them. It has to be a sibling that takes its own height.
  check('the meeting strip sits under the map rather than over its bottom corners',
    /<div id="map"><\/div>[\s\S]{0,400}?<div id="meet-strip"/.test(wayCode) && /#meet-strip \{[\s\S]{0,120}?flex-shrink: 0/.test(wayCode),
    'the strip is inside #map or overlays its corners again: the Layer button is bottom-left and the badges bottom-right')

  // (4) Neither page can be verified by reading its text: a syntax error in an
  // inline script is a blank app, served happily, with a 200. By design there
  // is no build step, which makes this the only compile either page gets — and
  // until it existed, nothing caught one (the page's own header named a
  // `check:dashboard` script this repo does not have).
  const { Script } = await import('node:vm')
  const inlineScripts = (html) =>
    [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  for (const [label, html] of [
    ['/way/index.html', way],
    ['/live/index.html', await body(await req('/live/index.html'))],
  ]) {
    const blocks = inlineScripts(html)
    let broken = ''
    for (const code of blocks) {
      try { new Script(code) } catch (e) { broken = String((e && e.message) || e); break }
    }
    check(`${label}: its inline script compiles`,
      blocks.length > 0 && !broken,
      broken ? `a syntax error here renders a blank page, served with a 200: ${broken}`
        : `no inline script found to compile (${blocks.length})`)
  }

  // (5) The build marker is the only way to tell a stale browser tab from a
  // broken deploy, so it has to move with the page it labels. Compared against
  // the last commit that TOUCHED the page rather than against "today" (which
  // would go red by itself), and skipped when git cannot answer — a shallow
  // export has no history to compare against.
  const markerDate = (way.match(/const WAY_BUILD = '([0-9]{4}-[0-9]{2}-[0-9]{2})/) || [])[1]
  let pageCommitDate = null
  try {
    const { execFileSync } = await import('node:child_process')
    pageCommitDate = execFileSync(
      'git', ['log', '-1', '--format=%cs', '--', 'public/way/index.html'],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim() || null
  } catch (e) { pageCommitDate = null }
  check('the build marker is at least as new as the page it labels',
    !!markerDate && (!pageCommitDate || markerDate >= pageCommitDate),
    !markerDate ? 'WAY_BUILD is missing or unparseable'
      : `WAY_BUILD says ${markerDate} but the page last changed on ${pageCommitDate} — a tab that is only stale would read as a broken deploy`)

  // (6) A walking ping moves the DISTANCE anchor as well. The walking branch
  // deliberately stores distance 0 — the page measures a walking leg's geometry
  // (see (2)) — but it used to leave `lastRecordedPoint` where the last DRIVING
  // point was, so the drive after a walk measured from there and was charged the
  // whole walked stretch. Every walking return must re-anchor first; the two
  // returns are counted so a third one added later cannot quietly skip it.
  const driveFn = fnBody(smSrc, 'computeDriving')
  const walkReturns = ((driveFn || '').match(/return \{ isDriving: false, distance: 0\.0 \};/g) || []).length
  const anchoredWalks =
    ((driveFn || '').match(/s\.lastRecordedPoint = \[lat, lon, dt\];\s*return \{ isDriving: false, distance: 0\.0 \};/g) || []).length
  check('a walking ping moves the distance anchor, so the drive after a walk is not charged the walk',
    !!driveFn && walkReturns === 2 && anchoredWalks === walkReturns,
    !driveFn ? 'computeDriving is not in the state machine'
      : `${anchoredWalks} of ${walkReturns} walking returns re-anchor the distance measurement — the rest leave the next driving segment measuring from the last driving point, so a walk is counted as driven km`)

  // (7) An entry is confirmed by the dwell timer and NOTHING else. Two things
  // are pinned here: the unreachable "keep-alive" confirmation this module was
  // ported with (a boolean that was read but never set, so its branch and the
  // `is_keep_alive` column it fed could only ever say "no"), and the guarantee
  // that no path skips ENTRY_GUARD_SECONDS — which a second `confirmEntry(` call
  // above the timer is exactly how you would break.
  const outsideFn = fnBody(smSrc, 'processOutside')
  check('an entry is confirmed by the dwell timer, and nothing else can claim one',
    !!outsideFn && (outsideFn.match(/confirmEntry\(/g) || []).length === 1 &&
      outsideFn.indexOf('ENTRY_GUARD_SECONDS') < outsideFn.indexOf('confirmEntry(') &&
      !/keepAliveInside/.test(smSrc),
    !outsideFn ? 'processOutside is not in the state machine'
      : 'a keep-alive confirmation came back, or an entry can be confirmed without the guard window — a drive-past would be logged as an arrival')

  // (8) A reviewed day is drawn the way the LIVE trail draws it. The overlay
  // painted every segment with the driving weight and opacity, so a walk
  // reviewed after the fact looked like a drive: the same day, told two ways by
  // two views of one app.
  const dayMapFn = fnBody(wayCode, 'showDayOnMap')
  check('a reviewed day draws a walking leg as a walk, not as a drive',
    !!dayMapFn && dayMapFn.includes('walkingLineStyle(color)') && /driving !== segDriving/.test(dayMapFn),
    !dayMapFn ? 'showDayOnMap is not in the page'
      : 'the whole-day review has one style for every segment, so a past walk is drawn at driving weight')

  // (9) GPX carries the whole day — every point the review overlay draws —
  // while it used to filter `is_driving`, so a walking day exported an empty
  // file beside a CSV and a KML that both carried every row.
  const gpxFn = fnBody(wayCode, 'exportCurrentDay')
  check('the GPX holds the whole day, like the CSV and the KML beside it',
    !!gpxFn && /\.filter\(shouldDrawPoint\)/.test(gpxFn) && gpxFn.includes('<trkseg>') &&
      !/filter\(function\(p\) \{ return p\.is_driving/.test(gpxFn),
    !gpxFn ? 'exportCurrentDay is not in the page'
      : 'the GPX export filters the day down to driving again, so a walk-only day downloads an empty track')

  // (10) ONE rule turns stored rows into a distance, and the HUD wears the same
  // number as the Trips card. The badge beside the map added each ping's stored
  // `distance_km` as it arrived while the card measured the path, so one screen
  // carried two figures for one day.
  const hudKmFn = fnBody(wayCode, 'refreshTodayDist')
  const newPingFn = fnBody(wayCode, 'handleNewPing')
  const snapshotFn = fnBody(wayCode, 'handleSnapshot')
  const trackPointFn = fnBody(wayCode, 'handleTrackPoint')
  check('the HUD\'s "km today" is the Trips card\'s number, recomputed not accumulated',
    !!hudKmFn && hudKmFn.includes('computeLegsForDay(') && hudKmFn.includes('drivenKm') &&
      !!newPingFn && newPingFn.includes('refreshTodayDist(') &&
      !!snapshotFn && snapshotFn.includes('refreshTodayDist(') &&
      !!trackPointFn && trackPointFn.includes('refreshTodayDist(') &&
      !/todayDist\[\w+\] \+=|todayDist\[\w+\] = \(todayDist/.test(wayCode),
    'the HUD adds a per-row distance again, so the badge and the Trips card can show two different numbers for one day')

  // (11) The device emoji is a LABEL, not the position. The colour-coded dot is
  // the position: it is the head of the trail and the only thing that says
  // moving / stationary / slow (and the dot is simply absent inside a fence).
  // Draw the glyph at its own anchor and the two fuse -- one blob with the dot
  // buried under the emoji, which is how this read before. The icon box is
  // therefore taller than the glyph and anchored by its bottom edge, so the
  // float gap is (box - glyph) and has to stay a real gap.
  const glyphPx = Number((wayCode.match(/MARKER_GLYPH_PX:\s*([0-9.]+)/) || [])[1])
  const boxPx = Number((wayCode.match(/MARKER_BOX_PX:\s*([0-9.]+)/) || [])[1])
  const markerFn = fnBody(wayCode, 'buildMarker')
  const frameFn = fnBody(wayCode, 'renderDeviceFrame')
  const anchoredBox = /iconSize: \[30, CONFIG\.MARKER_BOX_PX\], iconAnchor: \[15, CONFIG\.MARKER_BOX_PX\]/.test(markerFn || '')
  check('the device icon floats above the position dot instead of covering it',
    !!markerFn && anchoredBox && Number.isFinite(glyphPx) && Number.isFinite(boxPx) &&
      boxPx - glyphPx >= 20,
    !markerFn ? 'buildMarker is not in the page'
      : !anchoredBox ? 'the icon box is no longer anchored by its bottom edge, so the glyph lands on the point the dot is drawn on'
        : `the icon floats only ${boxPx - glyphPx}px above the point (glyph ${glyphPx}px in a ${boxPx}px box) -- the dot is buried under the emoji`)

  // (12) Both layers read ONE position: the dot and the emoji are placed from
  // the same `placed` -- the playback clock's -- never from the raw live ping.
  // Give the dot its own source and the two separate on screen while both read
  // as the device, which is the same two-sources-of-truth fault (10) is about.
  check('the dot and the device icon are placed from one position, the playback clock',
    !!frameFn && /marker\.setLatLng\(\[placed\.lat, placed\.lng\]\)/.test(frameFn) &&
      /placeTip\(devId, placed\.lat, placed\.lng, tipClass\(ping\)\)/.test(frameFn) &&
      !/placeTip\(devId, live\.latitude/.test(frameFn),
    !frameFn ? 'renderDeviceFrame is not in the page'
      : 'the dot is placed from a different position than the device icon, so the two can separate while both read as the device')
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

  // ── WAY is a SECOND installable scope, and every rule above applies to it
  // verbatim. Nothing checked that until now, which is exactly how both of its
  // icons came to be 1254x1254 while declaring `512x512` — 1.0 MB and 939 KB,
  // both listed in /way/sw.js's PRECACHE, so every install pulled ~2 MB of
  // icon over a phone connection for a mark the launcher draws at 192 px. The
  // root manifest had a guard for this class all along (the check above); the
  // /way/ scope simply was not covered by it.
  const wayManRes = await req('/way/manifest.json')
  const wayManBody = await body(wayManRes)
  let wayMan = null
  try { wayMan = JSON.parse(wayManBody) } catch (e) {}
  check('the WAY manifest is served and declares its own install',
    wayManRes.status === 200 && !!wayMan && wayMan.start_url === '/way/' &&
      wayMan.scope === '/way/' && wayMan.display === 'standalone',
    `${wayManRes.status} start_url=${wayMan?.start_url} scope=${wayMan?.scope} display=${wayMan?.display}`)

  const wayFetched = []
  for (const icon of wayMan?.icons || []) {
    const r = await req(icon.src)
    const bytes = Buffer.from(await r.arrayBuffer())
    const dim = pngSize(bytes)
    const want = icon.sizes.split('x')
    check(`WAY icon ${icon.src} is a ${icon.sizes} PNG`,
      r.status === 200 && !!dim && dim.w === Number(want[0]) && dim.h === Number(want[1]),
      `${r.status} ${dim ? `${dim.w}x${dim.h}` : 'not a PNG'} — ${(bytes.length / 1024).toFixed(0)} KB`)
    if (dim) wayFetched.push({ src: icon.src, purpose: icon.purpose || 'any', hash: sha(bytes) })
  }

  const wayAny = new Set(wayFetched.filter((f) => f.purpose.split(' ').includes('any')).map((f) => f.hash))
  const wayMask = wayFetched.filter((f) => f.purpose.split(' ').includes('maskable'))
  check("WAY's maskable icon is its own artwork, not a copy of the plain one",
    wayMask.length > 0 && wayMask.every((m) => !wayAny.has(m.hash)),
    'the maskable icon is byte-identical to an any icon — Android would clip the mark')

  // A manifest and a service worker that disagree about which icons exist is
  // how an install ends up paying for a file no launcher will ever ask for.
  const waySw = await body(await req('/way/sw.js'))
  const wayPrecache = (waySw.match(/const PRECACHE = \[([\s\S]*?)\]/) || [])[1] || ''
  check("WAY's precache and its manifest name the same icons",
    (wayMan?.icons || []).length > 0 &&
      (wayMan?.icons || []).every((i) => wayPrecache.includes(`'${i.src}'`)),
    `manifest lists ${(wayMan?.icons || []).map((i) => i.src).join(' ')} but the worker precaches ${(wayPrecache.match(/'[^']*'/g) || []).join(' ')}`)

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

  // A recipe's ingredients ARE typed text, and a browser eats every line break
  // and blank line in it unless the box that prints them says
  // `white-space: pre-wrap`. That rule used to be scoped to `.recipe .ing` -- a
  // card that renders no ingredients -- so the two surfaces that DO print recipe
  // text (the View sheet and the day panel's gourmet slot) fell through to an
  // unstyled div and the saved paragraphs arrived as one run-on blob; the same
  // text only read correctly in the editor, where a textarea keeps line breaks
  // with no help from CSS. So this asserts two things: `.ing` is a TOP-LEVEL
  // rule (never re-scoped to a parent), and it is pre-wrapped.
  const laokaCss = (await body(await req('/laoka/styles.css'))).replace(/\/\*[\s\S]*?\*\//g, '')
  const ingSelectors = [...laokaCss.matchAll(/([^{}]*)\{/g)].map((m) => m[1].trim()).filter((s) => /\.ing\b/.test(s))
  const scopedIng = ingSelectors.filter((s) => s !== '.ing')
  const ingBody = (laokaCss.match(/(?:^|[}\n])\s*\.ing\s*\{([^}]*)\}/) || [])[1] || ''
  check("a recipe's text keeps the line breaks it was typed with",
    ingSelectors.length > 0 && scopedIng.length === 0 && /white-space:\s*pre-wrap/.test(ingBody),
    scopedIng.length ? `the .ing rule is scoped again (${scopedIng.join(' | ')}) — the View sheet and the day panel render it unstyled, so every line break collapses`
      : !ingSelectors.length ? 'there is no .ing rule at all, so recipe text is printed as plain collapsed text'
        : 'the recipe text box no longer sets white-space: pre-wrap, so a saved recipe reads as one paragraph')

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

  // A link into the app can name an INNER tab of a module, not just the module.
  // Home's dashboard ends on a pantry card, and without this that card would
  // drop the household on the week plan instead of the shelves they tapped. The
  // shell only CARRIES the request into the frame's src — which tabs exist is the
  // module's own business, and the module reads the name at boot.
  const frameSrcOf = (html) => {
    const tag = (html.match(/<iframe[^>]*>/g) || []).find((t) => /module-frame/.test(t)) || ''
    return (tag.match(/src="([^"]*)"/) || [])[1] || '(no src)'
  }
  const shellPantry = await body(await req('/laoka/?tab=pantry'))
  check('a link can open an inner tab of a module, not just the module',
    frameSrcOf(shellPantry) === '/laoka/index.html?tab=pantry',
    `the frame src is ${frameSrcOf(shellPantry)} — the shell ignores ?tab, so a card that links to a module's tab lands on whatever screen that module opens on`)
  // The value comes from the address bar and ends up inside a URL in the page, so
  // anything that is not a plain lowercase tab name is dropped, never reflected.
  for (const junk of ['not%20a%20tab', '%2F..%2Fbudget', '%3Cb%3E', 'PANTRY']) {
    const shellJunk = await body(await req(`/laoka/?tab=${junk}`))
    check(`the shell drops "${junk}" instead of carrying it into the frame`,
      frameSrcOf(shellJunk) === '/laoka/index.html',
      `the frame src is ${frameSrcOf(shellJunk)} — a value typed into the address bar reaches the URL the module parses`)
  }
  const laokaScript = await body(await req('/laoka/app.js'))
  check('and the module reads the tab it was opened with',
    /new URLSearchParams\(window\.location\.search\)\.get\('tab'\)/.test(laokaScript) &&
      /NAV\[n\]\[0\] === wanted/.test(laokaScript),
    'the frame is handed ?tab and the module ignores it, so the deep link does nothing')
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
  //
  // A NEGATIVE period result is orange ON PURPOSE (the period went backwards,
  // which is money out — see the tile's `net >= 0 ?` in budget.tsx), so the
  // assertion is "one of the two money colours, never blue". Requiring teal
  // outright made this check pass or fail on whether the local month happened
  // to be positive — a guard that answers to the test data is not a guard.
  for (const [p, label] of [['/budget/reports', 'Net'], ['/sales', 'Profit']]) {
    const html = await body(await req(p))
    const at = html.indexOf(`>${label}</p>`)
    const before = at > 0 ? html.slice(Math.max(0, at - 400), at) : ''
    check(`${p}: its period result wears a money colour (teal, or orange when negative) — never blue`,
      at > 0 && /teal-|orange-/.test(before) && !/blue-/.test(before),
      at < 0 ? `no ${label} tile on the page` : `${label} is ${before.includes('blue-') ? 'blue' : 'neither teal nor orange'} — the same money in two colours`)
  }
  const debtsHtml = await body(await req('/debts'))
  check('the Debts page prints "owed to us" in purple, like the dashboard does',
    /purple[\s\S]{0,400}Owed to Us/.test(debtsHtml) && !/blue-[\s\S]{0,400}Owed to Us/.test(debtsHtml),
    'credit is in a colour the rest of the app does not use for it (blue) — orange stays "we owe"')

  // Two hardcoded people used to sit in Sompitra's logic and copy: the
  // transaction legend next to the list, and the account a Kiné payment syncs
  // into (an exact `u.username = '…'` match on one person's name). Both read the
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
    // ANY literal, not just the one name that used to be there: a rename makes
    // the old spelling disappear from this file, which would leave the guard
    // green on a hardcoded replacement (found by asking what its mutation was).
    !/username\s*=\s*'/.test(kineSrc) && (kineSrc.match(/kineIncomeAccount\(/g) || []).length >= 3,
    'the account lookup is hardcoded again (a literal username in the SQL, or one of the two call sites bypassing the helper) — a second practitioner silently gets nothing')

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

  // The device login folded case as of the one-spelling rule (below) — the
  // exact username still comes from the DO rather than from USER, which is the
  // trap the run doc records as having cost an hour.
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

  // ── One spelling per person, through BOTH of the phone's doors. Home's login
  // has always matched names case-insensitively; μlogger's own credential check
  // did not, and the device cookie it mints lasts 30 days with nothing
  // re-looking-up the account on each fix. That gave a rename two ways to
  // quietly undo itself: a phone still configured with the old spelling stops
  // uploading, and a session minted before the rename keeps stamping the old
  // spelling onto gps_pings.device_id — the key every marker, trip and HUD row
  // is drawn by. Both are exercised here rather than assumed.
  const foldCase = (s) => {
    const i = s.search(/[A-Za-z]/)
    if (i === -1) return s
    const c = s[i]
    return s.slice(0, i) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + s.slice(i + 1)
  }
  const swappedUser = foldCase(USER)
  const authRes = await req('/ulogger/client/index.php', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ action: 'auth', user: swappedUser, pass: PASS }),
  })
  const authBody = await body(authRes)
  check('μlogger signs in whatever case the phone was configured with',
    /"error"\s*:\s*false/.test(authBody),
    `"${swappedUser}" was refused (${authBody.slice(0, 60)}) while the browser login accepts that same spelling — a phone set up before a rename stops uploading, and its owner has no way to see why`)
  const decodeToken = (t) => {
    try { return JSON.parse(Buffer.from(String(t).split('.')[0], 'base64url').toString('utf8')) } catch (e) { return null }
  }
  // The cookie is read off THIS response's own header, never out of the jar:
  // a refused login sets nothing, and the jar still holds the session an earlier
  // section minted — reading that would let this check pass on a login that
  // never happened.
  const mintedCookie = (authRes.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .find((p) => p.startsWith('way_device_session='))?.slice('way_device_session='.length)
  const canonical = decodeToken(mintedCookie || '')?.deviceId || null
  check('…and the session it mints carries the account\u2019s own spelling, not the typed one',
    !!canonical && canonical !== swappedUser && canonical.toLowerCase() === swappedUser.toLowerCase(),
    `a login typed as "${swappedUser}" minted a session for "${canonical}" — a session echoing the typed casing keeps stamping it onto every ping, which is how the spelling that was just merged away comes back`)

  // The second door, end to end: forge exactly the cookie a phone would still
  // be holding from before the rename, and read back what the intake recorded
  // against it. A fix its receiver rated worse than the limit is the ideal
  // probe — that gate runs first and such a ping writes nothing else at all, so
  // the only trace it can leave is the device id on the drop row.
  let devSecret = null
  try {
    const m = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').match(/^\s*SESSION_SECRET\s*=\s*"?([^"\r\n]+)/m)
    devSecret = m ? m[1].trim() : null
  } catch (e) {}
  const staleId = canonical ? foldCase(canonical) : null
  // The ledger windows the last 25 drops and persists them across runs, so this
  // compares BEFORE and AFTER instead of scanning that history: a row left by an
  // earlier run (including a deliberately mutated one) is not a live failure.
  const accuracyNow = async () =>
    (((await readDiagJson()).ingest?.drops) || []).filter((d) => d.gate === 'accuracy')
  if (devSecret && staleId) {
    const accuracyBefore = await accuracyNow()
    const staleBefore = accuracyBefore.filter((d) => d.deviceId === staleId).length
    const payload = Buffer.from(JSON.stringify({ deviceId: staleId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
    const forged = `${payload}.${createHmac('sha256', devSecret).update(payload).digest('base64url')}`
    await fetch(BASE + '/ulogger/client/index.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `way_device_session=${forged}` },
      body: form({
        action: 'addpos', trackid: '1', lat: '-19.8795533', lon: '47.0307533',
        time: String(Math.floor(Date.now() / 1000)), accuracy: '25', speed: '0',
      }),
    })
    // The ledger reads ORDER BY id DESC, so the NEWEST drop is first — and the
    // newest one is the fix just posted. That ordering is itself a trap: this
    // check first searched from the other end, matched an hour-old row, and
    // stayed green while the mutation it exists to catch sat in the code.
    const accuracyAfter = await accuracyNow()
    const newestDrop = accuracyAfter[0]
    const staleAfter = accuracyAfter.filter((d) => d.deviceId === staleId).length
    check('a session minted under the old spelling writes under the account\u2019s own name',
      newestDrop?.deviceId === canonical && staleAfter <= staleBefore,
      `the newest fix was recorded against "${newestDrop?.deviceId}" for a session claiming "${staleId}" (old spelling in the window: ${staleBefore} → ${staleAfter}) — the old spelling is back in the data, one silent ping at a time`)
  } else if (!devSecret) {
    check('the stale-session proof can run (needs the local SESSION_SECRET)',
      false,
      'SESSION_SECRET could not be read from .dev.vars — this check forges the cookie a pre-rename phone still holds, so without the local secret it proves nothing')
  } else {
    check('the stale-session proof can run (it needs the case probe above to name an account)',
      false,
      `no account resolved from a login typed as "${swappedUser}", so there is no second spelling to forge a cookie with — fix the check above before reading this one`)
  }

  // ── The same rename, through the OTHER door: the browser's socket ──────────
  // A user session lasts 30 days too, so a browser still holds the pre-rename
  // cookie and opens /ws with the old casing. The upgrade used to forward that
  // spelling verbatim and the DO stamped it onto every chat row — the person's
  // own bubbles rendered as somebody else's, and the push lookup (which must
  // FIND the account to route anything) matched nothing: the other phone never
  // rang while the sender's did. Both halves are driven here through a real
  // WebSocket handshake carrying exactly that cookie, because no HTTP shape can
  // reach this door. `ws` is loaded from the tree wrangler already ships: the
  // global WebSocket cannot send a Cookie header, which is the only credential
  // this handshake accepts.
  let WSClient = null
  try {
    WSClient = createRequire(new URL('../node_modules/wrangler/package.json', import.meta.url))('ws')
  } catch (e) {}
  if (!devSecret || !canonical) {
    check('the socket proof can run (it needs the local SESSION_SECRET and a resolved account)',
      false,
      'without both there is no pre-rename cookie to forge for the human door, so this half of the one-spelling rule stays unproven')
  } else if (!WSClient) {
    check('the socket proof can run (it needs the ws client wrangler already ships)',
      false,
      "could not load 'ws' from node_modules/wrangler — this check drives the real /ws handshake, which the global WebSocket cannot do (it takes no Cookie header), so the guard would otherwise pass while proving nothing")
  } else {
    let meId = 0
    try { meId = (JSON.parse(await body(await req('/way/api/users/me'))) || {}).id ?? 0 } catch (e) {}
    const humanPayload = Buffer.from(JSON.stringify({ userId: meId, username: staleId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
    const forgedHuman = `${humanPayload}.${createHmac('sha256', devSecret).update(humanPayload).digest('base64url')}`
    const marker = `one-spelling probe ${Date.now()}`
    const ledgerNow = async () => {
      try { return (JSON.parse(await body(await req('/way/api/debug/notify'))) || {}).lastNotify || null } catch (e) { return null }
    }
    const beforeNotify = await ledgerNow()
    const seen = await new Promise((resolve) => {
      const out = { you: null, echoed: null, err: null }
      let sock = null
      const finish = () => { try { sock && sock.close() } catch (e) {} ; resolve(out) }
      const timer = setTimeout(finish, 8000)
      try {
        sock = new WSClient(BASE.replace(/^http/, 'ws') + '/ws', { headers: { Cookie: `way_user_session=${forgedHuman}` } })
      } catch (e) {
        out.err = String((e && e.message) || e)
        clearTimeout(timer)
        resolve(out)
        return
      }
      sock.on('message', (raw) => {
        let m = null
        try { m = JSON.parse(String(raw)) } catch (e) {}
        if (!m) return
        if (m.type === 'snapshot') {
          // `you` is the identity the DO stamped at connect time — the same one
          // it writes onto every row (and onto every push title).
          out.you = m.you ?? null
          try { sock.send(JSON.stringify({ type: 'chat', message: marker })) } catch (e) {}
        } else if (m.type === 'chat' && String(m.message || '').includes(marker)) {
          // The DO echoes the row it stored, sender field included.
          out.echoed = m.sender ?? null
          clearTimeout(timer)
          finish()
        }
      })
      sock.on('error', (e) => { out.err = String((e && e.message) || 'socket error'); clearTimeout(timer); finish() })
    })
    check('a socket opened with the pre-rename casing still stamps the account\u2019s own name',
      seen.you === canonical && seen.echoed === canonical,
      `a session claiming "${staleId}" opened a socket as you=${seen.you ?? '(no snapshot)'} and stored sender=${seen.echoed ?? '(no echo)'}${seen.err ? ` (${seen.err})` : ''} — a socket echoing the token\u2019s casing re-stamps the old spelling onto every chat row, which is how the spelling that was just merged away comes back`)

    // The push half, asked of the DO's own ledger rather than inferred: "no such
    // user" is the exact outcome of a lookup that cannot find the account, and
    // it is invisible from the outside — the frame looks sent and nothing rings.
    // Polled (the routing runs behind the reply), and compared against the
    // BASELINE, so a decision left by an earlier frame is not read as this one's.
    let routed = null
    for (let i = 0; i < 12; i++) {
      const now = await ledgerNow()
      if (now && now.at !== (beforeNotify && beforeNotify.at)) { routed = now; break }
      await new Promise((r) => setTimeout(r, 250))
    }
    check('\u2026and the chat it carried reaches the routing stage instead of "no such user"',
      !!routed && routed.type === 'chat' && !/no such user/i.test(String(routed.outcome || '')),
      `the DO\u2019s ledger still reads "${routed?.outcome ?? 'nothing new'}" for "${routed?.source ?? '\u2014'}" — a source lookup that finds no account routes nothing while /debug-notify reports a send`)
  }

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
  let notifySrc = '', diagSrc = '', adminSrc = '', idxSrc = '', doLedgerSrc = '', ingestSrc = '', querySrc = ''
  let wayWorkerSrc = '', shareSrc = '', chatSrc = ''
  try { notifySrc = readFileSync(new URL('../src/lib/notify.ts', import.meta.url), 'utf8') } catch (e) {}
  try { diagSrc = readFileSync(new URL('../src/lib/diagnostics.ts', import.meta.url), 'utf8') } catch (e) {}
  try { adminSrc = readFileSync(new URL('../src/routes/admin.tsx', import.meta.url), 'utf8') } catch (e) {}
  try { idxSrc = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8') } catch (e) {}
  try { doLedgerSrc = readFileSync(new URL('../src/way/do/FleetDO.ts', import.meta.url), 'utf8') } catch (e) {}
  try { ingestSrc = readFileSync(new URL('../src/way/routes/ingest.ts', import.meta.url), 'utf8') } catch (e) {}
  try { querySrc = readFileSync(new URL('../src/way/db/queries.ts', import.meta.url), 'utf8') } catch (e) {}
  try { wayWorkerSrc = readFileSync(new URL('../src/way/worker.ts', import.meta.url), 'utf8') } catch (e) {}
  try { shareSrc = readFileSync(new URL('../src/lib/share.ts', import.meta.url), 'utf8') } catch (e) {}
  try { chatSrc = readFileSync(new URL('../public/chat/index.html', import.meta.url), 'utf8') } catch (e) {}

  // The rename's two contracts, read rather than assumed: the password check
  // must fold case (or the tracker is stricter than the login that shares its
  // credential), and the device id must be resolved from the ACCOUNT rather
  // than trusted from the cookie. The live proof goes through one gate; this
  // pins the code path so a later edit cannot reopen either door unnoticed.
  check('μlogger resolves the account the same way the web login does',
    /getUserByUsername\(env\.WAY_DB, username\)/.test(ingestSrc) &&
      !/FROM users WHERE username = \?/.test(ingestSrc) &&
      /lower\(username\) = lower\(\?1\)/.test(querySrc),
    'the phone\u2019s credential check no longer folds case, or is back to an exact `WHERE username = ?` — a phone configured with any other casing of its owner\u2019s name stops uploading')
  check('…and a session\u2019s device id is re-resolved instead of trusted from the cookie',
    /canonicalDeviceId\(env\.WAY_DB, session\.deviceId\)/.test(ingestSrc) &&
      !/const deviceId = session\.deviceId/.test(ingestSrc),
    'the device id goes straight from the 30-day cookie onto every ping — a session minted before a rename re-stamps the old spelling onto gps_pings.device_id')
  // The human door and the push lookup, pinned in source as well as driven live:
  // the live proof above catches a revert of either one, but only while a real
  // socket and a recipient both exist — these read the code path itself, the way
  // the phone-side pair above does.
  check('…the socket resolves the ACCOUNT before it hands the DO a name',
    /getUserByUsername\(env\.WAY_DB, session\.username\)/.test(wayWorkerSrc) &&
      !/headers\.set\("X-WAY-Username", session\.username\)/.test(wayWorkerSrc),
    'the /ws upgrade stamps the token\u2019s own casing, so a browser holding a session from before a rename writes the old spelling onto every chat row — and the push lookup below it can find no account')
  check('…the push lookup folds case on the SOURCE name',
    /u\.username\.toLowerCase\(\) === wanted/.test(doLedgerSrc) &&
      !/cfg\.users\.find\(\(u\) => u\.username === sourceUsername\)/.test(doLedgerSrc),
    'an exact match on the source routes NOTHING for a device or session spelled differently, while /debug-notify still reports the send — the one failure a push pipeline cannot show you')
  check('…the reaction toggle collapses an old spelling onto the current one',
    /Object\.keys\(users\)\.find\(\(k\) => k\.toLowerCase\(\) === reactor\.toLowerCase\(\)\)/.test(doLedgerSrc),
    'a person who reacted before a rename keeps a second key, so their one reaction counts twice and the pill never toggles off')
  check('…a share code minted for any casing resolves to the account',
    /SELECT username FROM users WHERE lower\(username\) = lower\(\?1\)/.test(shareSrc) &&
      !/WHERE username = \?1/.test(shareSrc),
    'the share resolver is back to an exact match, so a code minted as "niri" resolves to nobody — the viewer waits on a name that cannot arrive')
  check('…and the chat page folds names when it decides what is YOURS',
    /sameName\(msg\.sender, currentUser\.username\)/.test(chatSrc) &&
      /sameName\(k, myName\)/.test(chatSrc),
    'rows written before the fix render as someone else\u2019s, and your own reaction pills stop toggling off')


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
  // The household map's SERVED page and the shared module, for the guards that
  // pin the share's badge to that map's readout. The earlier blocks' `way` and
  // `shared` are not in scope here.
  const wayHtml = await body(await req('/way/index.html'))
  const sharedSrc = await body(await req('/shared/playback.js'))
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
      // No `label`: the viewer's page shows the person's OWN name, read from the
      // subject by the server, so a label in this form is ignored by design.
      body: form({ device }),
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
      // It has to be a DIFFERENT PERSON now: one code per device (checked at the
      // end of this section) means two mints for the same one replace each other.
      const targets = ((await (await req('/way/api/share')).json()).deviceOptions ?? []).map((t) => t.deviceId)
      const other = targets.find((d) => d !== device)
      let secondPin = null
      if (!other) {
        log('  \x1b[90m– skipped the two-open-codes check: only one shareable person here\x1b[0m')
      } else {
        const second = await req('/admin/share', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({ device: other }),
        })
        const secondHtml = await body(second)
        secondPin = (secondHtml.match(/id="share-pin">(\d{6})</) || [])[1]
        check('two open codes are offered a way to end them together',
          !!secondPin && /action="\/admin\/share\/revoke-all"/.test(secondHtml),
          `second pin ${secondPin ?? 'missing'}, revoke-all form ${/action="\/admin\/share\/revoke-all"/.test(secondHtml) ? 'present' : 'missing'} — "she has arrived" must not mean revoking them one by one`)
      }

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

      // ── ONE code per person: a second mint for the same device is a
      //    REPLACEMENT, not a second way in. Two live codes for one person means
      //    "who is being shared" has two answers and the admin cannot tell which
      //    one is out there — and the person being shown the map cannot tell
      //    either ──
      const mintFor = async (dev) => {
        const res = await req('/admin/share', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({ device: dev }),
        })
        return ((await body(res)).match(/id="share-pin">(\d{6})</) || [])[1]
      }
      const replacedPin = await mintFor(device)
      const keptPin = await mintFor(device)
      const replacedState = replacedPin ? await req(`/live/api/state?pin=${replacedPin}`) : null
      const replacedBody = replacedState ? await replacedState.json().catch(() => ({})) : {}
      check('a second code for the same person replaces the first',
        !!replacedPin && !!keptPin && replacedPin !== keptPin &&
        replacedState?.status === 410 && replacedBody.code === 'revoked',
        `first ${replacedPin ?? 'missing'} → ${replacedState?.status ?? 'n/a'} ${replacedBody.code ?? ''}, second ${keptPin ?? 'missing'} — two live codes for one person is two answers to "who is being shared"`)
      const openNow = (await (await req(`/way/api/share?device=${encodeURIComponent(device)}`)).json()).open ?? []
      check('and only ONE stays open for that person',
        openNow.length === 1,
        `open ${openNow.length} — the map's own row would offer to stop more than one code for one person`)
      // Leave nothing behind: a later viewer check in this run must not find a
      // code that somebody forgot to end.
      await req('/admin/share/revoke-all', { method: 'POST' })

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

      // ── the WINDOW: the track starts when the code did, not at midnight ──
      // Proven with real uploads through the µlogger path, which takes three of
      // them, because pending_sync only ever holds DRAWN points and the motion
      // engine will not confirm a departure from ONE: it holds the first ping
      // outside the anchor until MOVEMENT_CONFIRM_SECONDS (15 s) of sustained
      // movement has passed, and only the ping that CONFIRMS it is persisted.
      // (A first attempt at this used a single 3-hour-old ping and skipped
      // itself whenever the device had pinged more recently than that.)
      //   anchor : the device's OWN current fix, read from the payload above — a
      //            zero-metre move, so it can never be a "glitch" whatever
      //            instant the previous ping carried. It pins the position and
      //            the clock the next two are judged against.
      //   start  : ~280 m away, 16 s later — the ping that STARTS the departure
      //            (280 m in 16 s = 63 km/h, under the 120 gate). Not persisted.
      //   before : another ~280 m, 32 s after the anchor — the CONFIRMED
      //            departure, the point that lands in pending_sync, and
      //            therefore the one the window must exclude.
      //   after  : inside the grant, so the share is not simply empty.
      // The 32 s of GPS time between the anchor and `before` are bought with
      // TIMESTAMPS, not by sleeping: the three uploads leave together and the
      // clock they carry is what the engine reads.
      // The proof is then a PAIR of codes minted either side of `before`: the
      // first must still show that point and the second must not, which is the
      // difference between "the window works" and "the window happens to be
      // empty".
      const upload = (fields) => req('/ulogger/client/index.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form(fields),
      })
      // The device login is case-sensitive (the dashboard's is not).
      await upload({ action: 'auth', user: device, pass: PASS })
      const mintShare = async (label) => {
        const at = Date.now()
        const res = await req('/admin/share', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({ device, label }),
        })
        const p = ((await body(res)).match(/id="share-pin">(\d{6})</) || [])[1]
        return { pin: p, at }
      }
      const shareState = async (pin) =>
        pin ? await (await req(`/live/api/state?pin=${pin}`)).json().catch(() => ({})) : {}
      const send = (lat, lon, timeSec, speed) => upload({
        action: 'addpos', trackid: '1', lat: String(lat), lon: String(lon),
        time: String(timeSec ?? Math.floor(Date.now() / 1000)), accuracy: '6', speed,
      })
      // A FRESH probe, not the `stateBody` read earlier in this run: the anchor
      // has to be the device's CURRENT fix, or it is a real jump from wherever
      // the phone is now and the glitch gate may drop every ping below.
      const probe = await mintShare('Smoke window probe')
      const live = await shareState(probe.pin)
      const baseLat = Number.isFinite(live.lat) ? live.lat : -18.8360
      const baseLon = Number.isFinite(live.lng) ? live.lng : 47.5500
      const dLat = 0.0025   // ~280 m north per step
      const dLon = 0.0027   // ~285 m east per step (at 19°S)
      // Tight on purpose: 0.0002° is ~22 m, so the ~95 m step that separates
      // the pre-grant point from the in-window one stays distinguishable. (A
      // 0.001 tolerance — ~110 m — cannot tell them apart, and did not.)
      const near = (p, lat, lon) =>
        Array.isArray(p) && Math.abs(p[0] - lat) < 0.0002 && Math.abs(p[1] - lon) < 0.0002

      const grantA = await mintShare('Smoke window A')
      // GPS instants reach the DO in whole seconds while a grant is stamped in
      // milliseconds, so sleep past that boundary: the pre-grant point has to be
      // unambiguously INSIDE code A's window and OUTSIDE code B's.
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const t0 = Math.floor(Date.now() / 1000)
      await send(baseLat, baseLon, t0 - 32, '0')
      await send(baseLat + dLat, baseLon + dLon, t0 - 16, '45')
      await send(baseLat + dLat * 2, baseLon + dLon * 2, t0, '45')
      const aState = await shareState(grantA.pin)
      const beforeShown = (aState.track || []).some((p) => near(p, baseLat + dLat * 2, baseLon + dLon * 2))

      const grantB = await mintShare('Smoke window B')
      // 4 s of real time before the last ping: it must be unambiguously INSIDE
      // code B's window, and ~95 m in 4 s stays under the 120 km/h glitch gate.
      await new Promise((resolve) => setTimeout(resolve, 4000))
      await send(baseLat + dLat * 2 + 0.0006, baseLon + dLon * 2 + 0.00064, null, '45')
      const winState = await shareState(grantB.pin)

      if (!beforeShown) {
        log('  \x1b[90m– skipped the window proof: the pre-grant ping was not persisted (the device is parked inside a\n    fence, or its departure was not confirmed), so this run has nothing older than the grant to exclude\x1b[0m')
      } else {
        check('the shared track starts at the grant, not at midnight',
          winState.ok === true && winState.trackTotal === 1 && winState.track.length === 1 &&
          !(winState.track || []).some((p) => near(p, baseLat + dLat * 2, baseLon + dLon * 2)) &&
          near(winState.track[0], baseLat + dLat * 2 + 0.0006, baseLon + dLon * 2 + 0.00064),
          `track has ${winState.trackTotal ?? '?'} point(s) ${JSON.stringify(winState.track ?? []).slice(0, 160)} — the share that was minted AFTER a drawn point must not show it (code A, minted before it, did)`)
      }
      check('the window it reports is the grant that created it',
        winState.ok === true && !!winState.since &&
        Math.abs(Date.parse(winState.since) - grantB.at) < 15000 &&
        aState.ok === true && !!aState.since &&
        Math.abs(Date.parse(aState.since) - grantA.at) < 15000,
        `since ${winState.since ?? 'missing'} vs minted ${new Date(grantB.at).toISOString()} — the payload has to name the window its own data starts at`)
      // Both codes were minted by this test; leaving them open would hand the
      // next viewer page (and the console) codes nobody meant to keep.
      await req('/admin/share/revoke-all', { method: 'POST' })
    }
  }

  // ── the source contracts: the refusals a test cannot stage ──
  check('the code is hashed before it is ever stored',
    /hashPassword\(env, pin\)[\s\S]{0,900}?INSERT INTO share_links/.test(shareSrc) &&
    // The proximity above is a PROXY — a comment between the two moves it, and
    // a nearby INSERT could bind `pin` anyway while still being "close". This
    // is the property itself: the row written carries the hash, its salt and its
    // cost, and never the pin.
    /\.bind\(input\.kind, subject, label, input\.createdBy, now\.toISOString\(\), expiresAt, hash, salt, iterations\)/.test(shareSrc),
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
  // ── the name the viewer reads, and who may be shared at all ──
  // Both were answered in more than one place, and the lists disagreed: the
  // console offered every row of way-db's `devices`, the mint validated against
  // `users` — so production offered a leftover `Niri` (no account, no pings,
  // EVER, beside the real `niri` with 9,679 of them, the two spellings merged on
  // 2026-09-20) and then refused it at the moment the admin had already decided. And the name was a 40-character text
  // box, so one person's name could sit over another person's map.
  const adminSrc20 = readFileSync(new URL('../src/routes/admin.tsx', import.meta.url), 'utf8')
  // Read here rather than reusing section 21's slice: that one is block-scoped
  // to its own section, so reaching for it would be a ReferenceError, not an
  // empty string (the difference between a guard that fails and one that lies).
  const apiSrc20 = readFileSync(new URL('../src/way/routes/dashboard-api.ts', import.meta.url), 'utf8')
  check('a shareable person is a device WITH AN ACCOUNT, decided in one place',
    /FROM devices d JOIN users u ON u\.username = d\.device_id/.test(shareSrc) &&
    /export async function resolveShareTarget/.test(shareSrc) &&
    /export async function listShareTargets/.test(shareSrc) &&
    // and the mint asks it, rather than testing a list of its own
    /const name = await resolveShareTarget\(shareEnv, device\)/.test(apiSrc20) &&
    // both doors build their list from that one function
    /listShareTargets\(c\.env\)/.test(adminSrc20) &&
    /deviceOptions: await listShareTargets\(shareEnv\)/.test(apiSrc20),
    'the picker and the mint can disagree again: a device row with no account would be offered and then refused')

  check('the viewer\'s page names the person from the SUBJECT, not from a request',
    /label: await subjectName\(env, share\.subject\)/.test(shareSrc) &&
    // createShare takes no label at all, so no caller — and therefore no body —
    // can put one name over another person's map
    /input: \{ kind: string; subject: string; createdBy: string \}/.test(shareSrc) &&
    !/body\.label/.test(shareSrc),
    'the name on the outsider page comes from somewhere a caller controls')

  check('the console offers no free-text label, and asks for one from nobody',
    !/name="label"/.test(adminSrc20) && !/body\.label/.test(adminSrc20),
    'the console still lets an admin type the name the viewer will read, so it can contradict the map underneath it')

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
  // The map library is the page's one third-party dependency, and the viewer is
  // the one person in the product nobody can walk through a reload with.
  const liveRender = liveSrc.slice(
    liveSrc.indexOf('function render('), liveSrc.indexOf("$('go').addEventListener"))
  check('an outsider whose map library failed to load is told so',
    /typeof L === 'undefined'/.test(liveRender) && /Could not load the map/.test(liveRender),
    'a blocked unpkg leaves the viewer with a blank rectangle and no sentence, on the one page that cannot be supported by phone')
  check('a code that has ended is forgotten, not re-submitted on the next visit',
    /removeItem\(PIN_KEY\)/.test(liveEndedBranch),
    'the dead code stays in sessionStorage, so the next visit re-submits it and the page blames the viewer for a typo it did not make')
  check('the viewer badge resolves an address itself',
    /nominatim\.openstreetmap\.org\/reverse/.test(liveSrc) && /class="hud"/.test(liveHtml) && /id="addr"/.test(liveHtml),
    'the lower badge is not the HUD panel, or nothing in it resolves where the device actually is')
  check('the address is asked on its own clock, never on every poll',
    /ADDRESS_MS = 10000/.test(liveSrc) && /parkedHere/.test(liveSrc),
    'the address follows the 5 s poll instead of its own 10 s clock — and a parked device is asked again for an answer we already hold')
  check('an address that no longer describes the device is dropped',
    /ADDRESS_MAX_AGE_M = 400/.test(liveSrc) && /address = null;/.test(liveSrc),
    'a stale address keeps being shown, which is worse than a dash because it looks authoritative')
  check('the address lines are distinct, so one word cannot print twice',
    /function describeAddress/.test(liveSrc) && /seen\[candidates\[i\]\]/.test(liveSrc),
    'the address repeats the same place name on two lines — the old rule printed the suburb as line 1 and again as line 2')
  check('the viewer says SINCE WHEN the track it is drawing began',
    /state\.since \? 'since '/.test(liveSrc),
    'the panel says "today" while showing a window that starts at the code — the one word that would misdescribe it')

  // ── the viewer's map MOVES like the household's ──────────────────
  // Same module, same cursor, same camera. And deliberately FLUID ONLY: the
  // share has no pace switch, because the person holding it is asking "is she
  // nearly here" and a dot that jumps every five seconds answers that worse
  // than a gliding one -- while the NUMBERS stay live (see below).
  const liveFrame = fnBody(liveSrc, 'frame')
  check('the share draws the same fluid cursor as the household map',
    /\/shared\/playback\.js/.test(liveHtml) &&
    /HomePlayback\.cursorPosition\(/.test(liveSrc) && /HomePlayback\.easeFactor\(/.test(liveSrc) &&
    /HomePlayback\.createFollowCamera\(/.test(liveSrc) &&
    // It must READ the lag from the engine, never restate it.
    /FLUID\.LAG_SECONDS \* 1000/.test(liveSrc),
    'the share snaps to each poll instead of drawing the fluid cursor — the map and the share have gone their separate ways')
  // The pace switch is matched case-insensitively AND by its clock: a
  // `mapPace` local reading localStorage is exactly the feature this view must
  // not have, and a guard that only knew the settings key would miss it (found
  // by introducing precisely that variable).
  check('the share has no pace switch, and no private copy of the motion',
    !/map[_]?pace|pace[_]?note/i.test(liveSrc) &&
    // the lag is applied unconditionally, off the engine's one number
    /Date\.now\(\) - FLUID\.LAG_SECONDS \* 1000/.test(liveSrc) &&
    // The easing itself must not be re-implemented here.
    !/Math\.exp\(-/.test(liveSrc) && !/function pullEase|function cursorIndex/.test(liveSrc) &&
    // and the marker is placed from the CURSOR, not from the newest fix
    /marker\.setLatLng\(\[cursor\.lat, cursor\.lng\]\)/.test(liveSrc),
    'the share carries its own version of the motion, or a live/realtime pace — the one thing this view must not have')
  check('the drawn line ends at the marker, never past it',
    !!liveFrame && /upto\.push\(\[cursor\.lat, cursor\.lng\]\)/.test(liveSrc) &&
    /TAIL_MIN_METERS/.test(liveSrc),
    'the trail runs ahead of its own dot: two stories on one screen, and the dot looks late rather than the line looking long')
  check('the viewer\'s NUMBERS stay live while the drawing is delayed',
    /state\.speed/.test(liveSrc) && !!liveFrame && !/foot/.test(liveFrame),
    'the badge was moved onto the delayed clock, so the speed and the age would describe where the dot is drawn instead of where the device is')
  check('the viewer\'s map has ONE background and no switch',
    (liveSrc.match(/L\.tileLayer\(/g) || []).length === 1 &&
    /HomeBasemaps\.streets/.test(liveSrc) && !/L\.control\.layers|baseMaps/.test(liveSrc),
    'the share offers layers to switch, or names a tile host of its own: an outsider gets the map that always works, not a choice to make — and a host named in this file is the dependency that broke this page when OSM blocked the app (2026-09-20)')
  // ── …and it OPENS and RECENTRES at street level ──
  // The page used to open at 14 (a neighbourhood blob) and Recentre clamped to
  // "at least 14", so the question an outsider is holding this page to answer —
  // which street is she on — was the one zoom it could not show. The level is
  // declared once, both call sites must read it, and it may not exceed what the
  // one background this page draws can actually serve (a native-zoom ceiling
  // asks the CDN for tiles that do not exist, and Leaflet upscales the last one
  // into a blur — the map looks fine and is wrong).
  const liveCode = liveSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const basemapsLive = await body(await req('/shared/basemaps.js'))
  const streetsNative = Number((basemapsLive.match(/streets:\s*\{[\s\S]*?maxNativeZoom:\s*(\d+)/) || [])[1])
  const followZoom = Number((liveCode.match(/var FOLLOW_ZOOM = (\d+)/) || [])[1])
  check('the share opens and recentres at street level, inside what its background can serve',
    Number.isFinite(followZoom) && followZoom >= 16 &&
      Number.isFinite(streetsNative) && followZoom <= streetsNative &&
      /map\.setView\(at, FOLLOW_ZOOM\)/.test(liveCode) &&
      /map\.setView\(\[cursor\.lat, cursor\.lng\], FOLLOW_ZOOM\)/.test(liveCode) &&
      !/map\.setView\([^)]*,\s*(1[0-5]|14)\)/.test(liveCode),
    !Number.isFinite(followZoom) ? 'the share declares no FOLLOW_ZOOM'
      : `the share follows at ${followZoom} where its one background serves ${streetsNative}, or a setView still names a zoom of its own — an outsider cannot read a street name from a neighbourhood overview`)
  // ── the badge is a speedometer, and the household map's is its twin ──────
  // WAY's readout is the model: a large tabular figure with the unit under it.
  // The share's is checked against the SAME shape, so "a real dashboard font"
  // is a thing a test can see rather than a matter of opinion, and so a later
  // tidy-up cannot quietly shrink it back into the footer text it came from.
  const spdSize = liveHtml.match(/\.hud \.spd-num \{[^}]*font-size: (\d+)px/)
  const waySpdSize = wayHtml.match(/\.spd-num \{ font-size: (\d+)px/)
  check('the share badge wears a speedometer, not a line of prose',
    /<div class="spd">/.test(liveHtml) && /id="spd"/.test(liveHtml) &&
    !!spdSize && Number(spdSize[1]) >= 32 &&
    /class="spd-unit">km\/h</.test(liveHtml) && /tabular-nums/.test(liveHtml) &&
    !!waySpdSize && /monospace/.test(liveHtml),
    'the badge lost its big speed figure (or its unit), so the one number it exists for is plain body text again')
  check('the speed figure is the LIVE number, coloured by the household ramp',
    // LIVE: the newest fix out of the payload, never the delayed cursor.
    /var kmh = \(state\.speed === null \|\| state\.speed < 0\)/.test(liveSrc) &&
    /spdEl\.textContent = kmh === null \? '--' : String\(kmh\)/.test(liveSrc) &&
    // and its colour is READ from the shared ramp, not restated here.
    /typeof HomePlayback\.speedColor === 'function'/.test(liveSrc) &&
    /rampColor\(kmh\)/.test(liveSrc) &&
    // The lookup is GUARDED, and the call is not even spelled inline: an
    // outsider's browser can hold the engine one deploy behind this document,
    // and a bare call throws right there — leaving the dial grey and every line
    // beneath it, the address and the window, never written. (Found live: the
    // preview pane was holding exactly that older engine.)
    !/HomePlayback\.speedColor\(/.test(liveSrc) &&
    !/#f1c40f|#2ecc71|#38bdf8|#ef4444/.test(liveHtml),
    'the dial is coloured by a private copy of the ramp, it shows the drawn position\'s speed instead of the device\'s, or a stale engine can take the badge\'s other lines down with it')
  // One ramp, two surfaces. A palette that agrees today is exactly what two
  // copies cannot promise, so neither page may hold the hex values.
  // Scoped to the RAMP, not to the hex values: WAY uses these same colours as
  // ordinary UI accents (pills, links, the office zone), so a guard that banned
  // the hexes from the page would be permanently red and therefore ignored. A
  // restated ramp is `maxKmh`, which only the shared module may know.
  check('the speed ramp lives in ONE place, and both maps read it',
    /SPEED_STOPS = \[/.test(sharedSrc) && /maxKmh: 10/.test(sharedSrc) && /'#f1c40f'/.test(sharedSrc) &&
    /SPEED_COLOR_STOPS: HomePlayback\.SPEED_STOPS/.test(wayHtml) &&
    /function speedColor\(kmh\) \{\s*return HomePlayback\.speedColor\(kmh\)/.test(wayHtml) &&
    !/maxKmh/.test(wayHtml) && !/maxKmh/.test(liveSrc),
    'the colour ramp is written out in a page again: WAY\'s trail and the share\'s dial can now disagree about what 50 km/h looks like')
  check('the share\'s camera INHERITS the household cycle instead of overriding it',
    /createFollowCamera\(\{ L: L, getMap: function \(\) \{ return map; \} \}\)/.test(liveSrc),
    'the share now passes its own circle or push/pull numbers, so the two maps can move differently while both claim to share one engine')
  // A local named `window` is not a typo, it is a whole function going dark: the
  // `var` is hoisted, so every `window.` read inside that function is undefined
  // and every statement after the first one is skipped. Found exactly that here
  // — the speed figure appeared while its colour and the badge's whole footer
  // never did, on every poll, forever.
  check('no page shadows the global `window`',
    !/(?:var|let|const)\s+window\b/.test(liveSrc) &&
    !/(?:var|let|const)\s+window\b/.test(wayHtml),
    'a local named `window` makes the global undefined inside that function, so every line after it silently stops running')
  check('the badge footer WRAPS instead of truncating',
    /\.hud-foot \{[^}]*flex-wrap: wrap/.test(liveHtml) &&
    !/\.hud-foot \{[^}]*text-overflow: ellipsis/.test(liveHtml) &&
    /function setFoot\(bits\)/.test(liveSrc) && /bits\[i\]\.text/.test(liveSrc),
    'the footer is a single ellipsised string again, so on a phone it eats the fact that did not fit')
  check('the console asks the database for what ended',
    /listShares\(c\.env, 'ended'\)/.test(adminSrc) && /listShares\(c\.env, 'active'\)/.test(adminSrc),
    'the card only ever asks for active codes, so a revoked one is invisible rather than accountable')
  check('the DO hands out ONE device, and only by the grant\'s id',
    /SELECT state_json FROM device_state WHERE device_id = \?`, deviceId/.test(shareReadBody) &&
    /FROM pending_sync\s+WHERE device_id = \? AND timestamp >= \? ORDER BY id`,\s*deviceId, since/.test(shareReadBody),
    'a live-share read is not scoped to one device by BOTH its query and its bind — a grant for one person could be widened into the whole household')
  // The window travels WITH the request and is REQUIRED at the far end: the
  // reader asks for the grant's own creation instant, and a request without it
  // gets no track at all rather than the whole day.
  check('the shared track starts when the grant was created, not at midnight',
    /since=\$\{encodeURIComponent\(share\.created_at\)\}/.test(shareSrc) &&
    /rows = since\s*\?\s*this\.sql/.test(shareReadBody) &&
    /:\s*\[\];/.test(shareReadBody),
    'the window is not required end to end — a share that cannot say when it started would hand the viewer the whole day')
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

// ─── 21. the same share, asked from the map's own settings ────────
// The console at /admin owns the household-wide card. Settings → Map is the
// same grant asked from the device you are looking at — so there are now TWO
// doors to one capability, and these guards are about them being ONE answer.
log('\n21. Settings → Map: the share row')
{
  const waySrc21 = await body(await req('/way/index.html'))
  const apiSrc21 = readFileSync(new URL('../src/way/routes/dashboard-api.ts', import.meta.url), 'utf8')
  const shareBlock = apiSrc21.slice(apiSrc21.indexOf('// ---- Live share'), apiSrc21.indexOf('// ---- Users (admin)'))
  const minter = fnBody(apiSrc21, 'shareMinter')

  // ── ONE authority for "who may hand out a code" ──
  check('the map decides who may mint the same way the console does',
    !!minter && /env\.HOME_DB/.test(minter) && /HOME_COOKIE/.test(minter) &&
    /getHomeUserFromCookie\(env\.HOME_DB, cookie\)/.test(minter) &&
    /homeUser\.role === "admin"/.test(minter) &&
    // and the W.A.Y role is only a STANDALONE fallback, never the primary
    minter.indexOf('homeUser.role') < minter.indexOf('wayUser.role'),
    'the map grew its own idea of who may hand out a code — a second answer to a privacy question, and the weaker one wins')

  check('every map share route is gated, and a refusal cannot mint',
    (shareBlock.match(/shareMinter\(request, env, user\)/g) || []).length === 3 &&
    (shareBlock.match(/if \(!miner\) return jsonError\("Admin only", 403\)/g) || []).length === 2,
    'a share route skipped the admin gate: letting a relative watch a family member is not a member-level action')

  check('the settings list never carries the pin or its hash',
    /Never the pin or its hash/.test(shareBlock) && !/pin_hash|pin_salt/.test(shareBlock),
    'the list handed the page the pin, or the material to verify one offline')

  check('stop-sharing only ends grants the clock has not already ended',
    /listShares\(shareEnv, "active"\)\)\.filter\(\(s\) => s\.subject === device\)/.test(shareBlock),
    'stop-sharing revokes whatever it finds, so an expired code gets credited to the admin who pressed stop')

  check('a device that does not exist cannot be shared',
    // Through the SAME function the picker is built from: a typo, and the
    // leftover `Niri` device row that has no account, are refused by one answer.
    /const name = await resolveShareTarget\(shareEnv, device\)[\s\S]{0,200}?if \(!name\) return jsonError/.test(shareBlock),
    'a grant can be minted for a typo, so the relative holding it gets a link that can never answer')

  // ── a failed mint has to NAME itself ──
  // This section can be all green while the FEATURE is dead in production, and
  // that is not hypothetical: share_links lives in home-db, which is migrated by
  // HAND, per environment. Every read path here swallows its own error on
  // purpose (the console must keep working on an unmigrated db), and the GET
  // answers `open: []` — so a deployment whose migration was never applied looks
  // perfectly healthy right up to the moment you press Generate, where the
  // INSERT threw and came back as a 500 with NO body at all. A client reading
  // JSON cannot parse that, so it showed its generic fallback: "Could not
  // generate a code." — a sentence that names nothing to act on, from a fault
  // whose fix is one command. These guards pin the naming.
  const shareSrc21 = readFileSync(new URL('../src/lib/share.ts', import.meta.url), 'utf8')
  const adminSrc21 = readFileSync(new URL('../src/routes/admin.tsx', import.meta.url), 'utf8')
  // NOT fnBody here: createShare's signature carries `{ kind: string; … }`, so
  // brace-balancing starts at the PARAMETER type and returns a fragment of the
  // declaration. Sliced by its own boundaries instead.
  const createBody = shareSrc21.slice(
    shareSrc21.indexOf('export async function createShare('),
    shareSrc21.indexOf('export type ShareFilter'))

  check('a mint that cannot reach its table is named, never a bare 500',
    createBody.indexOf('export async function createShare(') === 0 &&
    createBody.length > 400 &&
    !!createBody &&
    createBody.indexOf('try {') > -1 &&
    createBody.indexOf('try {') < createBody.indexOf('INSERT INTO share_links') &&
    /missingTable\(message\) \? 'no_table' : 'db_error'/.test(createBody),
    'the share INSERT throws, so an environment missing its migration answers a bodyless 500 and the page can only shrug')

  check('the missing-table answer names the migration to apply',
    /0006_share_links\.sql/.test(fnBody(shareSrc21, 'shareErrorText') || ''),
    'the message for the likeliest break does not say which file to run, so the fix is not in the error')

  // …and the same rule at the BOUNDARY, which is where the one above cannot
  // reach: a throw in `requireUser`, or in the identity lookup the minter does
  // before lib/share.ts is ever called, escaped as a bodyless 500 — and a JSON
  // client flattens that back into the same "Could not generate a code." the
  // named errors exist to end. Seen live on POST /api/share (2026-09-21), so
  // this is a real answer that was missing, not a defensive habit.
  const wayWorkerSrc = readFileSync(new URL('../src/way/worker.ts', import.meta.url), 'utf8')
  const handleWayBody = fnBody(wayWorkerSrc, 'handleWay') || ''
  check('an unexpected throw on WAY\'s API answers a sentence, never a bodyless 500',
    handleWayBody.indexOf('try {') > -1 &&
    handleWayBody.indexOf('try {') < handleWayBody.indexOf('return isAuth') &&
    /catch \(e\)/.test(handleWayBody) &&
    /Content-Type": "application\/json"/.test(handleWayBody) &&
    /console\.error/.test(handleWayBody),
    'a throw above the named-error layer answers a bodyless 500 again — the page can only say "Could not generate a code.", and nothing is logged to say why')

  check('both doors report a failed mint with the same words',
    // The TEXT and the STATUS together, from the same module: a typo is the
    // caller's mistake (400) and a missing table is the deployment's (500), and a
    // hardcoded status was a real defect here — found by removing the route's own
    // refusal and watching the backstop answer 500 for a device that does not
    // exist.
    /jsonError\(shareErrorText\(created\.error\), shareErrorStatus\(created\.error\)\)/.test(shareBlock) &&
    /shareErrorText\(code\)/.test(adminSrc21) &&
    /err=\$\{encodeURIComponent\(created\.error\)\}/.test(adminSrc21) &&
    !/err=share_failed/.test(adminSrc21),
    'the console flattens every failed mint into one word, so the reason is lost before the operator reads it')

  // ── the UI sits where it was asked for: Settings → Map, under the switch ──
  const mapSection = waySrc21.slice(waySrc21.indexOf("settingsSection('map'"), waySrc21.indexOf("settingsSection('notif'"))
  const paceAt = mapSection.indexOf('pace-pill')
  // Anchored on the RENDERED element (its emoji and its container), never on
  // the word alone: a code comment in this section says "Live share" too, and
  // a guard satisfied by prose stayed green when the row itself was deleted
  // (found by deleting exactly that line).
  const shareAt = mapSection.indexOf('🔗 Live share')
  check('the share row lives in Settings → Map, under the pace switch',
    paceAt > -1 && shareAt > paceAt &&
    /settings-title[^>]*>🔗 Live share<\/div>/.test(mapSection) &&
    /id="share-block">/.test(mapSection),
    'the share controls moved out of the map settings, or above the pace switch they were asked to sit under')

  check('the share row offers nothing to someone who cannot mint',
    /if \(!shareState\.canShare\) return '<div class="settings-hint">Only an admin can hand out a code\.<\/div>'/.test(waySrc21),
    'a non-admin is shown a button that can only fail')

  check('a code is never persisted by the page',
    /let shareState = null/.test(waySrc21) &&
    !/localStorage\.setItem\([^)]*[Pp]in/.test(waySrc21) &&
    !/sessionStorage\.setItem\([^)]*[Pp]in/.test(waySrc21),
    'the page kept a live code somewhere it outlives the tab — a code is a key to a person\'s movements')

  check('stopping a share clears the code from the screen',
    /shareState\.lastPin = null/.test(waySrc21),
    'a revoked code stayed on screen as a copyable link')

  // ── live: anonymous, then the admin path that the UI actually walks ──
  const anonMint = await fetch(`${BASE}/way/api/share`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: 'MaxX' }),
  })
  check('an anonymous request cannot mint a code from the map',
    anonMint.status === 401,
    `status ${anonMint.status} — the map's share routes are not behind a session at all`)

  const device21 = (await body(await req('/admin'))).match(/<option value="([^"]+)">[^<]*\(/)?.[1]
  if (!device21) {
    log('  \x1b[90m– skipped the live map-share flow: no W.A.Y device exists in way-db yet\x1b[0m')
  } else {
    const can = await (await req(`/way/api/share?device=${encodeURIComponent(device21)}`)).json()
    check('an admin asking the map is told they can share',
      can.canShare === true && Array.isArray(can.open) && !JSON.stringify(can).includes('pin'),
      `canShare ${can.canShare}, open ${can.open?.length} — and the listing must never mention a pin`)

    const minted = await (await req('/way/api/share', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device: device21, label: 'From the map' }),
    })).json()
    const mapPin = minted.pin
    check('the map can mint a real code',
      /^\d{6}$/.test(mapPin || '') && minted.device === device21,
      `pin ${mapPin ?? 'missing'} — a code the map shows must be a code /live answers`)

    const live = await fetch(`${BASE}/live/api/state?pin=${mapPin}`)
    const liveState = await live.json()
    check('the code the MAP minted resolves on /live, from its own creation instant',
      live.status === 200 && !liveState.error && !!liveState.since && liveState.since >= minted.createdAt,
      `status ${live.status}, since ${liveState.since} vs createdAt ${minted.createdAt} — the window must be the grant, whichever door made it`)

    const listed = await (await req(`/way/api/share?device=${encodeURIComponent(device21)}`)).json()
    check('the settings list shows the open grant, and never the code',
      listed.open.length === 1 && listed.open[0].created_by && !JSON.stringify(listed).includes(mapPin),
      `open ${listed.open.length}, and the list must not repeat the pin it was shown once`)

    const stopped = await (await req('/way/api/share/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device: device21 }),
    })).json()
    const afterStop = await fetch(`${BASE}/live/api/state?pin=${mapPin}`)
    check('stop-sharing from the map really ends the code',
      stopped.revoked === 1 && afterStop.status === 410,
      `revoked ${stopped.revoked}, the code then answers ${afterStop.status}`)

    const unknown = await req('/way/api/share', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device: 'NoSuchDevice' }),
    })
    check('a grant cannot be minted for a device that does not exist',
      unknown.status === 400,
      `status ${unknown.status} — a typo would hand out a link that can never answer`)
  }
}

// ─── 22. Two shopping lists: the week's meals, and the pantry ────
log('\n22. Two shopping lists: the week\'s meals and the pantry')
{
  // The catalogue is TWO domains, split by `groups.is_pantry`, and the whole
  // feature IS that boundary:
  //
  //   MEAL     protein · sides · raw salads   planned, bought for the week,
  //                                           cooked, never counted
  //   PANTRY   spices · oils · condiments ·   NOT planned, NOT in a week's list,
  //            dry staples, and whatever     counted by hand, bought on a trip
  //            the household adds (cleaners, of its own, with its own expense
  //            toilet paper)
  //
  // Every cheap shortcut crosses it: a count on a chicken thigh, a staple drawn
  // into a plan or auto-added to the week, or a trip that is not its own identity
  // and so charges the budget twice. So this section pins the boundary in the
  // code, then counts a real shelf, prices a real trip, and walks both Sompitra
  // doors on the local database.
  const src = (p) => {
    try {
      return readFileSync(new URL('../' + p, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    } catch (e) { return '' }
  }
  const queries = src('src/laoka/data/queries.js')
  const pantryRoute = src('src/laoka/routes/pantry.js')
  const budgetCode = src('src/routes/budget.tsx')
  const laokaJs = await body(await req('/laoka/app.js'))

  // (a) The boundary, in the code. The meal catalogue is what a plan, a pool and
  // the week's list are built from, so `is_pantry = 0` THERE is what keeps every
  // meal screen blind to a count -- and stock is deliberately not even selected.
  const catalogFn = fnBody(queries, 'getCatalogTree') || ''
  check('the meal catalogue is scoped away from the pantry, and reads no counts',
    /is_pantry\s*=\s*0/.test(catalogFn) && !/i\.stock/.test(catalogFn),
    'getCatalogTree no longer filters g.is_pantry = 0, or it selects stock again — the meal side can show a pantry count')
  const poolsFn = fnBody(queries, 'getSelectedPools') || ''
  check('a pantry item can never be drawn into a plan',
    /is_pantry\s*=\s*0/.test(poolsFn),
    'the draw pools are not pantry-scoped, so a staple can end up inside a week')

  // The week's list answers one question -- what does this week's cooking need?
  // -- and the pantry is not part of it: by construction, not by a UI filter.
  const syncFn = fnBody(queries, 'syncShoppingLines') || ''
  check('the week\'s list is built from the plan and nothing else',
    !syncFn.includes('Pantry') && !syncFn.includes('LowStock'),
    'syncShoppingLines folds pantry items into the week again — the two shopping lists are one list')

  // The pantry rule: per item's own level, pantry-scoped, and never pulling in
  // an item nobody counts.
  const lowFn = fnBody(queries, 'getLowStockItemIds') || ''
  check('the to-buy rule is pantry-only, and compares each item with ITS OWN level',
    /is_pantry\s*=\s*1/.test(lowFn) && /\.stock\s*<\s*i\.stock_min/.test(lowFn) && !/\.stock\s*<\s*\d/.test(lowFn),
    'the rule is no longer pantry-scoped, or a number was written into the SQL')
  check('an item nobody counts is never offered',
    /stock\s+IS\s+NOT\s+NULL/.test(lowFn),
    'a NULL count is treated as a number, so untracked items join the to-buy list')

  // A boundary the SERVER enforces, not just the screen: every pantry write asks
  // whether the item is a pantry item first.
  check('every pantry write checks the item belongs to the pantry',
    /isPantryItem\(ctx\.env, itemId\)/.test(pantryRoute),
    'the pantry route writes without asking the domain, so a meal ingredient can be counted from the wrong screen')

  // (b) The boundary, by asking. Bootstrap is what the module draws from.
  let lboot = null
  try { lboot = JSON.parse(await body(await req('/laoka/api/bootstrap'))) } catch (e) {}
  const mealGroups = (lboot?.catalog || []).map((g) => g.name)
  check('the meal catalogue contains no pantry group',
    mealGroups.length > 0 && !(lboot?.catalog || []).some((g) => g.isPantry),
    `catalog groups: ${mealGroups.join(', ')}`)
  const pantryTree = lboot?.pantry || []
  const pantryItems = []
  for (const g of pantryTree) for (const s of g.subgroups || []) for (const it of s.items || []) pantryItems.push(it)
  check('the pantry is its own tree, and every item in it carries a count',
    pantryTree.length > 0 && pantryItems.length > 0 &&
      pantryTree.every((g) => g.isPantry === true) &&
      pantryItems.every((it) => (it.stock === null || typeof it.stock === 'number') &&
        typeof it.stockMin === 'number' && it.tripPrice !== undefined),
    `${pantryItems.length} items in ${pantryTree.length} group(s)`)

  const mealItemId = (() => {
    for (const g of lboot?.catalog || []) for (const s of g.subgroups || []) for (const it of s.items || []) return it.id
    return 0
  })()
  // Asking is the only way to tell "filtered out of a payload" from "refused by
  // the server" -- and the second is what stops a meal ingredient from being
  // counted at all.
  const mealPatch = await req(`/laoka/api/pantry/items/${mealItemId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stock: 1 }),
  })
  check('counting a MEAL ingredient through the pantry is refused',
    mealPatch.status === 404, `status ${mealPatch.status} for meal item ${mealItemId}`)

  // The pantry owns its CATEGORIES too, and it has to: the meal Catalog's tree is
  // scoped to `is_pantry = 0`, so a pantry category never appears there — without
  // these two writes a typo in a category name would be permanent, and adding a
  // category would mean adding an item to it first. The same domain boundary has
  // to hold for them, so this aims BOTH writes at a throwaway MEAL group: the
  // only way to tell "refused by the server" from "quietly renamed a meal group"
  // is to look at it afterwards.
  check('the pantry route owns the category writes, behind the domain check',
    /isPantryCategory\(ctx\.env, id\)/.test(pantryRoute) &&
      /pattern: '\/api\/pantry\/categories\/:id'/.test(pantryRoute) &&
      /pattern: '\/api\/pantry\/categories\/:id\/delete'/.test(pantryRoute),
    'the pantry cannot rename or remove its own categories, so a mistyped one is permanent and tidying up a shelf means deleting staples one by one')
  // A local parser: the section's shared `parse` is declared further down (the
  // helpers block), and reaching for it here is a temporal-dead-zone error.
  const jsonOf = async (res) => { try { return JSON.parse(await body(res)) } catch (e) { return null } }
  const mealGroupId = (lboot?.catalog || [])[0]?.id || 0
  const probeGroup = await jsonOf(await req('/laoka/api/subgroups', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'zz smoke meal group', groupId: mealGroupId, slotRole: 'none' }),
  }))
  check('the suite could make a throwaway MEAL group to aim the pantry writes at',
    !!(probeGroup && probeGroup.id),
    `POST /laoka/api/subgroups answered ${JSON.stringify(probeGroup)} — the meal catalog is unreachable, so the two checks below would have been skipped`)
  const probeId = (probeGroup && probeGroup.id) || 0
  const hijack = await req(`/laoka/api/pantry/categories/${probeId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'hijacked' }),
  })
  check('renaming a MEAL group through the pantry is refused',
    hijack.status === 404, `status ${hijack.status} for meal group ${probeId}`)
  const sink = await req(`/laoka/api/pantry/categories/${probeId}/delete`, { method: 'POST' })
  check('removing a MEAL group through the pantry is refused',
    sink.status === 404, `status ${sink.status} for meal group ${probeId}`)
  const afterHijack = await jsonOf(await req('/laoka/api/bootstrap'))
  const probeStill = (() => {
    for (const g of afterHijack?.catalog || []) for (const s of g.subgroups || []) if (s.id === probeId) return s
    return null
  })()
  check('the MEAL group both refusals aimed at is untouched',
    !!probeStill && probeStill.name === 'zz smoke meal group',
    `the throwaway meal group is now ${probeStill ? JSON.stringify(probeStill.name) : 'gone'} — a pantry write reached the meal catalog`)
  // …and the meal catalog's OWN door is what removes it (soft delete, like every
  // other removal here). Each run leaves one soft-deleted probe row in the local
  // laoka DB — invisible everywhere, and local only: this suite never runs
  // against a deployed database.
  await req(`/laoka/api/subgroups/${probeId}`, { method: 'DELETE' })

  const renderPantryFn = fnBody(laokaJs, 'renderPantry') || ''
  const headerAt = renderPantryFn.indexOf("class: 'pantrygroup'")
  const emptyAt = renderPantryFn.indexOf('if (!list.length)')
  check('a pantry category with nothing in it still draws, buttons included',
    /function addPantryCategory\(\)/.test(laokaJs) && headerAt > -1 && emptyAt > headerAt &&
      /Nothing in it yet/.test(renderPantryFn),
    'an empty category is skipped again, so “New category” looks like a button that does nothing and its rename/remove buttons are unreachable')
  check('each heading acts on ITS OWN category, not the last one in the loop',
    /\(function \(cat\) \{/.test(renderPantryFn) && /\}\)\(sub\);/.test(renderPantryFn) &&
      /editPantryCategory\(cat\)/.test(renderPantryFn) &&
      /removePantryCategory\(cat\)/.test(renderPantryFn) &&
      !/editPantryCategory\(sub\)/.test(renderPantryFn),
    'the handlers close over the loop variable again, so every ✏️ renames the LAST category in the pantry — this exact bug shipped once in this file, found by clicking the buttons')
  check('the Pantry tab can rename, remove and add a category',
    /function editPantryCategory\(sub\)/.test(laokaJs) && /function removePantryCategory\(sub\)/.test(laokaJs) &&
      /function createPantryCategory\(name, icon\)/.test(laokaJs) &&
      /'\/api\/pantry\/categories\/' \+ sub\.id/.test(laokaJs) &&
      /'\/api\/pantry\/categories\/' \+ sub\.id \+ '\/delete'/.test(laokaJs),
    'the category buttons are not wired to the pantry category API')
  const managerFn = fnBody(laokaJs, 'groupManagers') || ''
  check('the meal catalog no longer offers to make a pantry group',
    /isPantry: 0/.test(managerFn) && !/pantry1/.test(managerFn),
    'the Catalog can create a pantry group its own tree can never show — it then appeared as a second, meaningless heading on the Pantry tab')
  const delCatFn = fnBody(queries, 'deletePantryCategory') || ''
  const linesAt = delCatFn.indexOf('DELETE FROM pantry_lines')
  const itemsAt = delCatFn.indexOf('UPDATE items SET deleted_at')
  check('removing a category takes its items AND their trip lines with it',
    linesAt > -1 && itemsAt > linesAt && /UPDATE subgroups SET deleted_at/.test(delCatFn),
    'the category goes but its items or their priced lines are left behind — either counts nobody can see, or a trip that draws nothing and can never be dropped')

  const parked = new Map(jar)
  jar.clear()
  const anonPantry = await req('/laoka/api/pantry')
  jar.clear(); for (const [k, v] of parked) jar.set(k, v)
  check('the pantry is session-gated like every other surface',
    anonPantry.status === 401 || anonPantry.status === 302,
    `${anonPantry.status} — the pantry answered an anonymous caller`)

  // Helpers for the walk. Every write answers with the whole screen, so a check
  // reads the answer instead of re-deriving state.
  const parse = async (res) => { try { return JSON.parse(await body(res)) } catch (e) { return null } }
  const jpatch = (path, payload) => req(path, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  const linesOf = async (weekId) => {
    try { return (JSON.parse(await body(await req(`/laoka/api/state?week=${weekId}`))).shopping) || [] } catch (e) { return [] }
  }

  // (c) A count, on real local data, moved down and put back. The point of the
  // walk is what it does NOT touch: a count is a pantry fact, so it can never
  // move a week.
  const openWeeks = (lboot?.weeks || []).filter((w) => w.status !== 'archived')
    .sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)))
  const week = openWeeks[0]
  const target = pantryItems[0] || null
  if (!target) {
    log('  \x1b[90m– skipped the count walk: the local pantry is empty\x1b[0m')
  } else {
    const original = { stock: target.stock, stockMin: target.stockMin }
    const linesBefore = week ? (await linesOf(week.id)).map((l) => l.itemId).sort().join(',') : null
    try {
      const down = await parse(await jpatch(`/laoka/api/pantry/items/${target.id}`,
        { stock: Math.max(0, Number(target.stockMin) - 1) }))
      check('counting a staple below its level puts it on the to-buy list, and says so',
        down?.ok === true && down.item?.low === true && (down.toBuy || []).some((i) => i.id === target.id),
        `low=${down?.item?.low}, toBuy=${(down?.toBuy || []).length}`)
      if (week) {
        const linesAfter = (await linesOf(week.id)).map((l) => l.itemId).sort().join(',')
        check('and never reaches the week\'s shopping list',
          linesAfter === linesBefore,
          `week ${week.id} changed from [${linesBefore}] to [${linesAfter}] — a pantry count moved a meal list`)
      }
      const up = await parse(await jpatch(`/laoka/api/pantry/items/${target.id}`,
        { stock: Number(target.stockMin) + 2 }))
      check('counting it back up takes it off again',
        up?.ok === true && up.item?.low === false && !(up.toBuy || []).some((i) => i.id === target.id),
        `low=${up?.item?.low}, still on toBuy=${(up?.toBuy || []).some((i) => i.id === target.id)}`)
    } finally {
      // Never leave a shelf counted differently because a check ran.
      await jpatch(`/laoka/api/pantry/items/${target.id}`, original)
    }
  }

  // (d) A trip: a price belongs to the SHOPPING, not to the item, and pushing is
  // what ends it. Skipped out loud when there is nothing to buy, or when the
  // household has a trip in progress -- the suite must not clear prices somebody
  // typed, and must not spend money nobody asked it to spend.
  const live = await parse(await req('/laoka/api/pantry'))
  if (!live) {
    bad('the pantry answers with its whole screen', 'GET /laoka/api/pantry did not return JSON')
  } else if (live.trip && live.trip.count > 0) {
    log('  \x1b[90m– skipped the trip half: a pantry trip is already in progress, and it holds prices the household typed\x1b[0m')
  } else if (!(live.toBuy || []).length) {
    log('  \x1b[90m– skipped the trip half: nothing is below its reorder level in the local pantry\x1b[0m')
  } else {
    const buy = live.toBuy[0]
    try {
      // A line is a QUANTITY at a UNIT PRICE, and every guard below is about
      // that product staying right. THREE at 1,000 each (not "3,000") is what
      // this walk types, because the money is the app's arithmetic now.
      //
      // A quantity on its own is not a purchase: "I bought four" with no price
      // is not money, must record nothing, and must NOT start a trip (an empty
      // Ar 0 shopping would sit on the screen until somebody noticed).
      const qtyAlone = await parse(await jpatch('/laoka/api/pantry/trip', { itemId: buy.id, qty: 4 }))
      check('a quantity with no price records nothing and opens no trip',
        qtyAlone?.ok === true && !qtyAlone.trip &&
          (qtyAlone.toBuy || []).some((i) => i.id === buy.id && i.tripPrice === null && i.tripQty === 1),
        `trip=${JSON.stringify(qtyAlone?.trip)} — a quantity-only tap started a shopping`)

      // The other half of that rule: a price of ZERO is an emptied box, not a
      // free item. Every reader of a line asks `price > 0`, so a stored 0 is a
      // line that draws nowhere, that no empty-trip check can count -- an "Ar 0"
      // trip whose hand-off button opens an empty form -- and it can never be
      // cleared, because clearing walks the lines that DO draw.
      const zero = await parse(await jpatch('/laoka/api/pantry/trip', { itemId: buy.id, price: 0, qty: 1 }))
      check('a price of zero records nothing and opens no trip',
        zero?.ok === true && !zero.trip &&
          (zero.toBuy || []).some((i) => i.id === buy.id && i.tripPrice === null),
        `trip=${JSON.stringify(zero?.trip)} — a zero price left a line nothing shows and nothing can empty`)

      const priced = await parse(await jpatch('/laoka/api/pantry/trip', { itemId: buy.id, price: 1000, qty: 3 }))
      check('a unit price and a quantity open a trip and total the product',
        priced?.trip && priced.trip.count === 1 && priced.trip.total === 3000 && priced.trip.pushedAt === null,
        `trip=${JSON.stringify(priced?.trip)}`)
      check('and the to-buy line shows the unit price and the quantity apart',
        (priced?.toBuy || []).some((i) => i.id === buy.id && i.tripPrice === 1000 && i.tripQty === 3 && i.tripTotal === 3000),
        `line=${JSON.stringify((priced?.toBuy || []).find((i) => i.id === buy.id))}`)
      check('the trip itself carries the unit price, the quantity and the line total',
        (priced?.trip?.lines || []).length === 1 &&
          (priced.trip.lines || []).some((l) => l.qty === 3 && l.price === 1000 && l.total === 3000),
        `lines=${JSON.stringify(priced?.trip?.lines)}`)
      check('a quantity is a fact about the SHOPPING, not about the shelf',
        (priced?.toBuy || []).every((i) => i.id !== buy.id || i.stock === buy.stock),
        'counting a trip changed how many are at home — a purchase must not fill a shelf')

      const form = await body(await req(`/budget/add-expense?from_pantry=${priced.trip.id}`))
      const rows = form.slice(form.indexOf('id="line-items"'), form.indexOf('id="itemized-total-display"'))
      check('the trip opens Sompitra\'s own form, priced, on the itemized pane',
        /🧺 Pantry shopping trip/.test(form) &&
          new RegExp(`name="pantry_trip" value="${priced.trip.id}"`).test(form) &&
          /if \(true\) \{ showMode\('itemized'\)/.test(form) &&
          rows.includes(`value="${buy.name} ×3"`) && rows.includes('value="3000"'),
        'the pantry hand-off did not pre-fill the form with the line and its quantity')
      check('and the form says what it will spend',
        /Ar 3,000/.test(form),
        'the form does not show the trip\'s total')
      // Correcting ONE half must not disturb the other, and the money must follow.
      const qtyOnly = await parse(await jpatch('/laoka/api/pantry/trip', { itemId: buy.id, qty: 5 }))
      check('changing only the quantity keeps the unit price and re-multiplies',
        qtyOnly?.trip && qtyOnly.trip.total === 5000 &&
          (qtyOnly.toBuy || []).some((i) => i.id === buy.id && i.tripPrice === 1000 && i.tripQty === 5),
        `trip=${JSON.stringify(qtyOnly?.trip)}`)
      const priceOnly = await parse(await jpatch('/laoka/api/pantry/trip', { itemId: buy.id, price: 2000 }))
      check('changing only the unit price keeps the quantity',
        priceOnly?.trip && priceOnly.trip.total === 10000 &&
          (priceOnly.toBuy || []).some((i) => i.id === buy.id && i.tripPrice === 2000 && i.tripQty === 5),
        `trip=${JSON.stringify(priceOnly?.trip)}`)
      // A fraction is not money here. The trip multiplies price × qty EXACTLY,
      // while the Sompitra hand-off truncates each line to whole Ariary before it
      // sends it, so a stored 1,000.5 at 3 would be 3,001.5 on the screen and
      // 3,000 in the budget. The boxes take digits now, so only the API can post
      // one — and the API is a door too.
      const fraction = await parse(await jpatch('/laoka/api/pantry/trip', { itemId: buy.id, price: 1000.5, qty: 3.7 }))
      check('a fractional price or count is stored whole, so both totals agree',
        fraction?.trip && fraction.trip.total === 3000 &&
          (fraction.toBuy || []).some((i) => i.id === buy.id && i.tripPrice === 1000 && i.tripQty === 3),
        `trip=${JSON.stringify(fraction?.trip)} — the screen total and the total the budget receives would differ by the fraction`)

      const ghost = await body(await req('/budget/add-expense?from_pantry=999999'))
      check('a trip that does not exist gives an ordinary empty form',
        !/Pantry shopping trip/.test(ghost) && /if \(false\) \{ showMode\('itemized'\)/.test(ghost),
        'a bogus trip id left the form half-filled or switched modes')

      const cleared = await parse(await req('/laoka/api/pantry/trip/clear', { method: 'POST' }))
      check('clearing the prices ends the trip without touching a count',
        cleared?.ok === true && !cleared.trip &&
          (cleared.toBuy || []).some((i) => i.id === buy.id && i.tripPrice === null),
        `trip=${JSON.stringify(cleared?.trip)} — an emptied trip is still in progress`)
      check('and the emptied trip is not left behind as a ghost',
        /dropEmptyPantryTrip\(ctx\.env, trip\.id\)/.test(pantryRoute) &&
          /await dropEmptyPantryTrip\(env, trip\.id\)/.test(queries),
        'a route that empties a trip (the clear button, or clearing one line) leaves the row, so the screen keeps an Ar 0 shopping somebody walked away from')
    } finally {
      await req('/laoka/api/pantry/trip/clear', { method: 'POST' })
    }
  }

  // (d2) The same rule by hand: REMOVING AN ITEM takes its price, and the trip
  // that price opened, with it. A line joins `items` on `deleted_at IS NULL`, so
  // one left behind draws nowhere and is still counted by `dropEmptyPantryTrip` —
  // a trip that can never be dropped. A throwaway item is created for this (and
  // soft-deleted at the end) rather than touching the household's real shelves;
  // each run leaves one soft-deleted probe row in the LOCAL laoka DB, invisible
  // everywhere, exactly like the category probe in (b). Skipped out loud when a
  // trip is already in progress, for the same reason the trip walk is.
  const quiet = await parse(await req('/laoka/api/pantry'))
  const probeSub = (() => {
    for (const g of pantryTree) for (const s of g.subgroups || []) if (s) return s
    return null
  })()
  if (!quiet || !probeSub) {
    log('  \x1b[90m– skipped the removal walk: no pantry category to file a probe item under\x1b[0m')
  } else if (quiet.trip) {
    log('  \x1b[90m– skipped the removal walk: a pantry trip is already in progress\x1b[0m')
  } else {
    let probeItem = 0
    try {
      const made = await parse(await req('/laoka/api/pantry/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Counted down, so the probe is on the to-buy list and can be priced.
        body: JSON.stringify({ name: 'zz smoke pantry probe', subgroupId: probeSub.id, stock: 0, stockMin: 2 }),
      }))
      probeItem = (() => {
        for (const g of made?.pantry || []) for (const s of g.subgroups || []) for (const i of s.items || []) {
          if (i.name === 'zz smoke pantry probe') return i.id
        }
        return 0
      })()
      check('the suite could add a throwaway pantry item to remove', !!probeItem,
        `POST /laoka/api/pantry/items did not answer with the new item (ok=${made && made.ok})`)
      if (probeItem) {
        const pricedProbe = await parse(await jpatch('/laoka/api/pantry/trip', { itemId: probeItem, price: 500, qty: 1 }))
        check('and price it, so there is a trip to strand',
          !!pricedProbe?.trip && pricedProbe.trip.total === 500,
          `trip=${JSON.stringify(pricedProbe?.trip && { id: pricedProbe.trip.id, total: pricedProbe.trip.total })}`)
        const gone = await parse(await req(`/laoka/api/pantry/items/${probeItem}/delete`, { method: 'POST' }))
        const stillInTree = (() => {
          for (const g of gone?.pantry || []) for (const s of g.subgroups || []) for (const i of s.items || []) {
            if (i.id === probeItem) return true
          }
          return false
        })()
        check('removing the item takes its price, and the trip it opened, with it',
          gone?.ok === true && gone.trip === null && !stillInTree,
          `trip=${JSON.stringify(gone?.trip)} — a line nobody can see still keeps the trip alive, so it can never be dropped`)
        probeItem = 0
      }
    } catch (e) {
      bad('the removal walk ran to completion', `threw: ${e && e.message}`)
    } finally {
      if (probeItem) await req(`/laoka/api/pantry/items/${probeItem}/delete`, { method: 'POST' })
      await req('/laoka/api/pantry/trip/clear', { method: 'POST' })
    }
  }

  // The identity of a purchase: a pushed trip keeps the expense it became. That
  // record is what the Pantry screen shows as "last trip", and what the Sompitra
  // save ADOPTS instead of inserting a second one.
  //
  // The ITEMIZED re-save is deliberately not exercised here: pushing clears a
  // trip's prices on purpose, so a second submit could only rewrite the notes of
  // an expense whose lines no longer exist -- the destructive direction the shared
  // rule forbids. The QUICK save in (d3) IS exercised, because that is the door
  // that used to ignore the identity altogether. What a re-submit DOES is the same
  // adoption Laoka's half proves for real in section 13, through the same helper;
  // what is pinned here is that the record that adoption reads exists, and that
  // both doors go through one rule.
  check('a pushed trip keeps the expense it became',
    !live || !live.lastTrip || (!!live.lastTrip.transactionId && live.lastTrip.amount !== null),
    'the last pushed trip does not remember its expense, so nothing could adopt it')
  // Scoped to the adoption BRANCH, not the file: `FROM pantry_trips WHERE id = ?`
  // also appears in the read-only hand-off that builds the form, so a file-wide
  // match stayed green after the POST's own lookup was replaced with a different
  // query — a guard that answered about a different statement (found by running
  // the mutation, which is the only way that kind of looseness shows up).
  const pantryAdopt = (() => {
    const at = budgetCode.indexOf('if (pantryTrip && !adopted')
    return at === -1 ? '' : budgetCode.slice(at, at + 700)
  })()
  check('the pantry save adopts that expense instead of inserting a second',
    /FROM pantry_trips WHERE id = \?/.test(pantryAdopt) &&
      /refreshPantryExpense\(c\.env, pantryTrip, adopted/.test(budgetCode) &&
      /markPantryTripPushed\(c\.env, pantryTrip, id/.test(budgetCode),
    'the pantry door no longer looks the trip up, so saving it twice would charge the budget twice')
  // Scoped to the two refresh helpers on purpose: the household EDITING an
  // expense may change its date (that is the point of the edit form), but a
  // re-send may not. Reading the whole file would make this vacuous.
  const refreshPantry = fnBody(budgetCode, 'refreshPantryExpense') || ''
  const refreshLaoka = fnBody(budgetCode, 'refreshLaokaExpense') || ''
  check('and both doors correct amount + notes only, never the household\'s choices',
    /SET amount = \?, notes = \?/.test(refreshPantry) && /SET amount = \?, notes = \?/.test(refreshLaoka) &&
      !/SET date/.test(refreshPantry) && !/SET date/.test(refreshLaoka),
    'a re-save can overwrite a date, category or description the household chose')
  // A form the BROWSER submits arrives with CRLF in every multiline field, so the
  // stored notes must be one shape whichever door sent them.
  check('itemized notes are stored with one shape, whatever the browser sends',
    /replace\(\/\\r\\n\?\/g, '\\n'\)/.test(budgetCode),
    'the POST no longer normalises CRLF, so the same list is stored differently by hand and by Laoka')

  // (d3) The identity of a hand-off survives a QUICK save — the one half a file
  // guard cannot prove, because the fault is only visible in what the budget ends
  // up holding. A Quick save carries one typed number instead of the lines, and
  // every identity branch used to be conditioned on the ITEMIZED pane: a Quick
  // save left the shopping looking unsent, so the module offered it again and the
  // next tap charged the household twice for one shop. So this walk saves for real
  // and reads the budget back. It is self-cleaning except for the pantry_trips row
  // itself — a pushed trip is HISTORY (that is what "last trip" shows) and no door
  // exists to forget one. The probes are throwaway items, soft-deleted at the end,
  // and there are TWO of them on purpose: the count assertions below are only
  // meaningful when "items bought" (2) and "units bought" (3) are different
  // numbers, and when neither is 0.
  const preSave = await parse(await req('/laoka/api/pantry'))
  if (!preSave || !probeSub) {
    log('  \x1b[90m– skipped the quick-save walk: no pantry category to file a probe item under\x1b[0m')
  } else if (preSave.trip) {
    log('  \x1b[90m– skipped the quick-save walk: a pantry trip is already in progress\x1b[0m')
  } else {
    let probeItems = []
    const desc = `zz smoke quick hand-off ${Date.now()}`
    const addProbe = async (name) => {
      const made = await parse(await req('/laoka/api/pantry/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, subgroupId: probeSub.id, stock: 0, stockMin: 2 }),
      }))
      for (const g of made?.pantry || []) for (const s of g.subgroups || []) for (const i of s.items || []) {
        if (i.name === name) return i.id
      }
      return 0
    }
    try {
      const one = await addProbe('zz smoke quick probe')
      const two = await addProbe('zz smoke quick probe two')
      probeItems = [one, two].filter(Boolean)
      const priced = one
        ? await parse(await jpatch('/laoka/api/pantry/trip', { itemId: one, price: 100, qty: 2 }))
        : null
      const pricedTwo = two
        ? await parse(await jpatch('/laoka/api/pantry/trip', { itemId: two, price: 50, qty: 1 }))
        : null
      const tripId = pricedTwo?.trip?.id || priced?.trip?.id || 0
      // TWO items, THREE units, Ar 250 — and the pair of checks below asks the
      // budget for a count of 2. Only the number of ITEMS BOUGHT can answer 2:
      // counted per unit it would be 3, and counted from the notes (which a Quick
      // save does not send) it would be 0, so the figure a re-save lands on tells
      // all three apart. A one-item probe cannot tell them apart — it was the
      // reason this walk read green while the guard behind it proved nothing.
      check('the suite could price a throwaway trip to save',
        probeItems.length === 2 && !!tripId && pricedTwo.trip.total === 250,
        `items=${JSON.stringify(probeItems)}, trip=${JSON.stringify(pricedTwo?.trip)}`)
      if (tripId) {
        // QUICK: one number, no itemized lines at all — what a household does when
        // the list is long and they trust the total the row showed them.
        const save = (amount, extra) => req('/budget/add-expense', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form(Object.assign({
            mode: 'quick', date: new Date().toISOString().slice(0, 10),
            amount: String(amount), description: desc, pantry_trip: String(tripId),
          }, extra || {})),
        })
        // The form the household meets leaves the category EMPTY on purpose (the
        // hand-off exists so they pick one), and a field the browser does not send
        // at all -- a hand-off posted without the select -- must still save: an
        // absent field read as the string "undefined" reaches the insert as a
        // category id and answers 500 instead of saving the expense.
        const cat = ((await body(await req('/budget/add-expense')))
          .match(/name="category_id"[\s\S]{0,900}?<option value="([^"]+)"/) || [])[1] || ''
        const first = await save(200)
        const afterFirst = await parse(await req('/laoka/api/pantry'))
        check('a Quick save of a hand-off form is still that shopping',
          first.status === 302 && !!afterFirst?.lastTrip && !!afterFirst.lastTrip.transactionId &&
            afterFirst.lastTrip.amount === 200 && afterFirst.lastTrip.count === 2 && !afterFirst.trip,
          `status ${first.status}, trip=${JSON.stringify(afterFirst?.lastTrip)} — the save left the shopping looking unsent (so its own screen offers it again and the next tap charges the budget twice), or recorded a count of ${afterFirst?.lastTrip?.count} for a two-item, three-unit shop`)
        check('and a hand-off saved without a category picked still saves',
          first.status === 302,
          `status ${first.status} — a hand-off posted without the category field answers 500 instead of saving, and the household's typed total is lost`)
        const again = await save(250, { category_id: cat })
        const afterAgain = await parse(await req('/laoka/api/pantry'))
        check('and saving it again corrects that ONE expense, never a second one',
          again.status === 302 && !!afterAgain?.lastTrip &&
            afterAgain.lastTrip.transactionId === afterFirst?.lastTrip?.transactionId &&
            afterAgain.lastTrip.amount === 250 && afterAgain.lastTrip.count === 2,
          `status ${again.status}, before=${JSON.stringify(afterFirst?.lastTrip)}, after=${JSON.stringify(afterAgain?.lastTrip)} — a second save inserted a new expense, or erased how many items were bought`)
        // …and what the household would actually see: the shopping listed once.
        const budgetPage = await body(await req('/budget'))
        const shown = (budgetPage.match(new RegExp(desc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
        check('and the budget lists that shopping exactly once',
          shown === 1,
          `the budget lists it ${shown} times — a hand-off saved twice must correct the expense, not add one`)
        // The probe's own expense goes, the way any other probe's does.
        const at = budgetPage.indexOf(desc)
        const tx = at === -1 ? null : budgetPage.slice(at).match(/action="\/budget\/delete\/([^"]+)"/)?.[1]
        if (tx) await req(`/budget/delete/${encodeURIComponent(tx)}`, { method: 'POST' })
        const settled = await body(await req('/budget'))
        check('the probe expense is cleaned up',
          !settled.includes(desc),
          'the pantry save probe is still in the budget')
      }
    } catch (e) {
      bad('the quick-save walk ran to completion', `threw: ${e && e.message}`)
    } finally {
      for (const id of probeItems) await req(`/laoka/api/pantry/items/${id}/delete`, { method: 'POST' })
      await req('/laoka/api/pantry/trip/clear', { method: 'POST' })
    }
  }

  // (e) Laoka's own doors, unchanged by the split: the reviewed save on the
  // pre-filled form, and the one-press refresh, both from a week's numbers.
  const fromLaoka = await body(await req('/budget/add-expense?from_laoka=999999'))
  check('a week that does not exist gives an ordinary empty form',
    !/Laoka shopping list/.test(fromLaoka) && !/name="laoka_week"/.test(fromLaoka),
    'a bogus week id left the form half-filled')
  check('the reviewed save still carries the week it came from',
    /name="laoka_week" value=/.test(budgetCode),
    'the hidden week field is gone, so saving a reviewed week would create a second expense')
  check('the one-press refresh still goes through the shared recorder',
    /recordLaokaImport\(c\.env, weekId, id, amount, lines\.length, categoryId\)/.test(budgetCode) &&
      /refreshLaokaExpense\(c\.env, weekId, existing\.transaction_id/.test(budgetCode),
    'one of the two Laoka doors was rewired, so a week can be recorded two different ways')

  // (f) The arithmetic itself: the money that reaches the budget has to be the
  // PRODUCT of the two numbers the household typed, in every place that computes
  // it. Three surfaces can do that sum (the API's total, the Sompitra hand-off,
  // and the line preview on the screen), so each one is pinned.
  const lineQtyMigration = src('migrations-laoka/0011_pantry_line_qty.sql')
  check('the trip line stores a quantity of its own, defaulted to one',
    /ALTER TABLE pantry_lines ADD COLUMN qty/.test(lineQtyMigration) && /DEFAULT 1/.test(lineQtyMigration),
    'pantry_lines has no qty column, so a unit price cannot be multiplied by anything')
  // The CALL, not just the constant: `MAX_QTY` being declared proves nothing if
  // the quantity stops going through a bounded reader with it (found by mutating
  // the call site, which left the declaration behind and the guard green).
  check('the API refuses an absurd quantity as well as an absurd price',
    /readWhole\(body\.qty, MAX_QTY, false\)/.test(pantryRoute) && /const MAX_QTY = \d+/.test(pantryRoute),
    'the trip route validates a price but not a quantity — one slipped keystroke can multiply the trip by 100000')
  check('the trip total is the sum of the LINE totals',
    /l\.total/.test(pantryRoute),
    'the payload sums unit prices, so a quantity of three would still be charged once')
  check('the Sompitra hand-off multiplies the unit price by the quantity',
    /unit \* qty/.test(budgetCode),
    'the pantry expense would carry the price of ONE however many were bought')
  check('the screen shows the restock price it will send',
    /function buyQty\(item\)/.test(laokaJs) && /moneyAmount\(unit \* q\)/.test(laokaJs) &&
      /\{ itemId: item\.id, price: unit, qty: q \}/.test(laokaJs),
    'the to-buy row no longer shows (or no longer sends) the quantity and the unit price together')

  // (g) The screens. Laoka runs inside an IFRAME, so a hand-off that navigated
  // the frame would draw Sompitra's form inside Laoka -- headless, no way back.
  check('the Pantry tab is in the app\'s nav, wired to the pantry API',
    /\['pantry', '[^']+', 'Pantry'\]/.test(laokaJs) && laokaJs.includes("'/api/pantry/items/' + item.id"),
    'app.js no longer draws the Pantry tab or PATCHes a count')
  check('the pantry hand-off leaves the iframe instead of drawing inside it',
    /window\.top\.location\.href = '\/budget\/add-expense\?from_pantry='/.test(laokaJs),
    'openPantryExpense navigates the frame, so the expense form opens inside Laoka with no header and no nav')
  check('the week\'s list no longer offers pantry items at all',
    !/pantryToggle/.test(laokaJs) && !/showPantry/.test(laokaJs),
    'the week\'s list still has a pantry toggle — the two lists are one list again')

  // (h) Three ways the same money could go wrong on a real phone, all of them
  // found by using the screen rather than reading it.
  //
  //   1. A price commits on BLUR, so its reply always lands while the household
  //      is already in the NEXT box. Rebuilding the list there destroyed that box
  //      and dropped focus to <body> — the half-typed number went with it, and a
  //      partial "123" could even be committed by the involuntary blur. Watched
  //      happen on the dev server with 1.2 s of latency. A price write therefore
  //      paints the money, and every other write waits while a box has focus.
  const writeFn = fnBody(laokaJs, 'pantryWrite') || ''
  check('a price reply repaints the money, never the box being typed in',
    /opts\.money && swapPantryFoot\(\)/.test(writeFn) && /isTyping\(\)/.test(writeFn) &&
      /function swapPantryFoot\(\)/.test(laokaJs) && /\{ money: true \}/.test(laokaJs),
    'a price reply rebuilds the list, so it destroys the box the household is already typing in and the half-typed number is lost')
  check('and the money it repaints is the state the server just answered with',
    /state\.bootstrap\.pantryToBuy \|\| \[\]/.test(fnBody(laokaJs, 'swapPantryFoot') || '') &&
      /state\.bootstrap\.pantryTrip/.test(fnBody(laokaJs, 'pantryFoot') || ''),
    'the repaint draws a captured copy of the list instead of the live state, so the total would lag one reply behind')
  //   2. Money here is whole Ariary and every READER of a line asks `price > 0`,
  //      so a stored 0 is a line that draws nowhere and that no empty-trip check
  //      can count: an "Ar 0" trip whose hand-off button opens an empty form.
  check('a price of zero is an emptied box, not a free item',
    /Number\(fields\.price\)\s*===\s*0/.test(queries) && /if \(unit === 0\) unit = null;/.test(laokaJs),
    'a zero price is stored as a line every reader skips — the screen offers a hand-off of Ar 0, and the trip can never be emptied')
  //   3. Removing an ITEM takes its line, exactly as removing a category does.
  const delItemFn = fnBody(queries, 'deletePantryItem') || ''
  const itemDeleteRoute = (() => {
    const at = pantryRoute.indexOf("pattern: '/api/pantry/items/:id/delete'")
    return at === -1 ? '' : pantryRoute.slice(at, at + 900)
  })()
  check('removing a pantry item takes its price, and the trip it emptied, with it',
    delItemFn.indexOf('DELETE FROM pantry_lines') > -1 &&
      delItemFn.indexOf('DELETE FROM pantry_lines') < delItemFn.indexOf('SET deleted_at') &&
      /dropEmptyPantryTrip\(ctx\.env, trip\.id\)/.test(itemDeleteRoute),
    'a line on a removed item joins nothing but is still counted, so the trip it was priced on can never be dropped')
  // Belt and braces, and the healing path for any database that already holds
  // such a row: “empty” means empty OF THE LINES THAT DRAW, which is the same
  // list the screen, the trip payload and the hand-off are built from.
  check('a trip only counts the lines it can actually draw',
    /JOIN items i ON i\.id = p\.item_id/.test(fnBody(queries, 'dropEmptyPantryTrip') || ''),
    'dropEmptyPantryTrip counts raw rows, so a line whose item is gone keeps a trip alive that nothing on the screen can empty')
  check('and takes its undrawable rows with it when it goes',
    /DELETE FROM pantry_lines WHERE trip_id = \?1/.test(fnBody(queries, 'dropEmptyPantryTrip') || ''),
    'a dropped trip leaves its stale line rows behind, and every later lookup joins pantry_lines by item_id alone — so an item with no trip would still report a price')
  check('the week\'s empty-list note no longer promises pantry items',
    !/plus every Pantry item/.test(laokaJs),
    'the note on an unplanned week still says the list is the plan plus every pantry item, which the split made false')

  //   4. A fraction is not money. The trip multiplies price × qty exactly while
  //      the Sompitra hand-off truncates each line to whole Ariary, so a stored
  //      fraction is the same shopping at two totals. The screen's boxes take
  //      digits; this is the same rule at the door, because the API is a door too.
  check('the API stores a price and a quantity whole, like the boxes do',
    /readWhole\(body\.price, MAX_PRICE, true\)/.test(pantryRoute) &&
      /readWhole\(body\.qty, MAX_QTY, false\)/.test(pantryRoute) &&
      /value: Math\.trunc\(r\.value\)/.test(fnBody(pantryRoute, 'readWhole') || ''),
    'a fractional price is stored, so the total on the trip and the total that reaches the budget disagree by the fraction')

  //   5. A price commits on BLUR, so the tap that follows it — ✖ Clear, or the
  //      🛒 Review & save button — can reach the server FIRST. A clear that lands
  //      first is overtaken by the price it meant to remove ("clear" that leaves
  //      the money on screen, watched happen), and a hand-off that lands first
  //      sends the shopping a reply behind the one the household is looking at.
  check('the clear waits for a price that is still in flight',
    /function pantryPriceWriteWaiting\(\)/.test(laokaJs) &&
      /pantryPriceWrite = pantryWrite\('PATCH', '\/api\/pantry\/trip'/.test(laokaJs) &&
      /await pantryPriceWriteWaiting\(\);\s*await pantryWrite\('POST', '\/api\/pantry\/trip\/clear'/.test(laokaJs),
    'the clear can be overtaken by a price typed a moment earlier, so ✖ Clear leaves the money on the screen')
  check('and the hand-off waits for it too, so it sends the shopping that was priced',
    /await pantryPriceWriteWaiting\(\)/.test(fnBody(laokaJs, 'openPantryExpense') || ''),
    'the hand-off navigates while a price is still in flight, so the budget gets the total from one reply ago')

  //   6. The identity of a hand-off is honoured in BOTH modes. Conditioning it on
  //      the itemized pane is what let a Quick save leave the week or trip looking
  //      unsent — its own screen offered the same shopping again and the second
  //      save charged the budget twice. (Section (d3) saves for real and reads the
  //      budget back; this is the code rule behind it.)
  // Slice on CODE, not on a comment: `src()` strips comments before anything
  // reads it, so a `// ─── GET …` marker is not there to find (this guard was red
  // on a correct tree until it stopped looking for one).
  const postExpense = (() => {
    const at = budgetCode.indexOf("budget.post('/add-expense'")
    const until = budgetCode.indexOf("budget.get('/add-income'")
    return at === -1 || until === -1 ? '' : budgetCode.slice(at, until)
  })()
  check('the hand-off identity is honoured in both modes, not only the itemized pane',
    postExpense.length > 0 &&
      /if \(laokaWeek\) \{/.test(postExpense) &&
      /if \(pantryTrip && !adopted\) \{/.test(postExpense) &&
      /markPantryTripPushed\(c\.env, pantryTrip, id/.test(postExpense) &&
      !/&& mode === 'itemized'/.test(postExpense),
    'a Quick save of a hand-off form leaves the shopping looking unsent, so it is offered again and a second tap charges the budget twice')
  check('and a Quick save records how many items the SHOPPING had',
    /async function sourceItemCount\(/.test(budgetCode) &&
      /item_count FROM pantry_trips WHERE id = \?/.test(fnBody(budgetCode, 'sourceItemCount') || ''),
    'a Quick save counts the lines of a free-text note (usually none) instead of the shopping bought, and a re-save then erases the count the trip already had')

  // (i) ONE item, edited on its own. The Pantry is the only screen that manages
  //     its items — the meal Catalog is scoped to `is_pantry = 0` and never lists
  //     them — and its sheet was counts-only. So an item's NAME and the category
  //     holding it were permanent: a typo could only be undone by removing the
  //     item, and a staple filed on the wrong shelf could only be moved by
  //     removing it, taking its count, its price and the trip line that price
  //     opened with it. Both are editable ON THE ITEM now, which is what the four
  //     checks below pin: the row's buttons act on the item (never on the category
  //     heading above it), and an edit writes only what it was given.
  const itemEditRoute = (() => {
    const at = pantryRoute.indexOf("pattern: '/api/pantry/items/:id'")
    const until = pantryRoute.indexOf("pattern: '/api/pantry/items/:id/delete'")
    return at === -1 || until <= at ? '' : pantryRoute.slice(at, until)
  })()
  check('a pantry item can be renamed, and filed under another pantry category',
    /if \(body\.name !== undefined\)/.test(itemEditRoute) && /fields\.name = name/.test(itemEditRoute) &&
      /isPantryCategory\(ctx\.env, subgroupId\)/.test(itemEditRoute),
    'the item route cannot rename an item or re-file it, so a typo or a staple on the wrong shelf can only be undone by removing the item — its count, its price and its trip line with it')
  const updItemFn = fnBody(queries, 'updatePantryItem') || ''
  check('an edit writes only the fields it was given, so a rename cannot wipe a count',
    /if \(fields\.name !== undefined\)/.test(updItemFn) && /if \(fields\.subgroupId !== undefined\)/.test(updItemFn) &&
      /if \(fields\.stock !== undefined\)/.test(updItemFn) && /if \(fields\.stockMin !== undefined\)/.test(updItemFn) &&
      /UPDATE items SET ' \+ sets\.join\(', '\)/.test(updItemFn),
    'the update writes fields nobody sent, so renaming an item erases the count somebody just took')
  const itemSheetFn = fnBody(laokaJs, 'editPantryItem') || ''
  check('the item sheet carries the name and the category, not counts only',
    /name: 'name'/.test(itemSheetFn) && /required: true/.test(itemSheetFn) &&
      /name: 'subgroupId'/.test(itemSheetFn) && /name: 'stockMin'/.test(itemSheetFn),
    'the sheet is counts-only again — a name or a shelf can only be changed by removing the item')
  const pantryRowFn = fnBody(laokaJs, 'pantryRow') || ''
  check('each pantry row edits and removes its OWN item, never the category',
    /editPantryItem\(item\)/.test(pantryRowFn) && /removePantryItem\(item\)/.test(pantryRowFn) &&
      !/PantryCategory/.test(pantryRowFn),
    'the row\'s buttons act on the category again — removing one item takes the whole shelf with it')

  // (i2) …and by asking, on a throwaway item in a throwaway shelf, both
  // soft-deleted at the end like every other probe in this section. The refusals
  // aim at a MEAL item and a MEAL category, where the only way to tell "refused"
  // from "quietly moved" is to look at it afterwards.
  const mealShelfId = (() => {
    for (const g of lboot?.catalog || []) for (const s of g.subgroups || []) if (s) return s.id
    return 0
  })()
  const pantryGroupId = (pantryTree[0] && pantryTree[0].id) || 0
  const firstShelf = (() => {
    for (const g of pantryTree) for (const s of g.subgroups || []) if (s) return s
    return null
  })()
  if (!quiet || !pantryGroupId || !firstShelf || !mealItemId || !mealShelfId) {
    log('  \x1b[90m– skipped the item-edit walk: no pantry shelf (or no meal item) to aim a probe at\x1b[0m')
  } else {
    let shelfProbe = 0
    let itemProbe = 0
    // The names carry the run's own stamp: a name is unique while it lives
    // (`WHERE deleted_at IS NULL`), so a stable one would be fine — until a run
    // dies before its cleanup and the NEXT run is refused with "already exists",
    // which is a suite that fails depending on what a previous crash left behind.
    const stamp = Date.now()
    const probeShelfName = `zz smoke pantry shelf ${stamp}`
    const probeItemName = `zz smoke edit probe ${stamp}`
    try {
      const madeShelf = await parse(await req('/laoka/api/subgroups', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: probeShelfName, groupId: pantryGroupId, slotRole: 'none' }),
      }))
      shelfProbe = (madeShelf && madeShelf.id) || 0
      check('the suite could add a throwaway pantry shelf to file an item onto',
        !!shelfProbe, `POST /laoka/api/subgroups answered ${JSON.stringify(madeShelf)}`)
      const madeItem = await parse(await req('/laoka/api/pantry/items', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: probeItemName, subgroupId: firstShelf.id, stock: 7, stockMin: 3 }),
      }))
      itemProbe = (() => {
        for (const g of madeItem?.pantry || []) for (const s of g.subgroups || []) for (const i of s.items || []) {
          if (i.name === probeItemName) return i.id
        }
        return 0
      })()
      check('and add a throwaway item to rename and move',
        !!itemProbe, `POST /laoka/api/pantry/items did not answer with the new item (ok=${madeItem && madeItem.ok})`)
      if (itemProbe && shelfProbe) {
        // A rename carries NO count: an edit is partial by construction.
        const renamed = await parse(await jpatch(`/laoka/api/pantry/items/${itemProbe}`, { name: probeItemName + ' II' }))
        check('renaming an item leaves its count and its level alone',
          renamed?.item?.name === probeItemName + ' II' && renamed.item.stock === 7 && renamed.item.stockMin === 3,
          `item=${JSON.stringify(renamed?.item)} — an edit that carries fields nobody sent is how a rename erases a count`)
        // …and a move is a move: it is drawn under the shelf it was sent to.
        const moved = await parse(await jpatch(`/laoka/api/pantry/items/${itemProbe}`, { subgroupId: shelfProbe }))
        const filedUnder = (() => {
          for (const g of moved?.pantry || []) for (const s of g.subgroups || []) for (const i of s.items || []) {
            if (i.id === itemProbe) return s.id
          }
          return 0
        })()
        check('moving an item files it under the shelf it was sent to, count intact',
          moved?.ok === true && filedUnder === shelfProbe && moved.item?.subgroupId === shelfProbe &&
            moved.item?.stock === 7,
          `drawn under ${filedUnder} (asked for ${shelfProbe}), item=${JSON.stringify(moved?.item)}`)
        // The refusals. The domain boundary has to hold on the NEW fields too,
        // not only on the count that was already guarded.
        const atMeal = await jpatch(`/laoka/api/pantry/items/${mealItemId}`, { name: 'hijacked' })
        check('renaming a MEAL ingredient through the pantry is refused',
          atMeal.status === 404, `status ${atMeal.status} for meal item ${mealItemId}`)
        const toMeal = await jpatch(`/laoka/api/pantry/items/${itemProbe}`, { subgroupId: mealShelfId })
        check('and a pantry item cannot be filed under a MEAL group',
          toMeal.status === 400,
          `status ${toMeal.status} for meal category ${mealShelfId} — an item there vanishes from every pantry list and appears to the meal planner as an ingredient`)
        const nameless = await jpatch(`/laoka/api/pantry/items/${itemProbe}`, { name: '   ' })
        check('an item cannot be renamed to nothing',
          nameless.status === 400, `status ${nameless.status} for a blank name`)
        const nothing = await jpatch(`/laoka/api/pantry/items/${itemProbe}`, {})
        check('and an edit that changes nothing is refused rather than written',
          nothing.status === 400, `status ${nothing.status} for an empty body`)
      }
    } catch (e) {
      bad('the item-edit walk ran to completion', `threw: ${e && e.message}`)
    } finally {
      // The CATALOGUE's door, not the pantry's: a mutation above can file the
      // probe under a meal category, and the pantry route then refuses it (by
      // design — that boundary is the point of the checks above), so the cleanup
      // has to be the door that deletes an item in either domain.
      if (itemProbe) await req(`/laoka/api/items/${itemProbe}`, { method: 'DELETE' })
      if (shelfProbe) await req(`/laoka/api/pantry/categories/${shelfProbe}/delete`, { method: 'POST' })
    }
  }

  // (j) The shape of the shelves, on the page the household lands on. Home's
  // dashboard ends on one compact card, and its numbers have to BE the pantry's
  // own: a summary that counts differently from the list it summarises is a lie
  // nobody notices until the two disagree. So they are compared against
  // `/laoka/api/pantry` — the payload the Pantry screen itself draws from.
  const shape = await parse(await req('/laoka/api/pantry'))
  const shelvesPage = await body(await req('/'))
  const shapeCounted = (() => {
    let items = 0
    let categories = 0
    for (const g of shape?.pantry || []) for (const s of g.subgroups || []) { categories++; items += (s.items || []).length }
    return { items: items, categories: categories, toBuy: (shape?.toBuy || []).length }
  })()
  const cardAt = shelvesPage.indexOf('>Pantry</h3>')
  const pantryCard = cardAt === -1 ? '' : shelvesPage.slice(cardAt, cardAt + 2000)
  check('Home\'s dashboard ends on a pantry card that opens the pantry itself',
    cardAt > -1 && /href="\/laoka\/\?tab=pantry"/.test(pantryCard) &&
      shelvesPage.indexOf('/laoka/?tab=pantry') > shelvesPage.indexOf('Debts &amp; Credits'),
    cardAt === -1 ? 'the dashboard has no pantry card at all'
      : 'the pantry card is not the last card, or it does not carry the tab that opens the pantry')
  check('and its numbers are the pantry screen\'s own, not a second count',
    shapeCounted.items > 0 &&
      new RegExp(`>${shapeCounted.items} items?<`).test(pantryCard) &&
      new RegExp(`>${shapeCounted.categories} categor(y|ies)<`).test(pantryCard) &&
      (shapeCounted.toBuy > 0
        ? new RegExp(`>${shapeCounted.toBuy} to buy<`).test(pantryCard)
        : />nothing to buy</.test(pantryCard)),
    `the card reads ${(pantryCard.match(/>\d+ items?</) || ['nothing'])[0]} where the pantry has ${shapeCounted.items} item(s) in ${shapeCounted.categories} categor(ies) and ${shapeCounted.toBuy} to buy — a summary that counts differently is a summary nobody can trust`)
}

// ─── 23. A quantity or a price is TYPED, never nudged ────────────
log('\n23. Every number box in the app is typed, never nudged')
{
  // A number box changes its value in two ways nobody asked for: the browser's
  // own spinner buttons, and the wheel — which a FOCUSED box turns into a step
  // instead of a scroll. On Laoka's to-buy list that second one is destructive,
  // not annoying: those boxes commit on blur, so scrolling a long list with the
  // pointer over a row restocks it at whatever price sat under the cursor. One
  // file removes both for every document Home serves, and this section pins it:
  // the rule's two halves, its two limits (scroll kept, typing untouched), and
  // the fact that EVERY document actually loads it.
  const src = (p) => {
    try {
      return readFileSync(new URL('../' + p, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    } catch (e) { return '' }
  }
  const entryRes = await req('/shared/number-entry.js')
  const entry = await body(entryRes)
  check('the app-wide entry rule is served as a public asset',
    entryRes.status === 200 && entry.length > 1200 && /input\[type="number"\]/.test(entry),
    'GET /shared/number-entry.js did not answer with the rule, so no document can load it')

  // (a) The spinner buttons, in every engine that draws one. `-moz-appearance`
  // is Firefox; the two pseudo-elements are Blink/WebKit (Chrome, Brave, Safari,
  // Edge, Samsung) — a rule that covers only one leaves the other with buttons.
  check('the browser\'s own up/down buttons are removed, in both engines',
    /-moz-appearance:\s*textfield/.test(entry) &&
      /::-webkit-outer-spin-button/.test(entry) &&
      /::-webkit-inner-spin-button/.test(entry) &&
      /-webkit-appearance:\s*none/.test(entry),
    'the spinner CSS is incomplete, so one browser still draws arrows that step a price')

  // (b) The two halves of the wheel rule: the step is cancelled, and the SCROLL
  // is performed by hand instead. Cancelling the event alone would protect the
  // box by freezing the page — the exact bug Laoka already shipped once, when
  // `overflow-x: hidden` on the root killed wheel scrolling outright.
  check('a wheel over a number box cannot step it, and the page still scrolls',
    /addEventListener\('wheel'/.test(entry) && /ev\.preventDefault\(\)/.test(entry) &&
      /scrollerFor\(box\)/.test(entry) && /window\.scrollBy\(dx, dy\)/.test(entry),
    'the wheel handler either steps the box or swallows the scroll — one of the two halves is gone')
  check('a box that is not focused is left completely alone',
    /document\.activeElement !== box/.test(entry),
    'the guard sits on every box under the pointer, so flinging the list past an untouched row would no longer scroll')

  // (c) Arrow keys are the last nudge left once the buttons are gone, and the
  // rule must not eat anything else: Enter is how Laoka commits a price, and
  // Tab/Backspace are ordinary typing.
  check('Up/Down are cancelled too, and no other key is',
    /'ArrowUp'/.test(entry) && /'ArrowDown'/.test(entry) &&
      !/'Tab'/.test(entry) && !/'Enter'/.test(entry) && !/'Backspace'/.test(entry) &&
      /ev\.ctrlKey \|\| ev\.metaKey \|\| ev\.altKey/.test(entry),
    'the key handler either leaves the arrows stepping the value, or eats a key the app needs (Enter commits a price, Tab moves on)')
  check('the rule never rewrites a value — only the nudges are gone',
    !/\.value\s*=/.test(entry),
    'the shared rule assigns to .value, so it can change a number the household typed')

  // (d) The include itself, in the DOCUMENT the browser actually receives: a
  // rule nobody loads is decoration, and a page added later without it is a box
  // that silently goes back to nudging. Sompitra's pages and the module shells
  // get it from their heads (views/layout.tsx, views/shell.tsx) — checked at the
  // source, since the served markup is the same tag — and the four standalone
  // documents are checked as SERVED, which also proves the path resolves.
  const shellDocs = [
    ['the Sompitra page head', 'src/views/layout.tsx'],
    ['the module shell head', 'src/views/shell.tsx'],
  ]
  for (const [label, path] of shellDocs) {
    check(`${label} loads the entry rule`,
      /<script src="\/shared\/number-entry\.js"/.test(src(path)),
      `${path} no longer includes /shared/number-entry.js`)
  }
  const servedDocs = [
    ['the Sompitra pages', '/budget'],
    ['the WAY module shell', '/way/'],
    ['the Laoka module shell', '/laoka/'],
    ['WAY', '/way/index.html'],
    ['Laoka', '/laoka/index.html'],
    ['Chat', '/chat/index.html'],
    ['the public live share', '/live/'],
  ]
  for (const [label, path] of servedDocs) {
    const html = await body(await req(path))
    // The TAG, not the string: every one of these documents also NAMES the file
    // in a comment explaining why it loads it, so a check that grep'd the path
    // stayed green with the <script> deleted (found by exactly that mutation).
    check(`${label} load the entry rule`,
      /<script src="\/shared\/number-entry\.js"/.test(html),
      `${path} does not load /shared/number-entry.js, so its number boxes come back with spinner buttons and wheel stepping`)
  }

  // (e) What a typed decimal MEANS, once the box takes digits. "1250.75" is
  //     1,250 Ariary — the household is typing cents — and a rule that merely
  //     dropped the non-digits made it 125,075: a silent hundred-fold price, on
  //     the one screen whose whole job is money (seen live on the dev server).
  //     Thousands separators are the other way round ("1,250" IS 1,250), so only
  //     the fraction is cut. Every money box asks the same helper, which is why
  //     one `split` (and exactly ONE strip) is what this reads.
  const appJsAll = src('public/laoka/app.js')
  check('a typed decimal is cut at the point, never merged into a bigger price',
    /function wholeDigits\(/.test(appJsAll) &&
      /split\('\.'\)\[0\]/.test(fnBody(appJsAll, 'wholeDigits') || '') &&
      (appJsAll.match(/wholeDigits\(/g) || []).length >= 5 &&
      (appJsAll.match(/replace\(\/\[\^0-9\]\/g/g) || []).length === 1,
    'a decimal point is stripped instead of cut, so a typed 1250.75 is stored as 125075 — and a fifth money box with its own copy of the rule can disagree again')
}

// ─── 24. no request data lives in module scope ───────────────────
log('\n24. one isolate, many requests: module scope is not storage')
{
  // The bug class: a binding declared at MODULE scope that a request WRITES.
  // One Worker isolate serves concurrent requests and interleaves them at every
  // `await`, so such a binding is shared state between unrelated people.
  // `src/identity.ts` carried a `let lastPassword` exactly like that: set at
  // login, read across several D1 round-trips, cleared in a `finally` — each
  // request individually correct, and two overlapping logins could hash one
  // person's password into the other's freshly created row. In W.A.Y that hash
  // also IS the μlogger Basic-Auth credential (rule 5).
  //
  // It needs OVERLAP to fail, so it has no symptom to notice, no error to read
  // and no line in any log. That is why this is a source check.
  //
  // (a) is the tree. (b) and (c) are the reason (a) can be believed: a scan
  // whose input silently empties — wrong folder, unresolvable typescript, or a
  // set of kind NAMES compared against kind NUMBERS — reports a green tree
  // forever. A guard that cannot fail is decoration, so the analyzer has to be
  // seen noticing a fault it is not currently looking at, and NOT flagging the
  // read-only module constants that are all over this codebase.
  const src = (p) => {
    try {
      return readFileSync(new URL('../' + p, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    } catch (e) { return '' }
  }
  const faults = scanModuleState({ root: 'src' })
  check('no module-scope binding in src/ is written from inside a function',
    faults.length === 0,
    `shared between concurrent requests: ${formatFindings(faults).join('; ')}`)

  const control = scanModuleState({
    extraSources: [{
      path: 'synthetic/control.ts',
      text: [
        'const CACHE = new Map<string, string>();',
        'let counter = 0;',
        'export function writes(): number { counter = counter + 1; CACHE.set("k", "v"); return counter; }',
      ].join('\n'),
    }],
  })
  check('the scan notices a reassigned `let` and a mutated Map it is not currently looking at',
    control.some((f) => f.name === 'counter') && control.some((f) => f.name === 'CACHE'),
    'the analyzer found neither shape, so a clean result from it means nothing')

  const honest = scanModuleState({
    extraSources: [{
      path: 'synthetic/honest.ts',
      text: [
        'export const CONFIG = { retries: 3 };',
        'export const LIST = [1, 2, 3];',
        'export function reads(): number { return CONFIG.retries + LIST.length; }',
      ].join('\n'),
    }],
  })
  check('read-only module constants are not reported',
    honest.length === 0,
    `the analyzer flags a constant that is only read: ${formatFindings(honest).join('; ')}`)

  // (d) The instance itself, pinned in the code. A parameter cannot be shared
  // between two requests; module scope can. `password` is REQUIRED and carries
  // NO default, so a later caller cannot land on the never-create path by
  // saying nothing — which would leave a person without module accounts, the
  // outcome the parameter exists to make visible.
  const identity = src('src/identity.ts')
  // Only the PARAMETER is pinned here — whether it carries a default is the
  // next check's question, so the two can be falsified one at a time.
  check('the provisioning password arrives as a parameter',
    /export async function ensureModuleAccounts\(env: Env, user: HomeUser, password: string \| null/.test(identity),
    'ensureModuleAccounts no longer takes the password as an explicit parameter')
  check('…with no default, so a caller cannot skip credentials by silence',
    !/password: string \| null =/.test(identity),
    'the password parameter has a default, so a new caller silently lands on the never-create path')
  check('both provisioning call sites state the password explicitly',
    /ensureModuleAccounts\(env, user, password \?\? null\)/.test(identity) &&
      /ensureModuleAccounts\(c\.env, res\.user, password\)/.test(src('src/routes/admin.tsx')),
    'a call site no longer passes the password, so its accounts would be created without credentials')
  check('the module-level password field itself is gone',
    !identity.includes('lastPassword'),
    'a module-level password field is back in src/identity.ts')
}

// ─── 25. no request data parked on a DO's `this` ─────────────────
log('\n25. a Durable Object field is not per-request scratch space')
{
  // Same family as §24, one level down. A Durable Object is single-threaded,
  // which is exactly the trap: it guarantees no two INSTRUCTIONS overlap and
  // says nothing about two REQUESTS, which interleave at every `await`. So
  // `this.currentDevice = body.deviceId` … `await` … `use(this.currentDevice)`
  // hands request A's device to request B, while looking like ordinary object
  // state.
  //
  // Unlike §24 the answer is not "no state on `this`": a geofence cache, a
  // cooldown map and the daily push ledger all belong on the object and would
  // be pointless anywhere else. So every field must be DECLARED — with its kind
  // and the reason it is object state — and the writes must match the
  // declaration. That is what makes this a decision rather than a convention.
  //
  // Scope comes from wrangler.jsonc's durable_objects bindings and not from
  // `extends DurableObject`: Laoka's `Lobby` is a plain class and a DO all the
  // same, and the bindings are the list Cloudflare actually instantiates.
  const readRepo = (p) => { try { return readFileSync(new URL('../' + p, import.meta.url), 'utf8') } catch (e) { return '' } }
  const rawConfig = readRepo('wrangler.jsonc')
  let configured = []
  try {
    configured = (JSON.parse(stripJsonc(rawConfig)).durable_objects?.bindings ?? [])
      .map((b) => b.class_name).filter(Boolean)
  } catch (e) { configured = [] }

  const { classes, faults: doFaults } = scanDoState({ root: 'src' })
  const withCode = (...codes) => doFaults.filter((f) => codes.includes(f.code))

  const configFault = withCode('config-unreadable')
  check('every Durable Object named in wrangler.jsonc is analyzed',
    configFault.length === 0 &&
      configured.length > 0 &&
      classes.length === configured.length &&
      configured.every((n) => classes.some((c) => c.name === n)),
    configFault.length
      ? formatDoFaults(configFault).join('; ')
      : `wrangler.jsonc names ${configured.join(', ') || '(none — the config did not parse)'} but this section analyzed ${classes.map((c) => c.name).join(', ') || '(nothing)'}: a Durable Object it cannot see is a Durable Object nobody is checking`)

  check('no Durable Object instance field is undeclared',
    withCode('undeclared').length === 0,
    formatDoFaults(withCode('undeclared')).join('; '))

  // The rule this section exists for: request data parked on the object and
  // read after an interleaving point, or read by a later request entirely.
  check('no DO field carries request data across an interleaving point',
    withCode('read-after-await', 'cross-request').length === 0,
    formatDoFaults(withCode('read-after-await', 'cross-request')).join('; '))

  check('every DO field is written only the way its declared kind allows',
    withCode('wrong-write').length === 0,
    formatDoFaults(withCode('wrong-write')).join('; '))

  // The one field written from request data on purpose. Its exemption is what
  // the reader list buys: `notifyEvent` may write it (that is the record), and
  // only the debug payload may read it. A NEW reader means the value has
  // started deciding something, and then it is request state like any other.
  check('the diagnostics slot still decides nothing (its readers are declared)',
    withCode('undeclared-reader').length === 0 &&
      (DO_STATE_POLICY['FleetDO.lastNotify']?.readOnlyIn ?? []).length > 0,
    formatDoFaults(withCode('undeclared-reader')).join('; ') ||
      'FleetDO.lastNotify lost its declared reader list, so nothing pins "it decides nothing"')

  check('every registry entry states a reason, not just a kind',
    Object.entries(DO_STATE_POLICY).every(([, v]) => (v.why || '').length >= 20),
    `entries whose reason is missing or a placeholder: ${Object.entries(DO_STATE_POLICY).filter(([, v]) => (v.why || '').length < 20).map(([k]) => k).join(', ')}`)

  // ── the controls ──
  // Without these the section is a scan that has only ever been pointed at a
  // clean tree, which cannot show that it would notice anything. The two that
  // matter are the interleaving fault (must be SEEN) and honest object state
  // (must be LEFT ALONE — a guard that cries wolf gets turned off).
  const probe = scanDoState({
    wranglerClasses: ['Probe'],
    extraSources: [{
      path: 'synthetic/interleave.ts',
      text: [
        'export class Probe {',
        '  private slot: string | null = null',
        '  constructor(private env: any) { this.slot = null }',
        '  async handle(body: { id: string }) {',
        '    this.slot = body.id',
        '    await this.env.DB.prepare("SELECT 1").first()',
        '    return this.slot',
        '  }',
        '}',
      ].join('\n'),
    }],
  })
  check('the scan notices request data parked on `this` and read past an await',
    probe.faults.some((f) => f.code === 'read-after-await'),
    `the analyzer found no interleaving fault in a class that has one: ${formatDoFaults(probe.faults).join('; ') || '(no findings at all)'}`)

  const honest = scanDoState({
    wranglerClasses: ['Probe'],
    policy: {
      'Probe.env': { kind: 'handle', why: 'the bindings, set in the constructor' },
      'Probe.ctx': { kind: 'handle', why: 'the object context, set in the constructor' },
      'Probe.cache': { kind: 'db-cache', why: 'rows refilled from the database' },
      'Probe.cooldowns': { kind: 'keyed', why: 'per-key rate-limit stamps' },
    },
    extraSources: [{
      path: 'synthetic/honest.ts',
      text: [
        'export class Probe {',
        '  private cache: any[] | null = null',
        '  private cooldowns = new Map<string, number>()',
        '  constructor(env: any, ctx: any) { this.env = env; this.ctx = ctx }',
        '  async warm() {',
        '    const { results } = await this.env.DB.prepare("SELECT 1").all()',
        '    this.cache = results',
        '  }',
        '  note(key: string) { this.cooldowns.set(key, Date.now()) }',
        '}',
      ].join('\n'),
    }],
  })
  check('…and leaves a constructor handle, a database cache and a keyed map alone',
    honest.faults.length === 0,
    `the analyzer flagged honest object state: ${formatDoFaults(honest.faults).join('; ')}`)

  // The shape the undeclared rule is most likely to miss, and DID: a field that
  // exists ONLY by assignment. Every plain-JavaScript Durable Object is this
  // shape (Laoka's `Lobby` sets `this.env` / `this.ctx` and declares nothing),
  // and the check is only as complete as the field set is when it runs — so
  // collecting assignments afterwards listed the field as `(undeclared)` in the
  // inventory while raising no fault at all. Both readers below take the FAULT
  // list, so the audit printed "every field is declared" and exited 0 on a class
  // it had just called undeclared, and this section agreed. Asserted here from
  // the scan rather than from the inventory so the two cannot disagree again.
  const assignedOnly = scanDoState({
    wranglerClasses: ['Probe'],
    policy: {
      'Probe.env': { kind: 'handle', why: 'the bindings, set in the constructor' },
    },
    extraSources: [{
      path: 'synthetic/assigned-only.js',
      text: [
        'export class Probe {',
        '  constructor(env) { this.env = env }',
        '  note(body) { this.recent = body.id }',
        '}',
      ].join('\n'),
    }],
  })
  check('a field that exists only by assignment is reported as undeclared',
    assignedOnly.faults.filter((f) => f.code === 'undeclared').map((f) => f.field).sort().join(',') === 'recent',
    `a class whose fields are assigned in plain JS reported ${formatDoFaults(assignedOnly.faults).join('; ') || '(no findings at all)'} — ` +
      'listing a field as undeclared in the inventory is not enough: the fault list is what the audit CLI and this section both read')

  // The DO list is read out of a JSONC file whose comments a naive `//` strip
  // would eat along with a `https://` value — and a floor of that failure is a
  // config that does not parse, which would leave this whole section checking
  // nothing. So the reader is pinned on a value it must not damage.
  let urlIntact = false
  try { urlIntact = String(JSON.parse(stripJsonc(rawConfig)).vars?.NTFY_URL || '').startsWith('https://') } catch (e) { urlIntact = false }
  check('the jsonc reader keeps a URL value intact',
    urlIntact,
    'wrangler.jsonc no longer parses with its https:// values whole, so the Durable Object list above could be silently empty')
}

// ─── 26. one design language, from the front door to the last card
log('\n26. one design language: the tokens, the labels, and the front door')
{
  // The design pass this section guards made three claims that nothing else can
  // check, because all three are invisible from outside and obvious to a person:
  //
  //   • The app has ONE set of surfaces — paper / sheet / a hairline — and one
  //     type scale to go with them. Every panel is `.card` now. Before, every
  //     box on every page carried its own white or gray-800 plus rounded-2xl
  //     plus shadow-sm plus border-gray-100, so a ledger row, a stat tile and a
  //     page section all had identical weight — and the caption grey (gray-400,
  //     2.5:1 on white) is what made 10px text unreadable.
  //   • No label is all-caps micro-type any more: the loudest "generated
  //     dashboard" tell in the app, and one no functional test can see.
  //   • The sign-in screen is the app's front door — the same typeface, the same
  //     tokens, the same theme switch, and the small mark. It used to ship the
  //     982KB logo-1024.png for an 80px avatar, and it was the ONE document that
  //     loaded the brand font without ever applying it, so "Home" rendered in
  //     the system face on a page no other screen's colours appear on.
  //
  // Contrast is measured, not asserted: the floors below are what the token
  // values have to MEET, so a future palette edit that quietly drops a caption
  // back under the line fails here instead of in someone's eyes.
  const home = await body(await req('/'))
  const login = await body(await req('/login'))

  const cssOf = (html) => (html.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n')
  const hex = (chunk, name) => ((chunk.match(new RegExp('--' + name + ':[\\s]*(#[0-9a-fA-F]{6})')) || [])[1] || '')
  const homeCss = cssOf(home)
  // The light palette ends where the one dark block begins: the tokens carry a
  // single theme signal, the `html.dark` class (see the note in
  // views/app-chrome.tsx, and the check that keeps it single, below).
  const darkAt = homeCss.indexOf('html.dark {')
  const lightEnd = darkAt > 0 ? darkAt : homeCss.length
  const lightCss = homeCss.slice(0, lightEnd)
  const darkCss = darkAt > 0 ? homeCss.slice(darkAt) : ''

  // WCAG relative luminance / contrast ratio, straight from the token values.
  const chan = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) }
  const lum = (h) => {
    const n = parseInt(h.replace('#', ''), 16)
    return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255)
  }
  const contrast = (a, b) => { const s = [lum(a), lum(b)].sort((x, y) => y - x); return (s[0] + 0.05) / (s[1] + 0.05) }

  check('the surfaces come from one token set, defined for both themes',
    ['paper', 'sheet', 'rule', 'ink', 'ink-2', 'ink-3'].every((t) => hex(lightCss, t) && hex(darkCss, t)),
    'a surface token is missing from :root or from html.dark, so a page would fall back to a grey of its own')

  // ONE theme signal, and it is the class. Probed in the browser: this page's
  // Tailwind build emits its `dark:` utilities as `.dark\:x:is(.dark *)`, so
  // they follow the CLASS and not the OS (the opposite was believed here for a
  // while, and a second token copy was added to match it). A second copy driven
  // by prefers-color-scheme is therefore not belt-and-braces, it is a split:
  // with an explicit "light" choice stored on a dark-OS phone the tokens went
  // dark while `bg-gray-100` stayed light, and the text on such a box — whose
  // colour comes from the inherited --ink — rendered invisible (/settings, both
  // action links to Account). So the copy is now forbidden, not required.
  check('the dark palette answers the class only — no second, OS-driven copy',
    darkAt > 0 &&
      !/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{/.test(homeCss) &&
      ['paper', 'sheet', 'ink-3'].every((t) => hex(darkCss, t)),
    'the tokens and the dark: utilities are following different signals again (a prefers-color-scheme :root copy is present, or html.dark has lost its values), so part of the screen inverts with the switch')

  // ...and the class those tokens wait for has to be set by every document that
  // carries the stylesheet, or a dark-OS phone is stuck in the light palette.
  const wayDoc = await body(await req('/way/'))
  const themedDocs = [['/', home], ['/login', login], ['/way/', wayDoc]]
  const unseeded = themedDocs.filter(([, h]) => !/classList\.add\('dark'\)/.test(h))
  check('every document that carries the tokens also sets the class they wait for',
    unseeded.filter(([, h]) => /html\.dark/.test(h)).length === 0 && unseeded.length === 0,
    'a document ships the dark palette without the bootstrap that sets html.dark: ' + unseeded.map(([p]) => p).join(', '))

  const floors = [
    ['light labels', hex(lightCss, 'ink-2'), hex(lightCss, 'sheet'), 6],
    ['light captions', hex(lightCss, 'ink-3'), hex(lightCss, 'sheet'), 4.5],
    ['dark labels', hex(darkCss, 'ink-2'), hex(darkCss, 'sheet'), 6],
    ['dark captions', hex(darkCss, 'ink-3'), hex(darkCss, 'sheet'), 4.5],
  ]
  const under = floors.filter(([, fg, bg, min]) => !(fg && bg) || contrast(fg, bg) < min)
  check('every label and caption clears its contrast floor, in both themes',
    under.length === 0,
    under.map(([n, fg, bg, min]) => `${n}: ${fg || '?'} on ${bg || '?'} is ${fg && bg ? contrast(fg, bg).toFixed(2) : '?'}:1, floor ${min}`).join('; '))

  // ── one label treatment, and nothing in caps ──
  // Comments are stripped first: a comment may TALK about the old treatment,
  // and a check that reads prose reports on prose.
  const bare = (html) => html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '')
  const CAPS = /uppercase|text-transform:\s*uppercase/
  const capped = []
  for (const p of ['/', '/budget', '/settings', '/kine', '/debts', '/sales', '/chat', '/way/', '/laoka/']) {
    const html = p === '/' ? home : await body(await req(p))
    if (CAPS.test(bare(html))) capped.push(p)
  }
  check('no screen sets a label in all-caps micro-type',
    capped.length === 0,
    `${capped.join(', ')} still carries an uppercase label — the card titles and the money labels are sentence case everywhere else`)

  // Both halves of that check have to be able to fail: the pattern it forbids,
  // and the contrast maths it uses for the tokens above.
  check('…and the label and contrast checks catch what they replaced',
    CAPS.test('<p class="text-[10px] font-semibold uppercase tracking-[.07em]">Income</p>') &&
      contrast('#9ca3af', '#ffffff') < 4.5,
    'the caps pattern or the contrast helper cannot fail, which would make the checks above decorative')

  // ── the front door ──
  check('/login loads the one brand typeface',
    /fonts\.googleapis\.com\/css2\?family=Plus\+Jakarta\+Sans/.test(login),
    'the sign-in screen requests no brand font')
  check('/login renders in the brand face, on the app\'s own paper',
    /body\s*\{[^}]*font-family:\s*'Plus Jakarta Sans'/.test(login) &&
      /body\s*\{[^}]*background:\s*var\(--paper\)/.test(login),
    'the front door loads the font and the tokens without applying them — it renders in the system face on a grey of its own')
  check('…and the old sign-in head would fail that',
    !/body\s*\{[^}]*font-family:\s*'Plus Jakarta Sans'/.test('<body class="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800">'),
    'the expression matches anything, so the check above cannot fail')
  check('/login ships the small mark, not the 1MB logo',
    /\/icons\/icon-192\.png/.test(login) && !/logo-1024\.png/.test(login),
    'the first screen of the app is loading logo-1024.png (982KB) again')
  check('/login names every room behind it',
    ['Sompitra', 'WAY', 'Laoka', 'Chat'].every((m) => login.includes(m)),
    'the door no longer says what is behind it')
  check('no sign-in message is an emoji',
    !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(login),
    'an emoji is back in a sign-in message: a colour picture the OS picks, and no help with what to do next')

  // ── one anchor per screen ──
  // Counted in the MARKUP: the stylesheet also contains `.t-anchor` and
  // `.card-lg`, so a whole-document grep counts the design system instead of
  // the page that uses it (which is how this check first failed).
  const markup = home.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
  const anchors = (markup.match(/t-anchor/g) || []).length
  const panels = (markup.match(/card-lg/g) || []).length
  check('the home page leads with exactly one anchor and a ruled ledger',
    anchors === 1 && panels === 1 && /class="ledger"/.test(markup),
    `t-anchor x${anchors}, card-lg x${panels} — the home page has drifted from one anchor figure plus a ledger, ` +
      'so nothing on it is ranked any more')

  // ── the Kiné summary compares its figures, it does not list them ──
  // "Nine sessions, four paid for, five owed" is read ACROSS the three facts,
  // and so is this week's session count against this week's francs. Down a
  // column that comparison becomes arithmetic the reader has to do; the two
  // shapes have both shipped here (three pastel boxes, then a ruled list of the
  // same three facts), so the shape is held by a check now.
  // Scoped to the WEEK strip (the two tiles a household with no clients still
  // has): counted page-wide, a check like this would stay green on the
  // per-client tiles alone while the week above them had gone back to a list.
  const kineCard = markup.slice(markup.indexOf('Kiné Summary'), markup.indexOf('Cash Flow'))
  const weekAt = kineCard.indexOf('grid grid-cols-2 gap-2')
  const clientsAt = kineCard.indexOf('grid grid-cols-3 gap-2')
  const weekStrip = weekAt === -1 ? '' : kineCard.slice(weekAt, clientsAt > weekAt ? clientsAt : weekAt + 900)
  const weekTiles = (weekStrip.match(/class="tile/g) || []).length
  check('the Kiné summary sets the week as two tiles side by side in its card',
    weekTiles === 2,
    `${weekTiles} tile(s) in the Kiné week strip — what the week earned and what it delivered are back ` +
      'to a column of text, so the one tells you nothing about the other at a glance')

  // A tile is a SURFACE, so it comes from the token set like every other one:
  // `.tile` is the table's paper with a rule round it, and the COLOUR is spent on
  // the figure inside — the shape this summary already had as a ruled list.
  // A tile that painted itself (`bg-white`, `shadow-sm`, a pastel of its own) is
  // the drift this catches; a tile that ALSO tinted its surface from the figure
  // is the subtler version of it, a second colour table standing beside the
  // palette, so that is named here too.
  check('a tile is a token surface, and the colour stays on the figure',
    /\.tile\s*\{[^}]*background:\s*var\(--paper\)/.test(homeCss) &&
      !/\.tile-tint\b/.test(homeCss) &&
      // …and on the page, the week's money keeps the green it has always had.
      kineCard.includes('class="tile text-green-600 dark:text-green-400"'),
    'tiles paint their own surface (or wear a tint of their own), or the week\'s money has lost its green — ' +
      'either way the palette no longer decides what a figure means, and the dark theme no longer reaches it')

  // The per-client half, read from the component itself: three tiles, and the
  // palette spent on ONE of them — the balance, the fact that decides something.
  // (The live page cannot carry this check: a household with no active clients
  // renders none of them.)
  let layoutSrc = ''
  try { layoutSrc = readFileSync(new URL('../src/views/layout.tsx', import.meta.url), 'utf8') } catch (e) {}
  const statsAt = layoutSrc.indexOf('export const KineClientStats')
  const statsBody = statsAt === -1 ? '' : layoutSrc.slice(statsAt, layoutSrc.indexOf('export const Btn', statsAt))
  const clientTiles = (statsBody.match(/class="tile|class=[^"]*tile/g) || []).length
  const plainTiles = (statsBody.match(/<div class="tile">/g) || []).length
  check("one client's three facts are three tiles, and only the balance carries colour",
    clientTiles === 3 && plainTiles === 2 && /grid grid-cols-3 gap-2/.test(statsBody) &&
      statsBody.includes('class={`tile ${dueCls}`}'),
    `KineClientStats draws ${clientTiles} tile(s), ${plainTiles} of them plain — a client's sessions, ` +
      'money and balance are no longer side by side, or the palette has moved off the balance')
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
