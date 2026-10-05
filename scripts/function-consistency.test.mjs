/**
 * The function-consistency scan's own falsifiers — `scripts/lib/function-consistency.mjs`
 * under `node --test`.
 *
 * Why this file exists. `npm run audit:functions` is only worth a red check if it
 * can go red, and the checks it runs are all about what is ABSENT (a promise
 * nobody carried, a failure nobody wrote down) — the kind of rule that a broken
 * scanner satisfies perfectly by finding nothing. So every case below is a
 * fixture that MUST be reported, next to the near-identical fixture that must
 * NOT be: the guarded function, the call inside a `try`, the catch with a
 * comment, the `Promise.all(map(async …))` that is the correct form of the thing
 * the dropped `map` gets wrong. If a later change makes the scan quieter, the
 * first half of each pair goes red and says which fault it stopped seeing.
 *
 * The fixtures are handed to the scanner as `extraSources` (with `paths: []`),
 * so nothing touches disk and the scan cannot accidentally read the real tree.
 *
 * Run: `npm test`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { scanFunctions } from './lib/function-consistency.mjs'

const scan = (text, { path = 'fixture.js', policy = [] } = {}) =>
  scanFunctions({ paths: [], extraSources: [{ path, text }], policy })

const codes = (r) => r.faults.map((f) => f.code).sort()
const find = (r, code) => r.faults.filter((f) => f.code === code)

test('a bare call to an async function inside a function is a fault', () => {
  const r = scan(`
    async function save() { await api(); }
    function onClick() { save(); }
  `)
  assert.deepEqual(codes(r), ['floating-async'])
  assert.match(find(r, 'floating-async')[0].detail, /inside onClick\(\)/)
})

test('…but the same call inside a try is carried, so it is not', () => {
  const r = scan(`
    async function save() { await api(); }
    function onClick() { try { save(); } catch (e) { toast(e.message); } }
  `)
  assert.deepEqual(codes(r), [])
})

test('…and an async function that guards itself cannot reject, so it is not', () => {
  const r = scan(`
    async function save() { try { await api(); } catch (e) { toast(e.message); } }
    function onClick() { save(); }
  `)
  assert.deepEqual(codes(r), [])
})

test('a page-level rejection net carries the calls it covers — reported, not excused', () => {
  const withNet = scan(`
    async function save() { await api(); }
    function onClick() { save(); }
    window.addEventListener('unhandledrejection', function (ev) { toast(ev.reason.message, true); });
  `)
  assert.deepEqual(codes(withNet), [])
  assert.equal(withNet.covered.length, 1)
  assert.equal(withNet.covered[0].code, 'covered-by-net')
})

test('a net that only writes to the console is not a net', () => {
  const r = scan(`
    async function save() { await api(); }
    function onClick() { save(); }
    window.addEventListener('unhandledrejection', function (ev) { console.error(ev.reason); });
  `)
  assert.deepEqual(codes(r), ['floating-async'])
})

test('a top-level call is the app starting, not a dropped promise', () => {
  const r = scan(`
    async function boot() { await api(); }
    boot();
  `)
  assert.deepEqual(codes(r), [])
})

test('an empty catch around work that can fail is a fault', () => {
  const r = scan(`
    async function load() { try { await fetch('/x'); } catch (e) {} }
  `)
  assert.deepEqual(codes(r), ['empty-catch'])
})

test('…unless it says why it is silent', () => {
  const r = scan(`
    async function load() { try { await fetch('/x'); } catch (e) { /* best effort: the map redraws on the next ping */ } }
  `)
  assert.deepEqual(codes(r), [])
})

test('a silent catch around a purely local best-effort write is the idiom, not a fault', () => {
  const r = scan(`
    function remember() { try { localStorage.setItem('k', 'v'); } catch (e) {} }
  `)
  assert.deepEqual(codes(r), [])
})

test('an awaiting callback dropped into forEach is a fault, however the call is used', () => {
  const r = scan(`
    async function run() { await Promise.all(items.forEach(async (i) => { await save(i); })); }
  `)
  assert.deepEqual(codes(r), ['async-callback'])
})

test('a DROPPED map(async …) is a fault', () => {
  const r = scan(`
    async function run() { items.map(async (i) => { await save(i); }); }
  `)
  assert.deepEqual(codes(r), ['async-callback'])
})

test('…but collecting it with Promise.all is the correct form', () => {
  const r = scan(`
    async function run() { await Promise.all(items.map(async (i) => { await save(i); })); }
  `)
  assert.deepEqual(codes(r), [])
})

test('a name declared both async and sync is unresolvable, so it is skipped rather than guessed', () => {
  const r = scan(`
    async function touch() { await api(); }
    function touchSoon() { touch(); }
    function touch() { return 1; }
  `)
  assert.deepEqual(codes(r), [])
})

test('an exception that no longer matches anything is itself a fault', () => {
  const r = scan(
    `async function save() { await api(); }\nfunction onClick() { save(); }`,
    { policy: [{ code: 'floating-async', file: 'fixture.js', callee: 'gone', why: 'stale' }] }
  )
  // Both, and that is the point: the call is still a fault (the exception does
  // not describe it), and the entry itself is reported for no longer describing
  // anything — so a stale excuse cannot quietly silence a new one.
  assert.deepEqual(codes(r), ['floating-async', 'stale-exception'])
})

test('an exception that matches turns the fault off, and stays quiet', () => {
  const r = scan(
    `async function save() { await api(); }\nfunction onClick() { save(); }`,
    { policy: [{ code: 'floating-async', file: 'fixture.js', callee: 'save', why: 'declared: the retry owns it' }] }
  )
  assert.deepEqual(codes(r), [])
})
