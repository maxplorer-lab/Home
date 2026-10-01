/**
 * The export window — `nairobiDayRange()` inside the inline script of the page
 * this Worker serves (`public/way/index.html`) — under `node --test`.
 *
 * Mirror of `../W.A.Y/tests/export-window.test.mjs`; keep the two in step. Only
 * the file path differs: W.A.Y's page is `dashboard/index.html`, Home's is the
 * one Wrangler actually serves.
 *
 * The export window bug (W-A3) comes back if nairobiDayRange drifts again.
 *
 * The CSV/KML exporters take `start`/`end` from the dashboard, and the
 * dashboard builds them here — in the inline script, not in src/ — because
 * the day boundary is local midnight (UTC+3), not UTC midnight. W-A3 was
 * exactly this line: the URL used `...T00:00:00Z` / `...T23:59:59Z`, so
 * "Sep 30" exported 03:00 Sep 30 -> 03:00 Oct 1 local, disagreeing with the
 * correctly-bounded Trips view. Nothing imports this function, so the test
 * extracts it from the shipped file and runs it, the same way
 * scripts/check-dashboard.mjs inspects W.A.Y's inline script.
 *
 * No dev server, no database, no mocks — unlike `npm run smoke`.
 * Run: `npm test`. `npm run verify` = check + test + smoke.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const FILE = 'public/way/index.html'
const html = readFileSync(new URL(`../${FILE}`, import.meta.url), 'utf8')

/** Pull a top-level `function name(...) { ... }` out of the inline script. */
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name}() not found in ${FILE} -- did it move?`)
  const open = html.indexOf('{', start)
  let depth = 0
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1
    else if (html[i] === '}') {
      depth -= 1
      if (depth === 0) return html.slice(start, i + 1)
    }
  }
  assert.fail(`unbalanced braces after ${name}() in ${FILE}`)
}

/** Run `fn` with the process timezone set, restoring the previous value. */
function withTz(tz, fn) {
  const prev = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

const nairobiDayRange = new Function(
  `${extractFunction('nairobiDayRange')}\nreturn nairobiDayRange;`
)()

test('a Nairobi day runs 00:00:00+03:00 to 23:59:59+03:00', () => {
  assert.deepEqual(nairobiDayRange('2026-10-01'), {
    start: '2026-09-30T21:00:00.000Z',
    end: '2026-10-01T20:59:59.000Z',
  })
})

test('the window is not the old UTC midnight-to-midnight day (W-A3)', () => {
  const range = nairobiDayRange('2026-10-01')
  assert.notEqual(range.start, '2026-10-01T00:00:00.000Z')
  assert.equal(Date.parse(range.end) - Date.parse(range.start), 24 * 60 * 60 * 1000 - 1000)
})

test('consecutive days tile without a gap', () => {
  const day = nairobiDayRange('2026-10-01')
  const next = nairobiDayRange('2026-10-02')
  assert.equal(Date.parse(next.start) - Date.parse(day.end), 1000)
})

test('the month boundary lands on the last local day of the previous month', () => {
  assert.deepEqual(nairobiDayRange('2026-01-01'), {
    start: '2025-12-31T21:00:00.000Z',
    end: '2026-01-01T20:59:59.000Z',
  })
})

test('the window ignores the host timezone', () => {
  const seen = ['UTC', 'Africa/Nairobi', 'America/New_York'].map((tz) =>
    withTz(tz, () => nairobiDayRange('2026-10-01'))
  )
  assert.deepEqual(seen[1], seen[0])
  assert.deepEqual(seen[2], seen[0])
})
