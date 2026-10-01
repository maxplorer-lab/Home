/**
 * Local-day helpers — `src/lib/utils.ts` under `node --test`.
 *
 * Home is the deployable Worker, so this is the copy of these helpers that runs
 * in production. The household calendar is UTC+3 (Africa/Nairobi, no DST) while
 * Workers always run with `TZ=UTC`, so every date the app derives from "now"
 * must come from `localDate()` / `addDays()` rather than `toISOString()` or
 * `getFullYear()`. These tests pin the local-midnight and week/month boundaries
 * and re-run every case under three process timezones to prove the helpers
 * ignore the host TZ.
 *
 * No dev server, no database, no mocks — unlike `npm run smoke`.
 * Run: `npm test`. `npm run verify` = check + test + smoke.
 *
 * Mirror of `../Sompitra/tests/local-day.test.mjs`; keep the two in step.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TZ_OFFSET_MS,
  TZ_SQL_MODIFIER,
  localDate,
  addDays,
  currentWeekBounds,
  currentMonthBounds,
} from '../src/lib/utils.ts'

const TZS = ['UTC', 'Africa/Nairobi', 'America/New_York']

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

/** Run `fn` with `new Date()` (and `Date.now()`) pinned to an instant. */
function withClock(instant, fn) {
  const RealDate = Date
  const fixed = RealDate.parse(instant)
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed)
      else super(...args)
    }
    static now() {
      return fixed
    }
  }
  globalThis.Date = FakeDate
  try {
    return fn()
  } finally {
    globalThis.Date = RealDate
  }
}

/** Pin the clock AND the process timezone for one assertion body. */
const at = (instant, tz, fn) => withTz(tz, () => withClock(instant, fn))

// ─── Offset constants ────────────────────────────────────────
test('TZ_OFFSET_MS is the household UTC+3 offset', () => {
  assert.equal(TZ_OFFSET_MS, 3 * 60 * 60 * 1000)
})

test('TZ_SQL_MODIFIER is the SQLite modifier for that offset', () => {
  assert.equal(TZ_SQL_MODIFIER, '+3 hours')
})

test('TZ_SQL_MODIFIER shift matches localDate()', () => {
  // The dashboard binds this modifier to `date(t.created_at, ?)`; the same
  // instant must land on the same local day here.
  const instant = new Date('2026-09-30T22:00:00Z')
  assert.equal(localDate(instant), '2026-10-01')
  const shifted = new Date(instant.getTime() + TZ_OFFSET_MS)
  assert.equal(shifted.toISOString().slice(0, 10), '2026-10-01')
})

// ─── localDate ───────────────────────────────────────────────
const LOCAL_DATE_CASES = [
  { label: 'one second before local midnight', instant: '2026-09-30T20:59:59Z', expected: '2026-09-30' },
  { label: 'local midnight', instant: '2026-09-30T21:00:00Z', expected: '2026-10-01' },
  { label: '00:30 local (S-A1 repro)', instant: '2026-09-30T21:30:00Z', expected: '2026-10-01' },
  { label: '02:59 local (S-A1 repro)', instant: '2026-09-30T23:59:00Z', expected: '2026-10-01' },
  { label: '03:00 local (S-A1 repro)', instant: '2026-10-01T00:00:00Z', expected: '2026-10-01' },
  { label: 'local new year', instant: '2026-12-31T22:00:00Z', expected: '2027-01-01' },
]

for (const tz of TZS) {
  test(`localDate() boundaries (TZ=${tz})`, () => {
    for (const c of LOCAL_DATE_CASES) {
      at(c.instant, tz, () => {
        assert.equal(localDate(), c.expected, `${c.label}: localDate()`)
        assert.equal(localDate(new Date(c.instant)), c.expected, `${c.label}: localDate(instant)`)
      })
    }
  })
}

test('localDate() ignores the host timezone for the same instant', () => {
  const instant = '2026-09-30T21:30:00Z'
  const seen = TZS.map(tz => withTz(tz, () => localDate(new Date(instant))))
  assert.deepEqual(seen, ['2026-10-01', '2026-10-01', '2026-10-01'])
})

test('localDate() is ahead of the raw UTC date before 03:00 local', () => {
  // This is the bug S-A1 fixed: `toISOString().slice(0, 10)` still said Sep 30.
  for (const offset of ['21:30:00', '23:59:00']) {
    const instant = `2026-09-30T${offset}Z`
    assert.equal(localDate(new Date(instant)), '2026-10-01', instant)
    assert.notEqual(localDate(new Date(instant)), instant.slice(0, 10))
  }
})

// ─── addDays ─────────────────────────────────────────────────
const ADD_DAYS_CASES = [
  ['2026-09-30', 1, '2026-10-01'],
  ['2026-10-01', -1, '2026-09-30'],
  ['2026-12-31', 1, '2027-01-01'],
  ['2027-01-01', -1, '2026-12-31'],
  ['2026-10-01', 0, '2026-10-01'],
  ['2028-02-28', 1, '2028-02-29'], // leap year
  ['2028-02-29', 1, '2028-03-01'],
  ['2027-02-28', 1, '2027-03-01'], // non-leap
  ['2026-10-01', 7, '2026-10-08'],
  ['2026-10-01', -7, '2026-09-24'],
  ['2026-01-31', 1, '2026-02-01'],
  ['2026-01-01', -1, '2025-12-31'],
]

test('addDays() is pure date arithmetic', () => {
  for (const [iso, days, expected] of ADD_DAYS_CASES) {
    assert.equal(addDays(iso, days), expected, `${iso} ${days >= 0 ? '+' : ''}${days}`)
  }
})

for (const tz of TZS) {
  test(`addDays() ignores the host timezone (TZ=${tz})`, () => {
    withTz(tz, () => {
      assert.equal(addDays('2026-10-31', 1), '2026-11-01')
      assert.equal(addDays('2026-03-01', -1), '2026-02-28')
    })
  })
}

test('addDays() always returns a YYYY-MM-DD string', () => {
  for (const [iso, days] of ADD_DAYS_CASES) {
    assert.match(addDays(iso, days), /^\d{4}-\d{2}-\d{2}$/)
  }
})

// ─── currentWeekBounds (SAT → FRI) ───────────────────────────
const WEEK_CASES = [
  // 2026-10-01 is a Thursday; the cycle runs Sat 2026-09-26 → Fri 2026-10-02.
  { label: 'Thu 00:30 local', instant: '2026-09-30T21:30:00Z', start: '2026-09-26', end: '2026-10-02' },
  { label: 'Thu 02:59 local', instant: '2026-09-30T23:59:00Z', start: '2026-09-26', end: '2026-10-02' },
  { label: 'Thu 03:00 local', instant: '2026-10-01T00:00:00Z', start: '2026-09-26', end: '2026-10-02' },
  { label: 'Fri 23:59 local — last minute of the week', instant: '2026-10-02T20:59:59Z', start: '2026-09-26', end: '2026-10-02' },
  { label: 'Sat 00:00 local — new week', instant: '2026-10-02T21:00:00Z', start: '2026-10-03', end: '2026-10-09' },
  { label: 'Sat 12:00 local', instant: '2026-10-03T09:00:00Z', start: '2026-10-03', end: '2026-10-09' },
  { label: 'Sun 00:00 local', instant: '2026-10-03T21:00:00Z', start: '2026-10-03', end: '2026-10-09' },
  { label: 'Mon 00:00 local', instant: '2026-10-04T21:00:00Z', start: '2026-10-03', end: '2026-10-09' },
]

for (const tz of TZS) {
  test(`currentWeekBounds() SAT→FRI cycle (TZ=${tz})`, () => {
    for (const c of WEEK_CASES) {
      at(c.instant, tz, () => {
        const { start, end } = currentWeekBounds()
        assert.equal(start, c.start, `${c.label}: start`)
        assert.equal(end, c.end, `${c.label}: end`)
        assert.equal(addDays(start, 6), end, `${c.label}: end is start + 6`)
        assert.equal(new Date(start + 'T00:00:00Z').getUTCDay(), 6, `${c.label}: start is a Saturday`)
        assert.equal(new Date(end + 'T00:00:00Z').getUTCDay(), 5, `${c.label}: end is a Friday`)
      })
    }
  })
}

test('currentWeekBounds() offsets move whole weeks', () => {
  const instant = '2026-10-01T00:00:00Z' // Thursday 03:00 local
  at(instant, 'UTC', () => {
    assert.deepEqual(currentWeekBounds(0), { start: '2026-09-26', end: '2026-10-02' })
    assert.deepEqual(currentWeekBounds(1), { start: '2026-10-03', end: '2026-10-09' })
    assert.deepEqual(currentWeekBounds(2), { start: '2026-10-10', end: '2026-10-16' })
    assert.deepEqual(currentWeekBounds(-1), { start: '2026-09-19', end: '2026-09-25' })
    assert.deepEqual(currentWeekBounds(-2), { start: '2026-09-12', end: '2026-09-18' })
  })
})

// ─── currentMonthBounds ──────────────────────────────────────
const MONTH_CASES = [
  { label: 'Sep 30 23:59 local', instant: '2026-09-30T20:59:59Z', start: '2026-09-01', end: '2026-09-30', label_text: 'September 2026' },
  { label: 'Oct 1 00:00 local', instant: '2026-09-30T21:00:00Z', start: '2026-10-01', end: '2026-10-31', label_text: 'October 2026' },
  { label: 'Dec 10 local', instant: '2026-12-10T09:00:00Z', start: '2026-12-01', end: '2026-12-31', label_text: 'December 2026' },
  { label: 'Feb 2028 (leap)', instant: '2028-02-10T09:00:00Z', start: '2028-02-01', end: '2028-02-29', label_text: 'February 2028' },
]

for (const tz of TZS) {
  test(`currentMonthBounds() calendar month (TZ=${tz})`, () => {
    for (const c of MONTH_CASES) {
      at(c.instant, tz, () => {
        const bounds = currentMonthBounds()
        assert.equal(bounds.start, c.start, `${c.label}: start`)
        assert.equal(bounds.end, c.end, `${c.label}: end`)
        assert.equal(bounds.label, c.label_text, `${c.label}: label`)
      })
    }
  })
}

test('currentMonthBounds() offsets and year rollover', () => {
  at('2026-10-01T00:00:00Z', 'UTC', () => {
    assert.deepEqual(currentMonthBounds(-1), { start: '2026-09-01', end: '2026-09-30', label: 'September 2026' })
    assert.deepEqual(currentMonthBounds(1), { start: '2026-11-01', end: '2026-11-30', label: 'November 2026' })
    assert.deepEqual(currentMonthBounds(3), { start: '2027-01-01', end: '2027-01-31', label: 'January 2027' })
    assert.deepEqual(currentMonthBounds(4), { start: '2027-02-01', end: '2027-02-28', label: 'February 2027' })
  })
  at('2027-12-20T09:00:00Z', 'UTC', () => {
    assert.deepEqual(currentMonthBounds(), { start: '2027-12-01', end: '2027-12-31', label: 'December 2027' })
    assert.deepEqual(currentMonthBounds(1), { start: '2028-01-01', end: '2028-01-31', label: 'January 2028' })
    assert.deepEqual(currentMonthBounds(2), { start: '2028-02-01', end: '2028-02-29', label: 'February 2028' })
  })
})
