#!/usr/bin/env node
// ─── one-off: does every §22 guard actually fail on its own fault? ───
//
// A guard that cannot go red is decoration. Running the whole smoke suite once
// per mutation costs ~2 minutes each, and section 22 is the last thing in it, so
// this extracts the section's own text out of scripts/smoke.mjs and runs JUST it
// against a mutated working tree — same helpers, same session, ~5 seconds each.
//
//   node scripts/one-off/2026-09-21-pantry-stock/mutate.mjs          # all
//   node scripts/one-off/2026-09-21-pantry-stock/mutate.mjs M4 M7    # a subset
//
// The extraction is the point: the code under test is the code that SHIPS in the
// suite, not a copy that can drift from it. Each mutation is a plain string
// replacement, the file's sha256 is checked before and after, and every mutation
// is restored in a `finally` — a driver that leaves a mutation behind would
// poison the next run.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8793').replace(/\/$/, '')
const USER = process.env.SMOKE_USER || 'maxx'
const PASS = process.env.SMOKE_PASS || 'adminpass123'
const root = new URL('../../../', import.meta.url)          // the repo root (Home/)
// The section reads its sources as `new URL('../' + p, import.meta.url)` — the
// path a file in scripts/ would use — so the extracted code is handed the URL of
// the very file it was cut from. Pointing it at this one-off directory instead
// silently reads every source as missing, and then EVERY code guard is red for
// the same reason (which is how a mutation report can look "caught" and mean
// nothing at all).
const smokeUrl = new URL('scripts/smoke.mjs', root).href

const read = (p) => readFileSync(new URL(p, root), 'utf8')
const write = (p, s) => writeFileSync(new URL(p, root), s)
const sha = (p) => createHash('sha256').update(readFileSync(new URL(p, root))).digest('hex')

// ── line endings ─────────────────────────────────────────────────────
// This working tree is a WINDOWS checkout: the files on disk are CRLF, while
// every anchor below (and every `to:`) is written with a plain \n. Matching raw
// bytes therefore missed every multi-line anchor -- and a missed anchor is a
// SKIPPED mutation, which changed no code and still exited 0. The whole report
// looked green and had proved half of itself nothing. So anchors are matched
// against a normalised copy, the edit is applied there, and the file is written
// back with the ending it already had.
const normalized = (p) => read(p).replace(/\r\n/g, '\n')
function writeKeepingEol(p, text) {
  const crlf = read(p).includes('\r\n')
  write(p, crlf ? text.replace(/\n/g, '\r\n') : text)
}

// ── extract section 22 out of the shipping suite ─────────────────────
const smoke = read('scripts/smoke.mjs')
const start = smoke.indexOf('// ─── 22. Two shopping lists')
const end = smoke.indexOf('// ─── summary')
if (start === -1 || end === -1) {
  console.error('could not find section 22 in scripts/smoke.mjs')
  process.exit(2)
}
// `import.meta` is not available inside the Function the section is run as, so
// the repo root travels in as a plain value instead.
const section = smoke.slice(start, end).replace(/import\.meta\.url/g, '__root')

let pass = 0
const failures = []
// Every check name that EXECUTED, pass or fail. Red-only bookkeeping cannot tell
// a guard that held from one that never ran: a walk that skipped, or an `expects`
// name that no longer exists, reads exactly like a caught mutation. The verdict
// below asks both questions — did it run, and did it go red.
const ran = []
const log = (...a) => console.log(...a)
const ok = (name) => { pass++; ran.push(name); log(`  \x1b[32m✓\x1b[0m ${name}`) }
const bad = (name, detail) => { failures.push(name); ran.push(name); log(`  \x1b[31m✗\x1b[0m ${name} \x1b[31m${detail}\x1b[0m`) }
const check = (name, condition, detail = '') => { condition ? ok(name) : bad(name, detail || 'assertion failed') }

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
    redirect: 'manual', ...init,
    headers: { ...(init.headers || {}), ...(jar.size ? { Cookie: cookieHeader() } : {}) },
  })
  absorb(res)
  return res
}
const body = async (res) => await res.text()
const form = (fields) => new URLSearchParams(fields).toString()

/** Editing a file the dev server watches makes it RELOAD, and a request that
 *  lands mid-reload answers 503 — which is how a cleanup pass can see an empty
 *  page and quietly leave a probe expense behind. Wait for the server to answer
 *  again before believing what a page says. */
async function settled(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await req('/login')
      if (res.status === 200) { await res.text(); return true }
    } catch (e) { /* still reloading */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** The trip half of §22 needs SOMETHING to buy and NO trip in progress. Both are
 *  state, and mutations can change it: a mutation that empties a trip, or the
 *  suite's own walk consuming the only low item, makes the next run SKIP that
 *  half -- and a skipped half reports no failure at all, which reads exactly like
 *  a caught mutation. So every run starts from a prepared pantry, and whatever
 *  this prepares is put back afterwards. */
/** A request that survives the dev server reloading underneath it: rewriting a
 *  source file makes wrangler reload, and a fetch that lands mid-reload is
 *  RESET (not a 503). Losing a driver to that tells us nothing about the guard. */
async function tryReq(path, init) {
  for (let i = 0; i < 30; i++) {
    try { return await req(path, init) }
    catch (e) { await new Promise((r) => setTimeout(r, 500)) }
  }
  return null
}

async function preparePantry() {
  await settled()
  const cleared = await tryReq('/laoka/api/pantry/trip/clear', { method: 'POST' })
  if (!cleared) { log('  \x1b[33m· the dev server did not come back; skipping the state reset\x1b[0m'); return null }
  const pantryState = await tryReq('/laoka/api/pantry')
  if (!pantryState) { log('  \x1b[33m· no pantry state to read; skipping the state reset\x1b[0m'); return null }
  const state = JSON.parse(await body(pantryState))
  if ((state.toBuy || []).length) return null
  const items = []
  for (const g of state.pantry || []) for (const s of g.subgroups || []) for (const it of s.items || []) items.push(it)
  const first = items.find((it) => it.stock !== null && it.stock !== undefined)
  if (!first) return null
  const before = { id: first.id, stock: first.stock, stockMin: first.stockMin }
  await tryReq(`/laoka/api/pantry/items/${first.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stock: Math.max(0, Number(first.stockMin) - 1) }),
  })
  log(`  \x1b[90m· counted “${first.name}” below its level so the trip half has something to buy\x1b[0m`)
  return before
}

/** Pull one function body out by brace balance (the suite's own helper). */
function fnBody(src, name) {
  const at = src.indexOf(`function ${name}(`)
  if (at === -1) return null
  let i = src.indexOf('(', at)
  if (i === -1) return null
  let pdepth = 0
  for (; i < src.length; i++) {
    if (src[i] === '(') pdepth++
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { i++; break } }
  }
  let open = src.indexOf('{', i)
  if (open === -1) return null
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

// ── the mutations ────────────────────────────────────────────────────
// Each is a plausible next edit, not a synthetic corruption: the number a
// reviewer would hardcode, the tidy-up a reviewer would add, the door a reviewer
// would forget. `expects` is the check that MUST go red, by name.
const QUERIES = 'src/laoka/data/queries.js'
const PANTRY = 'src/laoka/routes/pantry.js'
const APPJS = 'public/laoka/app.js'
const BUDGET = 'src/routes/budget.tsx'
const ENTRY = 'public/shared/number-entry.js'

const MUTATIONS = [
  // ── the pantry boundary, one clause per fault ──
  {
    id: 'M1', file: QUERIES,
    why: 'the to-buy rule stops being scoped to the pantry (a chicken thigh can now be "low")',
    from: "'WHERE i.deleted_at IS NULL AND g.is_pantry = 1 ' +\n    'AND i.stock IS NOT NULL",
    to: "'WHERE i.deleted_at IS NULL ' +\n    'AND i.stock IS NOT NULL",
    expects: ['the to-buy rule is pantry-only'],
  },
  {
    id: 'M2', file: QUERIES,
    why: "the household's per-item level is replaced by the number a reviewer would hardcode",
    from: "'AND i.stock IS NOT NULL AND i.stock < i.stock_min';",
    to: "'AND i.stock IS NOT NULL AND i.stock < 2';",
    expects: ['the to-buy rule is pantry-only'],
  },
  {
    id: 'M3', file: QUERIES,
    why: 'an untracked item (NULL count) is treated as a count of zero',
    from: 'AND i.stock IS NOT NULL AND i.stock < i.stock_min',
    to: 'AND i.stock < i.stock_min',
    expects: ['an item nobody counts is never offered'],
  },
  {
    id: 'M4', file: QUERIES,
    why: 'the MEAL catalogue stops excluding the pantry group',
    from: "'WHERE g.deleted_at IS NULL AND g.is_pantry = 0 ' +\n    'ORDER BY g.sort_order, g.id",
    to: "'WHERE g.deleted_at IS NULL ' +\n    'ORDER BY g.sort_order, g.id",
    expects: ['the meal catalogue is scoped away from the pantry, and reads no counts'],
  },
  {
    id: 'M5', file: QUERIES,
    why: 'the meal catalogue starts carrying counts again',
    from: "'i.id AS item_id, i.name AS item_name, i.selected, i.notes, i.sort_order AS item_sort ' +\n    'FROM groups g '",
    to: "'i.id AS item_id, i.name AS item_name, i.selected, i.notes, i.sort_order AS item_sort, i.stock ' +\n    'FROM groups g '",
    expects: ['the meal catalogue is scoped away from the pantry, and reads no counts'],
  },
  {
    id: 'M6', file: QUERIES,
    why: 'a pantry item can be drawn into a plan again',
    from: 'AND i.selected = 1 AND g.is_pantry = 0 AND s.slot_role IN',
    to: 'AND i.selected = 1 AND s.slot_role IN',
    expects: ['a pantry item can never be drawn into a plan'],
  },
  {
    id: 'M7', file: QUERIES,
    why: 'the week\u2019s rebuild folds the pantry back into the shopping list',
    from: '  const desired = new Map();',
    to: '  const desired = new Map();\n  const lowStockIds = await getLowStockItemIds(env);',
    expects: ["the week's list is built from the plan and nothing else"],
  },

  // ── the boundary the SERVER enforces ──
  {
    id: 'M8', file: PANTRY,
    why: 'the pantry stops asking which domain an item belongs to before counting it',
    from: "      if (!await isPantryItem(ctx.env, itemId)) return fail(404, 'no such pantry item');\n      const body = (await readJson(ctx.request)) || {};",
    to: "      if (false) return fail(404, 'no such pantry item');\n      const body = (await readJson(ctx.request)) || {};",
    expects: ['counting a MEAL ingredient through the pantry is refused'],
  },
  {
    id: 'M9', file: PANTRY,
    // BOTH call sites, because there are two on purpose: the clear button drops
    // the trip, and so does clearing a single line. Removing one leaves the
    // behaviour correct (that is the point of the redundancy) and only turns the
    // code guard red -- so the fault that actually breaks the screen is removing
    // both, which is what this mutation does.
    why: 'emptying a trip stops dropping it anywhere (both call sites)',
    from: '        await dropEmptyPantryTrip(ctx.env, trip.id);\n',
    to: '',
    also: [{ file: QUERIES, from: '    await dropEmptyPantryTrip(env, trip.id);\n', to: '' }],
    expects: ['and the emptied trip is not left behind as a ghost', 'clearing the prices ends the trip without touching a count'],
  },

  // ── the screens ──
  {
    id: 'M10', file: APPJS,
    why: 'the pantry hand-off navigates the IFRAME instead of the top document',
    // The id the hand-off goes to is re-read after the in-flight price settles
    // (`id`, not the `tripId` argument) — an anchor quoting the old variable
    // silently skipped, which is how this one was found on 2026-09-22.
    from: "window.top.location.href = '/budget/add-expense?from_pantry=' + encodeURIComponent(id);",
    to: "window.location.href = '/budget/add-expense?from_pantry=' + encodeURIComponent(id);",
    expects: ['the pantry hand-off leaves the iframe instead of drawing inside it'],
  },
  {
    id: 'M11', file: APPJS,
    why: 'the Pantry tab is dropped out of the nav',
    from: "  ['pantry', '🧺', 'Pantry'],\n",
    to: '',
    expects: ["the Pantry tab is in the app's nav, wired to the pantry API"],
  },
  {
    id: 'M12', file: APPJS,
    why: "a pantry toggle comes back into the week's shopping list",
    from: 'var NAV = [',
    to: 'function pantryToggle() { return false; }\nvar NAV = [',
    expects: ["the week's list no longer offers pantry items at all"],
  },

  // ── the Sompitra door ──
  {
    id: 'M13', file: BUDGET,
    why: 'a re-send starts rewriting the date the household chose',
    from: "'UPDATE transactions SET amount = ?, notes = ? WHERE id = ?'",
    to: "'UPDATE transactions SET date = ?, amount = ?, notes = ? WHERE id = ?'",
    expects: ["and both doors correct amount + notes only, never the household's choices"],
  },
  {
    id: 'M14', file: BUDGET,
    why: 'the pantry save stops looking the trip up, so saving twice would charge twice',
    from: "c.env.LAOKA_DB.prepare('SELECT transaction_id FROM pantry_trips WHERE id = ?')",
    to: "c.env.LAOKA_DB.prepare('SELECT transaction_id FROM pantry_trips WHERE pushed_at IS NULL')",
    expects: ['the pantry save adopts that expense instead of inserting a second'],
  },
  {
    id: 'M15', file: BUDGET,
    why: "the reviewed week's form stops carrying the week it came from",
    from: '<input type="hidden" name="laoka_week" value={String(laoka.weekId)} />',
    to: '<input type="hidden" value={String(laoka.weekId)} />',
    expects: ['the reviewed save still carries the week it came from'],
  },
  {
    id: 'M16', file: BUDGET,
    why: 'the one-press refresh stops recording how many lines it sent',
    from: 'await recordLaokaImport(c.env, weekId, id, amount, lines.length, categoryId)',
    to: 'await recordLaokaImport(c.env, weekId, id, amount, 0, categoryId)',
    expects: ['the one-press refresh still goes through the shared recorder'],
  },

  // ── the line's arithmetic: a quantity at a unit price ──
  {
    id: 'M17', file: 'migrations-laoka/0011_pantry_line_qty.sql',
    why: 'the trip line loses the quantity column',
    from: 'ALTER TABLE pantry_lines ADD COLUMN qty REAL NOT NULL DEFAULT 1;',
    to: 'ALTER TABLE pantry_lines ADD COLUMN note TEXT;',
    expects: ['the trip line stores a quantity of its own'],
  },
  {
    id: 'M18', file: PANTRY,
    why: 'the route validates a price but not a quantity',
    from: "      if (hasQty) {\n        const qty = readWhole(body.qty, MAX_QTY, false);",
    to: "      if (hasQty) {\n        const qty = readWhole(body.qty, 100000000, false);",
    expects: ['the API refuses an absurd quantity'],
  },
  {
    id: 'M19', file: PANTRY,
    why: 'the trip total goes back to summing unit prices',
    from: 'const total = lines.reduce(function (n, l) { return n + l.total; }, 0);',
    to: 'const total = lines.reduce(function (n, l) { return n + l.price; }, 0);',
    expects: ['the trip total is the sum of the LINE totals', 'a unit price and a quantity open a trip and total the product'],
  },
  {
    id: 'M20', file: BUDGET,
    why: 'the pantry expense is sent the price of ONE, however many were bought',
    from: 'return { name: qty === 1 ? r.name : `${r.name} ×${qty}`, price: Math.trunc(unit * qty) }',
    to: 'return { name: r.name, price: Math.trunc(unit) }',
    expects: ['the Sompitra hand-off multiplies the unit price by the quantity', "the trip opens Sompitra's own form, priced, on the itemized pane"],
  },
  {
    id: 'M21', file: APPJS,
    why: 'the row stops showing the restock price as you type',
    from: 'line.textContent = moneyAmount(unit * q);',
    to: 'line.textContent = moneyAmount(unit);',
    expects: ['the screen shows the restock price it will send'],
  },
  {
    id: 'M22', file: APPJS,
    why: 'the row sends the unit price but not the quantity',
    from: "pantryWrite('PATCH', '/api/pantry/trip', { itemId: item.id, price: unit, qty: q }, { money: true });",
    to: "pantryWrite('PATCH', '/api/pantry/trip', { itemId: item.id, price: unit }, { money: true });",
    expects: ['the screen shows the restock price it will send'],
  },
  {
    id: 'M37', file: APPJS,
    why: 'the price reply goes back to rebuilding the whole list (the tidy-up that reads best)',
    from: '    if (opts && opts.money && swapPantryFoot()) return res;\n',
    to: '',
    expects: ['a price reply repaints the money, never the box being typed in'],
  },
  {
    id: 'M38', file: APPJS,
    why: 'the repaint is handed an empty list instead of the state the server just sent',
    from: 'card.parentNode.replaceChild(pantryFoot(state.bootstrap.pantryToBuy || []), card);',
    to: 'card.parentNode.replaceChild(pantryFoot([]), card);',
    expects: ['and the money it repaints is the state the server just answered with'],
  },
  {
    id: 'M39', file: QUERIES,
    why: 'a price of zero is stored like any other price',
    from: 'const clearing = fields.price === null || Number(fields.price) === 0;',
    to: 'const clearing = fields.price === null;',
    expects: ['a price of zero is an emptied box, not a free item', 'a price of zero records nothing and opens no trip'],
  },
  {
    id: 'M40', file: QUERIES,
    why: 'removing an item leaves its priced line behind',
    from: "  await env.DB.prepare('DELETE FROM pantry_lines WHERE item_id = ?1').bind(itemId).run();\n  await env.DB.prepare(\n    \"UPDATE items SET deleted_at = datetime('now') WHERE id = ?1 AND deleted_at IS NULL\"",
    to: "  await env.DB.prepare(\n    \"UPDATE items SET deleted_at = datetime('now') WHERE id = ?1 AND deleted_at IS NULL\"",
    // Only the CODE guard can see this one. The outcome the walk asks about stays
    // right by the second mechanism alone (`dropEmptyPantryTrip` counts only the
    // lines that can DRAW, so a removed item's price no longer keeps the trip
    // alive) — real defence in depth, and the reason M51 removes both at once.
    expects: ['removing a pantry item takes its price, and the trip it emptied, with it'],
  },
  {
    id: 'M42', file: QUERIES,
    why: 'an empty trip is judged by raw ROWS again, so a line nobody can draw keeps it alive',
    from: "'SELECT pushed_at, (SELECT COUNT(*) FROM pantry_lines p JOIN items i ON i.id = p.item_id ' +\n    'WHERE p.trip_id = ?1 AND i.deleted_at IS NULL AND p.price IS NOT NULL AND p.price > 0) AS n ' +\n",
    to: "'SELECT pushed_at, (SELECT COUNT(*) FROM pantry_lines WHERE trip_id = ?1) AS n ' +\n",
    expects: ['a trip only counts the lines it can actually draw'],
  },
  {
    id: 'M43', file: QUERIES,
    why: 'a dropped trip leaves its stale line rows behind',
    from: "  await env.DB.prepare('DELETE FROM pantry_lines WHERE trip_id = ?1').bind(tripId).run();\n",
    to: '',
    expects: ['and takes its undrawable rows with it when it goes'],
  },
  {
    id: 'M41', file: APPJS,
    why: 'the empty-week note goes back to promising pantry items',
    from: "text: 'Generate and save a week first. The list is what this week\\'s cooking needs — staples and household goods are bought on the Pantry tab.'",
    to: "text: 'Generate and save a week first. The list is the saved plan plus every Pantry item.'",
    expects: ["the week's empty-list note no longer promises pantry items"],
  },
  {
    id: 'M23', file: QUERIES,
    why: 'one of the two places that drop an emptied trip stops doing it',
    from: '    await dropEmptyPantryTrip(env, trip.id);\n    return trip.id;',
    to: '    return trip.id;',
    expects: ['and the emptied trip is not left behind as a ghost'],
  },

  // ── §23: a number is typed, never nudged ──
  {
    id: 'M24', file: ENTRY,
    why: 'the spinner buttons come back in the engines that draw them',
    from: "    'input[type=\"number\"]::-webkit-outer-spin-button,' +\n" +
      "    'input[type=\"number\"]::-webkit-inner-spin-button' +\n" +
      "    '{-webkit-appearance:none;appearance:none;margin:0;height:auto;}';\n",
    to: "    'input[type=\"number\"]{}';\n",
    expects: ["the browser's own up/down buttons are removed"],
  },
  {
    id: 'M25', file: ENTRY,
    // The half that is easy to leave out: cancelling the step is obvious, and
    // performing the scroll by hand is the part a reviewer deletes as redundant.
    why: 'the wheel stops stepping the box but takes the page scroll with it',
    from: "    var scroller = scrollerFor(box);\n" +
      "    if (scroller) {\n" +
      "      if (dy) scroller.scrollTop += dy;\n" +
      "      if (dx) scroller.scrollLeft += dx;\n" +
      "    } else {\n" +
      "      window.scrollBy(dx, dy);\n" +
      "    }\n",
    to: '',
    expects: ['a wheel over a number box cannot step it'],
  },
  {
    id: 'M26', file: ENTRY,
    why: 'every box under the pointer is guarded, focused or not — the scroll-through case',
    from: '    if (document.activeElement !== box) return;\n',
    to: '',
    expects: ['a box that is not focused is left completely alone'],
  },
  {
    id: 'M27', file: ENTRY,
    why: 'the arrow guard is widened to a key the app needs (Enter commits a price)',
    from: "    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;",
    to: "    if (ev.key !== 'Tab' && ev.key !== 'Enter') return;",
    expects: ['Up/Down are cancelled too, and no other key is'],
  },
  {
    id: 'M28', file: ENTRY,
    why: 'a tidy-up starts rewriting the value it is supposed to leave alone',
    from: "  document.addEventListener('keydown', function (ev) {",
    to: "  function repair(b) { b.value = ''; }\n  document.addEventListener('keydown', function (ev) {",
    expects: ['the rule never rewrites a value'],
  },
  {
    id: 'M29', file: 'public/way/index.html',
    why: 'one shipped document stops loading the rule',
    from: '<script src="/shared/number-entry.js"></script>\n',
    to: '',
    expects: ['WAY load the entry rule'],
  },
  {
    id: 'M30', file: 'src/views/layout.tsx',
    why: 'the Sompitra pages and every module shell lose the rule at once',
    from: '        <script src="/shared/number-entry.js" />\n',
    to: '',
    expects: ['the Sompitra page head loads the entry rule', 'the Sompitra pages load the entry rule'],
  },

  // ── the pantry's categories belong to the pantry, and to no one else ──
  {
    id: 'M31', file: PANTRY,
    why: 'renaming a category stops asking whether it is a pantry category',
    from: "      if (!await isPantryCategory(ctx.env, id)) return fail(404, 'no such pantry category');\n      const body = (await readJson(ctx.request)) || {};",
    to: "      if (false) return fail(404, 'no such pantry category');\n      const body = (await readJson(ctx.request)) || {};",
    expects: ['renaming a MEAL group through the pantry is refused', 'the MEAL group both refusals aimed at is untouched'],
  },
  {
    id: 'M32', file: PANTRY,
    why: 'removing a category stops asking, so the Pantry tab can delete a MEAL group',
    from: "      if (!await isPantryCategory(ctx.env, id)) return fail(404, 'no such pantry category');\n      const items = await deletePantryCategory(ctx.env, id);",
    to: "      if (false) return fail(404, 'no such pantry category');\n      const items = await deletePantryCategory(ctx.env, id);",
    expects: ['removing a MEAL group through the pantry is refused', 'the MEAL group both refusals aimed at is untouched'],
  },
  {
    id: 'M33', file: APPJS,
    why: 'the heading handlers close over the loop variable again — every ✏️ renames the last category',
    from: "onclick: function () { editPantryCategory(cat); }",
    to: "onclick: function () { editPantryCategory(sub); }",
    also: [{ file: APPJS, from: "onclick: function () { removePantryCategory(cat); }", to: "onclick: function () { removePantryCategory(sub); }" }],
    expects: ['each heading acts on ITS OWN category'],
  },
  {
    id: 'M34', file: APPJS,
    why: 'a category with nothing in it is skipped again',
    from: "      if (!list.length) {\n        card.appendChild(h('p', { class: 'muted small', style: 'padding:2px 12px 8px', text: 'Nothing in it yet — “Add an item” and pick this category.' }));\n        continue;\n      }\n",
    to: '      if (!list.length) continue;\n',
    expects: ['a pantry category with nothing in it still draws'],
  },
  {
    id: 'M35', file: APPJS,
    why: 'the meal catalog offers to create a pantry group again',
    from: "await api('POST', '/api/groups', { name: name, isPantry: 0 });",
    to: "await api('POST', '/api/groups', { name: name, isPantry: pantry1.value === '1' });",
    expects: ['the meal catalog no longer offers to make a pantry group'],
  },
  {
    id: 'M36', file: QUERIES,
    why: 'removing a category leaves its items\u2019 priced lines behind',
    from: "  await env.DB.prepare(\n    'DELETE FROM pantry_lines WHERE item_id IN (SELECT id FROM items WHERE subgroup_id = ?1)'\n  ).bind(subgroupId).run();\n",
    to: '',
    expects: ['removing a category takes its items AND their trip lines with it'],
  },

  // ── the three ways the same money went wrong on a real phone ──
  {
    id: 'M44', file: PANTRY,
    why: 'a fractional price is stored again, so the trip and the budget disagree by the fraction',
    from: 'const price = readWhole(body.price, MAX_PRICE, true);',
    to: 'const price = readAmount(body.price, MAX_PRICE, true);',
    expects: ['a fractional price or count is stored whole, so both totals agree',
      'the API stores a price and a quantity whole, like the boxes do'],
  },
  {
    id: 'M45', file: APPJS,
    why: 'the clear stops waiting for the price that is still in flight',
    from: "      await pantryPriceWriteWaiting();\n      await pantryWrite('POST', '/api/pantry/trip/clear', {});",
    to: "      await pantryWrite('POST', '/api/pantry/trip/clear', {});",
    expects: ['the clear waits for a price that is still in flight'],
  },
  {
    id: 'M46', file: APPJS,
    why: 'the hand-off navigates while a price is still in flight',
    from: "async function openPantryExpense(tripId) {\n  // A price typed a moment ago may still be in flight: send the shopping that was\n  // actually priced, not the one a reply behind it.\n  await pantryPriceWriteWaiting();",
    to: "async function openPantryExpense(tripId) {",
    expects: ['and the hand-off waits for it too, so it sends the shopping that was priced'],
  },
  {
    id: 'M47', file: BUDGET,
    why: 'the week\u2019s identity is honoured on the itemized pane only -- the reversal this walk was written for',
    from: '  if (laokaWeek) {\n    const existing = await c.env.HOME_DB',
    to: "  if (laokaWeek && mode === 'itemized') {\n    const existing = await c.env.HOME_DB",
    expects: ['the hand-off identity is honoured in both modes, not only the itemized pane'],
  },
  {
    id: 'M48', file: BUDGET,
    why: 'a Quick save stops adopting the expense it already made (the pantry door)',
    from: '  if (pantryTrip && !adopted) {',
    to: "  if (pantryTrip && !adopted && mode === 'itemized') {",
    // The live walk is the point of this one: the same shopping saved twice must
    // stay ONE expense, and the code guard alone cannot say that.
    expects: ['the hand-off identity is honoured in both modes, not only the itemized pane',
      'and saving it again corrects that ONE expense, never a second one',
      'and the budget lists that shopping exactly once',
      'the probe expense is cleaned up'],
  },
  {
    id: 'M49', file: BUDGET,
    why: 'a re-save stops reading the count the trip already records',
    from: '    return (row && row.item_count) ? row.item_count : fallback',
    to: '    return fallback',
    // Only the WALK can see this one: the fault keeps the SQL read in place and
    // changes what is returned, so the code guard above it stays green by design.
    // Naming both here made the mutation uncatchable — `expects` is "all of these
    // must go red", not "any".
    expects: ['and saving it again corrects that ONE expense, never a second one'],
  },
  {
    id: 'M50', file: BUDGET,
    why: 'an absent category field reads as the STRING "undefined" again',
    from: "const categoryId = String(body.category_id || '')",
    to: 'const categoryId = String(body.category_id)',
    expects: ['and a hand-off saved without a category picked still saves'],
  },
  {
    id: 'M51', file: QUERIES,
    why: 'a removed item keeps its line, AND that line keeps its trip alive — both redundant guards at once',
    from: "  await env.DB.prepare('DELETE FROM pantry_lines WHERE item_id = ?1').bind(itemId).run();\n  await env.DB.prepare(\n    \"UPDATE items SET deleted_at = datetime('now') WHERE id = ?1 AND deleted_at IS NULL\"",
    to: "  await env.DB.prepare(\n    \"UPDATE items SET deleted_at = datetime('now') WHERE id = ?1 AND deleted_at IS NULL\"",
    // The PAIR is the fault the walk is for: with either clause alone the trip
    // still ends, which is why M40 and M42 each keep an outcome-neutral edit and
    // this one takes both. All three checks go red (the two code guards for the
    // clauses, and the walk that reads the trip back).
    also: [{
      file: QUERIES,
      from: "'SELECT pushed_at, (SELECT COUNT(*) FROM pantry_lines p JOIN items i ON i.id = p.item_id ' +\n    'WHERE p.trip_id = ?1 AND i.deleted_at IS NULL AND p.price IS NOT NULL AND p.price > 0) AS n ' +\n",
      to: "'SELECT pushed_at, (SELECT COUNT(*) FROM pantry_lines WHERE trip_id = ?1) AS n ' +\n",
    }],
    expects: ['removing the item takes its price, and the trip it opened, with it',
      'removing a pantry item takes its price, and the trip it emptied, with it',
      'a trip only counts the lines it can actually draw'],
  },
  {
    id: 'M52', file: APPJS,
    why: 'a typed decimal is stripped instead of cut, so 1250.75 becomes 125075',
    from: "  return String(raw == null ? '' : raw).replace(/[\\s,]/g, '').split('.')[0].replace(/[^0-9]/g, '');",
    to: "  return String(raw == null ? '' : raw).replace(/[^0-9]/g, '');",
    expects: ['a typed decimal is cut at the point, never merged into a bigger price'],
  },
]

// ── run ──────────────────────────────────────────────────────────────
const wanted = process.argv.slice(2)
const chosen = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS
if (!chosen.length) {
  console.error(`no such mutation. known: ${MUTATIONS.map((m) => m.id).join(', ')}`)
  process.exit(2)
}

const login = await req('/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form({ username: USER, password: PASS }),
})
if (login.status !== 302) {
  console.error(`could not sign in (${login.status}) — is the dev server up on ${BASE}?`)
  process.exit(2)
}

// The expenses that were there before any mutation ran. Only rows that appear
// AFTER this baseline are the driver's own mess, and only those get deleted.
const baseline = [...(await body(await req('/budget/transactions'))).matchAll(/data-tx-details="([^"]+)"/g)].map((m) => m[1])
const deleted = []

// NOTE the last parameter's name: the extracted section reads its sources as
// `new URL('../' + p, __root)`, so the value that arrives has to be bound to
// `__root`. Binding it to anything else leaves __root undefined, the section's
// own try/catch turns every source into '' , and all five CODE guards go red on
// every mutation — a report that looks like a wall of catches and proves nothing.
// `jar` travels in too: the section parks and restores the cookie jar to ask the
// pantry what an ANONYMOUS caller gets, and a bare handle on the map is what that
// check needs (a spread copy would answer about a jar nobody uses).
const runSection = new Function(
  'BASE', '__root', 'log', 'ok', 'bad', 'check', 'req', 'body', 'form', 'fnBody', 'readFileSync', 'URL', 'fetch', 'jar',
  `return (async () => {\n${section}\n})()`
)

/** Put back whatever `preparePantry` changed, so a run leaves the local shelf as
 *  it found it. */
async function restorePrepared(prepared) {
  if (!prepared) return
  await tryReq(`/laoka/api/pantry/items/${prepared.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stock: prepared.stock, stockMin: prepared.stockMin }),
  })
}

/** Anything on the budget that was not there before the driver started is the
 *  driver's own mess — the suite's walks post probe expenses, and M9 posts a
 *  second one. Delete exactly those, and say so out loud. */
async function sweepProbeExpenses(label) {
  const txPage = await tryReq('/budget/transactions')
  const nowIds = txPage
    ? [...(await body(txPage)).matchAll(/data-tx-details="([^"]+)"/g)].map((x) => x[1])
    : []
  for (const id of nowIds.filter((x) => !baseline.includes(x))) {
    const res = await tryReq(`/budget/delete/${id}`, { method: 'POST' })
    log(`  \x1b[90m↺ removed the probe expense this ${label} created (${id}) → ${res ? res.status : 'no answer'}\x1b[0m`)
    deleted.push(id)
  }
}

// ── preflight ────────────────────────────────────────────────────────
// A guard can only catch a fault if it RUNS and is GREEN on the clean tree. One
// that is already red, or that never executes at all (a walk that skipped reports
// nothing), makes every verdict below meaningless while looking exactly like a
// wall of catches. So all expected checks are exercised once, unmutated, first.
// This is what caught M49 asking a one-item probe for a count of two: the walk
// was red before any file was touched.
{
  const expected = [...new Set(chosen.flatMap((m) => m.expects))]
  pass = 0
  failures.length = 0
  ran.length = 0
  const prepared = await preparePantry()
  try {
    await runSection(BASE, smokeUrl, log, ok, bad, check, req, body, form, fnBody, readFileSync, URL, fetch, jar)
  } catch (err) {
    bad('section ran to completion', `threw: ${err && err.message}`)
  } finally {
    await restorePrepared(prepared)
    await settled()
  }
  const reds = [...new Set(failures)]
  const absent = expected.filter((name) => !ran.some((n) => n.startsWith(name)))
  if (reds.length || absent.length) {
    console.error('\x1b[31mpreflight: the section is not clean before any mutation, so the verdicts below would prove nothing.\x1b[0m')
    for (const f of reds) console.error(`  \x1b[31m✗\x1b[0m ${f}`)
    for (const a of absent) console.error(`  \x1b[33m· never ran:\x1b[0m ${a}`)
    console.error('Fix the tree (or the expectation) first — nothing was mutated.')
    process.exit(2)
  }
  log(`\x1b[32mpreflight: ${expected.length} expected check(s) ran, and all were green on the clean tree.\x1b[0m`)
  await sweepProbeExpenses('preflight')
}

const results = []
for (const m of chosen) {
  // A mutation may span several files (`also`): the fault that breaks a screen
  // is sometimes the removal of BOTH of two redundant guards. Every touched file
  // is read, written, sha-checked and restored together.
  const edits = [{ file: m.file, from: m.from, to: m.to }].concat(m.also || [])
  const backups = edits.map((e) => ({ file: e.file, text: read(e.file), sha: sha(e.file) }))
  const missing = edits.find((e) => !normalized(e.file).includes(e.from))
  if (missing) {
    results.push({ id: m.id, verdict: 'SKIPPED — anchor missing' })
    log(`\x1b[33m${m.id}\x1b[0m could not be applied: anchor missing in ${missing.file}`)
    continue
  }
  log(`\n\x1b[1m${m.id}\x1b[0m ${m.why}`)
  pass = 0
  failures.length = 0
  ran.length = 0
  const prepared = await preparePantry()
  try {
    for (const e of edits) writeKeepingEol(e.file, normalized(e.file).replace(e.from, e.to))
    await runSection(BASE, smokeUrl, log, ok, bad, check, req, body, form, fnBody, readFileSync, URL, fetch, jar)
  } catch (err) {
    bad('section ran to completion', `threw: ${err && err.message}`)
  } finally {
    for (const b of backups) write(b.file, b.text)
    for (const b of backups) {
      if (sha(b.file) !== b.sha) {
        console.error(`\x1b[31mRESTORE FAILED for ${b.file} — fix this before anything else\x1b[0m`)
        process.exit(3)
      }
    }
    await restorePrepared(prepared)
  }

  const unique = [...new Set(failures)]
  const hit = m.expects.every((name) => unique.some((f) => f.startsWith(name)))
  const extra = unique.filter((f) => !m.expects.some((name) => f.startsWith(name)))
  // An expected check that never executed cannot have caught anything: the walk
  // it lives in skipped, or the name no longer exists in the suite. Reported as
  // NOT RUN and counted as a failure, never as a quiet pass.
  const unrun = m.expects.filter((name) => !ran.some((n) => n.startsWith(name)))
  const verdict = unrun.length
    ? `NOT RUN — ${unrun[0].slice(0, 60)}`
    : hit ? (extra.length ? `RED +${extra.length} extra` : 'RED — own check only') : 'GREEN — not caught'
  results.push({ id: m.id, verdict, extra })
  log(`  \x1b[90m${unique.length} red: ${unique.map((f) => f.split(' —')[0]).join(' | ') || '(none)'}\x1b[0m`)
  if (unrun.length) {
    log(`  \x1b[31m▲ NOT caught — the check it should turn red never ran: ${unrun.join('; ')}\x1b[0m`)
  } else {
    log(hit ? '  \x1b[32m▲ mutation caught\x1b[0m' : '  \x1b[31m▲ NOT caught\x1b[0m')
  }

  // A mutation can really write (M9 posts a second expense). Clean up anything
  // that was not there before the driver started, and say so out loud.
  if (!(await settled())) log('  \x1b[31mthe dev server did not come back after the restore\x1b[0m')
  await sweepProbeExpenses('mutation')
  await new Promise((r) => setTimeout(r, 400))
}

// The driver restores CODE, not DATA. A mutation that strands a trip (M51 and
// M40/M42 leave an item's line behind, which keeps an undrawable trip alive) is
// the point of the exercise — but leaving that row in the local database hands
// the next run a pantry with a trip already in progress, and the suite's own
// walks then report failures that belong to the mutation, not the tree. One
// clear writes it off: with the code restored, `dropEmptyPantryTrip` counts the
// lines that DRAW (none of them do) and takes the stale rows with it.
await tryReq('/laoka/api/pantry/trip/clear', { method: 'POST' })
if ((await body(await tryReq('/laoka/api/pantry')) || '').includes('"trip":{"id"')) {
  log('\x1b[33m· a pantry trip is still in progress after the run — clear it in Laoka → Pantry\x1b[0m')
}

log('\n── mutation report ────────────────────────────')
for (const r of results) {
  const colour = r.verdict.startsWith('RED') ? '32' : r.verdict.startsWith('GREEN') ? '31' : '33'
  log(`  \x1b[${colour}m${r.verdict.padEnd(22)}\x1b[0m ${r.id}`)
}
const uncaught = results.filter((r) => r.verdict.startsWith('GREEN')).length
const unrun = results.filter((r) => r.verdict.startsWith('NOT RUN')).length
// A skipped anchor changes NO code, so it proves nothing either — it fails the
// run the same way an uncaught fault does, instead of hiding in the report.
const skipped = results.filter((r) => r.verdict.startsWith('SKIPPED')).length
if (uncaught || unrun || skipped) {
  log(`\n\x1b[31m${uncaught} guard(s) did not catch their own fault${unrun ? `, ${unrun} never ran` : ''}${skipped ? `, ${skipped} anchor(s) missing (nothing was changed)` : ''}\x1b[0m`)
} else {
  log('\n\x1b[32mEvery mutation turned its own check red.\x1b[0m')
}

// M9 makes the reviewed save post a SECOND expense, so the ledger ends up
// pointing at the probe this driver just deleted. That is state, not code, and
// only the operator can put it back — so say exactly how.
if (deleted.length) {
  log(`\n\x1b[33mcleanup took ${deleted.length} probe expense(s) out of the local database.\x1b[0m`)
  // Only SOME of these matter: the suite's own walks post their probes and the
  // driver takes them back, which changes nothing. The one that bites is M9's
  // second expense — the week the local laoka_imports row points at — so this
  // says what to look for rather than claiming every run needs a repair.
  log('If the suite now SKIPS its save half, one of them was the week that laoka_imports row')
  log('points at (it only ever corrects an expense that exists). Re-point it with:\n')
  log(`  npx wrangler d1 execute home-db --local --command 'UPDATE laoka_imports SET transaction_id = "<the live expense id>" WHERE laoka_week_id = <week>'\n`)
}
process.exit(uncaught || unrun || skipped ? 1 : 0)
