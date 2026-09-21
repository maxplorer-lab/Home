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
    /is_pantry\s*=\s*1/.test(lowFn) && /stock\s*<\s*stock_min/.test(lowFn) && !/stock\s*<\s*\d/.test(lowFn),
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
  } else if (live.trip) {
    log('  \x1b[90m– skipped the trip half: a pantry trip is already in progress, and it holds prices the household typed\x1b[0m')
  } else if (!(live.toBuy || []).length) {
    log('  \x1b[90m– skipped the trip half: nothing is below its reorder level in the local pantry\x1b[0m')
  } else {
    const buy = live.toBuy[0]
    try {
      const priced = await parse(await jpatch('/laoka/api/pantry/trip', { itemId: buy.id, price: 1234 }))
      check('a typed price opens a trip and totals it',
        priced?.trip && priced.trip.count === 1 && priced.trip.total === 1234 && priced.trip.pushedAt === null,
        `trip=${JSON.stringify(priced?.trip)}`)
      check('and the to-buy line carries the price it was given',
        (priced?.toBuy || []).some((i) => i.id === buy.id && i.tripPrice === 1234),
        'the price did not reach the to-buy line the screen draws')

      const form = await body(await req(`/budget/add-expense?from_pantry=${priced.trip.id}`))
      const rows = form.slice(form.indexOf('id="line-items"'), form.indexOf('id="itemized-total-display"'))
      check('the trip opens Sompitra\'s own form, priced, on the itemized pane',
        /🧺 Pantry shopping trip/.test(form) &&
          new RegExp(`name="pantry_trip" value="${priced.trip.id}"`).test(form) &&
          /if \(true\) \{ showMode\('itemized'\)/.test(form) &&
          rows.includes(`value="${buy.name}"`) && rows.includes('value="1234"'),
        'the pantry hand-off did not pre-fill the form')
      check('and the form says what it will spend',
        /Ar 1,234/.test(form),
        'the form does not show the trip\'s total')

      const ghost = await body(await req('/budget/add-expense?from_pantry=999999'))
      check('a trip that does not exist gives an ordinary empty form',
        !/Pantry shopping trip/.test(ghost) && /if \(false\) \{ showMode\('itemized'\)/.test(ghost),
        'a bogus trip id left the form half-filled or switched modes')

      const cleared = await parse(await req('/laoka/api/pantry/trip/clear', { method: 'POST' }))
      check('clearing the prices ends the trip without touching a count',
        cleared?.ok === true && !cleared.trip &&
          (cleared.toBuy || []).some((i) => i.id === buy.id && i.tripPrice === null),
        `trip=${JSON.stringify(cleared?.trip)}`)
    } finally {
      await req('/laoka/api/pantry/trip/clear', { method: 'POST' })
    }
  }

  // The identity of a purchase: a pushed trip keeps the expense it became. That
  // record is what the Pantry screen shows as "last trip", and what the Sompitra
  // save ADOPTS instead of inserting a second one.
  //
  // The pantry's own write half is deliberately not exercised here: pushing
  // clears a trip's prices on purpose, so a second submit could only rewrite the
  // notes of an expense whose lines no longer exist -- the destructive direction
  // the shared rule forbids -- and creating a throwaway expense would leave a
  // dangling trip on the screen. What a re-submit DOES is the same adoption
  // Laoka's half proves for real in section 13, through the same helper; what is
  // pinned here is that the record that adoption reads exists, and that both
  // doors go through one rule.
  check('a pushed trip keeps the expense it became',
    !live || !live.lastTrip || (!!live.lastTrip.transactionId && live.lastTrip.amount !== null),
    'the last pushed trip does not remember its expense, so nothing could adopt it')
  check('the pantry save adopts that expense instead of inserting a second',
    /FROM pantry_trips WHERE id = \?/.test(budgetCode) &&
      /refreshPantryExpense\(c\.env, pantryTrip, adopted/.test(budgetCode) &&
      /markPantryTripPushed\(c\.env, pantryTrip, id/.test(budgetCode),
    'the pantry door no longer looks the trip up, so saving it twice would charge the budget twice')
  check('and both doors correct amount + notes only',
    /UPDATE transactions SET amount = \?, notes = \? WHERE id = \?/.test(budgetCode) &&
      !/UPDATE transactions SET date/.test(budgetCode),
    'a re-save can overwrite a date, category or description the household chose')
  // A form the BROWSER submits arrives with CRLF in every multiline field, so the
  // stored notes must be one shape whichever door sent them.
  check('itemized notes are stored with one shape, whatever the browser sends',
    /replace\(\/\\r\\n\?\/g, '\\n'\)/.test(budgetCode),
    'the POST no longer normalises CRLF, so the same list is stored differently by hand and by Laoka')

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

  // (f) The screens. Laoka runs inside an IFRAME, so a hand-off that navigated
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
}
