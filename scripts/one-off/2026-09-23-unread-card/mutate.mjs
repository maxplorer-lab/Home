#!/usr/bin/env node
// ─── The Home page's unread card: proof that its guards can fail ──────
// Falsification driver for the checks `npm run smoke` grew on 2026-09-23, when
// the chat's unread cue was promoted from a dot to a card under the month's
// figure -- and then from ONE preview line to the unread lines themselves.
//
// Why these need one. Several of the checks are text-level claims about a
// SERVER-RENDERED document or about a source file, and most of them were green
// on the first run for a reason other than the thing they claim:
//
//   * the position check sliced the document at the first '<body' -- which is a
//     CSS COMMENT ("not as Tailwind utilities on <body>"), so the CSS index for
//     `rooms-card` came out BEFORE the figure it must follow;
//   * the same check would have passed with the card anywhere in the head,
//     because `.unread-card` is also a CSS rule there;
//   * the "painted as text" check turned RED on the script's own comment
//     ("Text goes in with textContent and never innerHTML"), i.e. it read prose;
//   * and the CSS check for the phone overflow is a rule that a later
//     re-styling deletes in one keystroke, with no test able to notice.
//
//   node scripts/one-off/2026-09-23-unread-card/mutate.mjs [M1 M2 …]
//
// Needs a RUNNING dev server (set BASE_URL, default http://127.0.0.1:8793):
// the checks read the served document, not the sources. One suite run per
// mutation, so allow ~3 minutes each. Leaves the tree byte-identical.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = new URL('../../../', import.meta.url)          // the repo root (Home/)
const rootPath = fileURLToPath(root)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const write = (p, s) => writeFileSync(new URL(p, root), s)
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex')
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Windows checkout: files are CRLF, anchors below are written with \n. Match a
// normalised copy, write back with the ending the file already had — a missed
// anchor is a SKIPPED mutation that changes nothing and still exits 0.
const normalized = (p) => read(p).replace(/\r\n/g, '\n')
function writeKeepingEol(p, text) {
  const crlf = read(p).includes('\r\n')
  write(p, crlf ? text.replace(/\n/g, '\r\n') : text)
}

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8793'

const CARD_RE = /\n        \{\/\* ── Unread chat — the second box, and second on purpose ──[\s\S]*?\n        <\/a>\n/


const mutations = [
  {
    id: 'M1',
    file: 'src/routes/dashboard.tsx',
    why: 'the card is moved BELOW the room doorways — the third box, not the second',
    guard: 'SECOND box',
    // Index-based, not a fixed anchor: '</Card>\n      </div>' appears wherever a
    // card ends a grid (Balances/Kiné do it too), so a plain string replace has
    // several candidates and the driver would silently pick the wrong one. Insert
    // after the FIRST </Card> that follows the rooms' opening tag instead.
    apply: (src) => {
      const m = src.match(CARD_RE)
      if (!m) return null
      const without = src.replace(CARD_RE, '\n')
      const roomsAt = without.indexOf('className="rooms-card')
      if (roomsAt < 0) return null
      const closeAt = without.indexOf('</Card>', roomsAt)
      if (closeAt < 0) return null
      const at = closeAt + '</Card>'.length
      return without.slice(0, at) + '\n' + m[0] + without.slice(at)
    },
  },
  {
    id: 'M2',
    file: 'src/views/app-chrome.tsx',
    why: 'a chat line is injected as markup instead of text',
    guard: 'never markup',
    from: "    text.textContent = (m && m.message) || '';",
    to: "    text.innerHTML = (m && m.message) || '';",
  },
  {
    id: 'M3',
    file: 'src/way/routes/dashboard-api.ts',
    why: "the caller's watermark is dropped, so the count stops answering \"since I looked\"",
    guard: 'narrows to what arrived after',
    from: '    const qs = since ? `?since=${encodeURIComponent(since)}` : ""',
    to: '    const qs = ""',
  },
  {
    id: 'M4',
    file: 'src/routes/dashboard.tsx',
    why: 'the card is rendered already-shown, so the server decides what is unread',
    guard: 'ships hidden',
    apply: (src) => {
      const re = /(class="unread-card )card( tab-tint)/
      return re.test(src) ? src.replace(re, '$1on card$2') : null
    },
  },
  {
    id: 'M5',
    file: 'src/way/do/FleetDO.ts',
    why: 'the readout answers with ONE line however many arrived — the bug this replaces',
    guard: 'one line per unread message',
    from: '          messages: lines.map((row) => ({',
    to: '          messages: lines.slice(0, 1).map((row) => ({',
  },
  {
    id: 'M6',
    file: 'src/way/do/FleetDO.ts',
    why: 'the lines come back oldest-first, so the card\'s "+N earlier" row would be a lie',
    guard: 'arrive newest first',
    from: '          messages: lines.map((row) => ({',
    to: '          messages: lines.slice().reverse().map((row) => ({',
  },
  {
    id: 'M7',
    file: 'src/way/do/FleetDO.ts',
    why: 'the clip is dropped, so one long message inflates every page\'s 25 s poll',
    guard: 'clipped before it leaves the DO',
    from: '            message: clipChatLine(row.message),',
    to: '            message: row.message,',
  },
  {
    id: 'M8',
    file: 'src/views/app-chrome.tsx',
    why: 'the grid item loses min-width: 0, so its nowrap rows widen the phone layout',
    guard: 'cannot widen its own grid track',
    from: '  .unread-card { display: none; min-width: 0; }',
    to: '  .unread-card { display: none; }',
  },
]

function settle() {
  sleepMs(1500)
  try { execSync(`curl -s -o /dev/null --max-time 20 ${BASE}/login`, { stdio: 'ignore', shell: true }) } catch {}
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

// A mutation lives on disk for the length of one suite run (~3 min), and that is
// long enough for a timeout or a Ctrl-C to land in the middle of it. The finally
// below handles a thrown error; these handle the process being asked to stop.
// Learned the hard way: a 10-minute tool timeout killed this driver mid-M3 and
// left `const qs = ""` in the route, which is a real, silent behaviour change.
let pending = null
const restoreNow = (code) => {
  if (pending) {
    writeKeepingEol(pending.file, pending.text)
    console.log(`\n${pending.file} restored (interrupted during ${pending.id})`)
    pending = null
  }
  process.exit(code)
}
process.on('SIGINT', () => restoreNow(130))
process.on('SIGTERM', () => restoreNow(143))

const wanted = process.argv.slice(2)
let survived = 0
for (const m of mutations) {
  if (wanted.length && !wanted.includes(m.id)) continue
  const original = normalized(m.file)
  const before = sha(m.file)
  let mutated
  if (m.apply) {
    mutated = m.apply(original)
    if (mutated === null || mutated === original) {
      console.log(`${m.id}  ANCHOR MISSING — no match in ${m.file} (${m.why})`)
      survived++
      continue
    }
  } else {
    if (!original.includes(m.from)) {
      console.log(`${m.id}  ANCHOR MISSING — ${m.from.slice(0, 60)}`)
      survived++
      continue
    }
    mutated = original.replace(m.from, m.to)
  }
  pending = { file: m.file, text: original, id: m.id }
  writeKeepingEol(m.file, mutated)
  settle()
  let out
  try {
    out = runSuite()
  } finally {
    writeKeepingEol(m.file, original)
    pending = null
  }
  const restored = sha(m.file) === before
  const red = new RegExp(`✗[^\\n]*${m.guard}`).test(out)
  console.log(`${m.id}  caught=${red ? 'YES' : 'NO '}  restored=${restored ? 'yes' : 'NO'}  (${m.why})`)
  if (!red || !restored) survived++
}

console.log(survived === 0
  ? '\nevery guard caught its own fault; tree restored'
  : `\n${survived} mutation(s) survived — a guard is decoration`)
process.exit(survived === 0 ? 0 : 1)
