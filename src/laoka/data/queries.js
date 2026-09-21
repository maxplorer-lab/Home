// Every database read and write lives here so the route modules stay thin.

import { todayInNairobi, isDayEditable } from '../lib/dates.js';
import { exportFilename } from '../lib/csv.js';

const WEEK_COLUMNS = 'id, start_date, end_date, status, budget, exported_at, updated_at, generation, confirmed_at';

export async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of (rows.results || [])) out[r.key] = r.value;
  return out;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2'
  ).bind(key, String(value)).run();
}

export async function touchWeek(env, weekId) {
  await env.DB.prepare("UPDATE weeks SET updated_at = datetime('now') WHERE id = ?1").bind(weekId).run();
}

export async function getWeekById(env, weekId) {
  return await env.DB.prepare('SELECT ' + WEEK_COLUMNS + ' FROM weeks WHERE id = ?1').bind(weekId).first();
}

export async function getWeekByStart(env, startDate) {
  return await env.DB.prepare('SELECT ' + WEEK_COLUMNS + ' FROM weeks WHERE start_date = ?1').bind(startDate).first();
}

export async function listWeeks(env) {
  const rows = await env.DB.prepare(
    'SELECT ' + WEEK_COLUMNS + ' FROM weeks WHERE status != ?1 ORDER BY start_date DESC'
  ).bind('archived').all();
  return rows.results || [];
}

// ---------------------------------------------------------------- catalog

/**
 * The MEAL catalogue: protein, sides and raw salads -- what a week is planned
 * from, bought for and cooked.
 *
 * `g.is_pantry = 0` is the domain boundary, and it is enforced HERE rather than
 * in each screen, so nothing on the meal side can render, select or buy a pantry
 * item by accident: the Catalog tab, the planner's draw pools and the week's
 * shopping list all read this one function. The pantry has its own tree
 * (`getPantryTree`), its own counts and its own purchase.
 */
export async function getCatalogTree(env) {
  // Stock is deliberately NOT selected here. A count is a pantry fact; selecting
  // it on the meal side is how a screen ends up drawing a number nobody should
  // have set (and how "count the chicken too" comes back).
  const sql = 'SELECT g.id AS group_id, g.name AS group_name, g.is_pantry, g.sort_order AS group_sort, ' +
    's.id AS subgroup_id, s.name AS subgroup_name, s.icon AS subgroup_icon, s.slot_role, s.sort_order AS subgroup_sort, ' +
    'i.id AS item_id, i.name AS item_name, i.selected, i.notes, i.sort_order AS item_sort ' +
    'FROM groups g ' +
    'LEFT JOIN subgroups s ON s.group_id = g.id AND s.deleted_at IS NULL ' +
    'LEFT JOIN items i ON i.subgroup_id = s.id AND i.deleted_at IS NULL ' +
    'WHERE g.deleted_at IS NULL AND g.is_pantry = 0 ' +
    'ORDER BY g.sort_order, g.id, s.sort_order, s.id, i.sort_order, i.id';
  const rows = await env.DB.prepare(sql).all();

  const groups = [];
  const byGroup = new Map();
  const bySubgroup = new Map();

  for (const r of (rows.results || [])) {
    let g = byGroup.get(r.group_id);
    if (!g) {
      g = { id: r.group_id, name: r.group_name, isPantry: !!r.is_pantry, subgroups: [] };
      byGroup.set(r.group_id, g);
      groups.push(g);
    }
    if (r.subgroup_id === null || r.subgroup_id === undefined) continue;
    let s = bySubgroup.get(r.subgroup_id);
    if (!s) {
      s = { id: r.subgroup_id, name: r.subgroup_name, icon: r.subgroup_icon || '', slotRole: r.slot_role, groupId: g.id, groupName: g.name, items: [] };
      bySubgroup.set(r.subgroup_id, s);
      g.subgroups.push(s);
    }
    if (r.item_id === null || r.item_id === undefined) continue;
    s.items.push({ id: r.item_id, name: r.item_name, selected: !!r.selected, notes: r.notes, subgroupId: s.id });
  }
  return groups;
}

// Eligible draw pools, keyed by slot role. Only selected, live items qualify.
// `i.selected` is a MEAL idea ("I cook with this"), so the pantry is excluded
// explicitly rather than by luck: a pantry item has no slot role today, and this
// keeps it true if one is ever given a role by mistake.
export async function getSelectedPools(env) {
  const sql = 'SELECT s.slot_role, i.id FROM items i ' +
    'JOIN subgroups s ON s.id = i.subgroup_id AND s.deleted_at IS NULL ' +
    'JOIN groups g ON g.id = s.group_id AND g.deleted_at IS NULL ' +
    'WHERE i.deleted_at IS NULL AND i.selected = 1 AND g.is_pantry = 0 AND s.slot_role IN (?1, ?2, ?3)';
  const rows = await env.DB.prepare(sql).bind('protein', 'side', 'salad').all();
  const pools = { protein: [], side: [], salad: [] };
  for (const r of (rows.results || [])) {
    if (pools[r.slot_role]) pools[r.slot_role].push(r.id);
  }
  return pools;
}

export async function getGourmetIds(env) {
  const rows = await env.DB.prepare('SELECT id FROM gourmet WHERE deleted_at IS NULL ORDER BY id').all();
  return (rows.results || []).map(function (r) { return r.id; });
}

export async function getGourmetList(env) {
  const rows = await env.DB.prepare(
    'SELECT id, title, link, ingredients, notes, ' +
    '(image IS NOT NULL) AS has_image, image_updated_at ' +
    'FROM gourmet WHERE deleted_at IS NULL ORDER BY title COLLATE NOCASE'
  ).all();
  return (rows.results || []).map(function (r) {
    return {
      id: r.id,
      title: r.title,
      link: r.link,
      ingredients: r.ingredients,
      notes: r.notes,
      hasImage: !!r.has_image,
      imageUpdatedAt: r.image_updated_at
    };
  });
}

// --------------------------------------------------------------- pantry
//
// The pantry domain: `groups.is_pantry = 1`. Everything below scopes to it, and
// every meal query scopes AWAY from it, because the split is the whole point --
// protein, sides and raw salads are planned, bought and cooked; the pantry is
// counted, and a count is what decides when to buy more of it. An item is in one
// domain or the other, never both: one row, one identity, one history.

// Items at or below their reorder level: the household's own statement that
// something needs buying. `stock IS NOT NULL` is what separates "there is one
// left" from "nobody counts this", so an untracked item is never pulled in.
// Scoped to the pantry: a chicken thigh has no shelf count and never will.
export async function getLowStockItemIds(env) {
  const sql = 'SELECT i.id FROM items i ' +
    'JOIN subgroups s ON s.id = i.subgroup_id AND s.deleted_at IS NULL ' +
    'JOIN groups g ON g.id = s.group_id AND g.deleted_at IS NULL ' +
    'WHERE i.deleted_at IS NULL AND g.is_pantry = 1 ' +
    'AND i.stock IS NOT NULL AND i.stock < i.stock_min';
  const rows = await env.DB.prepare(sql).all();
  return (rows.results || []).map(function (r) { return r.id; });
}

/** True when this item lives in the pantry domain. Every write that touches a
 * count asks this first: the stock screen must not be able to put a number on a
 * meal ingredient, and a meal screen must not be able to read one. */
export async function isPantryItem(env, itemId) {
  const row = await env.DB.prepare(
    'SELECT g.is_pantry AS is_pantry FROM items i ' +
    'JOIN subgroups s ON s.id = i.subgroup_id ' +
    'JOIN groups g ON g.id = s.group_id ' +
    'WHERE i.id = ?1 AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND g.deleted_at IS NULL'
  ).bind(itemId).first();
  return !!row && Number(row.is_pantry) === 1;
}

/** Sets an item's count, its reorder level, or takes it out of the count
 * entirely (`stock: null`). Returns the row as the client needs it. */
export async function setItemStock(env, itemId, fields) {
  const sets = [];
  const binds = [];
  if (fields.stock !== undefined) {
    sets.push('stock = ?' + (binds.length + 1));
    binds.push(fields.stock === null ? null : fields.stock);
  }
  if (fields.stockMin !== undefined) {
    sets.push('stock_min = ?' + (binds.length + 1));
    binds.push(fields.stockMin);
  }
  if (!sets.length) return null;
  binds.push(itemId);
  await env.DB.prepare('UPDATE items SET ' + sets.join(', ') + ' WHERE id = ?' + binds.length + ' AND deleted_at IS NULL')
    .bind(...binds).run();
  const row = await env.DB.prepare('SELECT id, name, stock, stock_min FROM items WHERE id = ?1')
    .bind(itemId).first();
  if (!row) return null;
  return {
    id: row.id, name: row.name,
    stock: (row.stock === null || row.stock === undefined) ? null : Number(row.stock),
    stockMin: Number(row.stock_min),
    low: row.stock !== null && row.stock !== undefined && Number(row.stock) < Number(row.stock_min)
  };
}

/** The pantry's own catalogue: only the is_pantry groups, only their items, each
 * with the count and reorder level the screen draws. Shaped like
 * `getCatalogTree` so the client can reuse its renderer, and deliberately NOT
 * filtered by `selected` -- selecting an ingredient is a meal-planning idea. */
export async function getPantryTree(env) {
  const sql = 'SELECT g.id AS group_id, g.name AS group_name, g.sort_order AS group_sort, ' +
    's.id AS subgroup_id, s.name AS subgroup_name, s.icon AS subgroup_icon, s.sort_order AS subgroup_sort, ' +
    'i.id AS item_id, i.name AS item_name, i.notes, i.sort_order AS item_sort, i.stock, i.stock_min, ' +
    'p.price AS trip_price, p.qty AS trip_qty ' +
    'FROM groups g ' +
    'LEFT JOIN subgroups s ON s.group_id = g.id AND s.deleted_at IS NULL ' +
    'LEFT JOIN items i ON i.subgroup_id = s.id AND i.deleted_at IS NULL ' +
    'LEFT JOIN pantry_lines p ON p.item_id = i.id ' +
    'WHERE g.deleted_at IS NULL AND g.is_pantry = 1 ' +
    'ORDER BY g.sort_order, s.sort_order, i.sort_order, i.name COLLATE NOCASE';
  const rows = await env.DB.prepare(sql).all();
  const groups = [];
  const byId = {};
  for (const r of (rows.results || [])) {
    let g = byId[r.group_id];
    if (!g) { g = { id: r.group_id, name: r.group_name, isPantry: true, subgroups: [] }; byId[r.group_id] = g; groups.push(g); }
    if (r.subgroup_id === null || r.subgroup_id === undefined) continue;
    let s = g.subgroups.find(function (x) { return x.id === r.subgroup_id; });
    if (!s) { s = { id: r.subgroup_id, name: r.subgroup_name, icon: r.subgroup_icon, items: [] }; g.subgroups.push(s); }
    if (r.item_id === null || r.item_id === undefined) continue;
    s.items.push({
      id: r.item_id, name: r.item_name, notes: r.notes,
      // null = nobody counts this item (see migration 0009).
      stock: (r.stock === null || r.stock === undefined) ? null : Number(r.stock),
      stockMin: Number(r.stock_min),
      // What it costs on the CURRENT trip, if it is priced there: the unit price
      // and how many, kept apart because they are two different statements.
      tripPrice: (r.trip_price === null || r.trip_price === undefined) ? null : Number(r.trip_price),
      tripQty: (r.trip_qty === null || r.trip_qty === undefined) ? 1 : Number(r.trip_qty)
    });
  }
  return groups;
}

/** Finds or creates an item in the pantry domain. Used by the Pantry screen's
 * "add" form: a new staple (toilet paper, soap) is not a meal ingredient, so it
 * lands in a pantry subgroup and can never be drawn into a plan. */
export async function addPantryItem(env, fields) {
  const name = String(fields.name || '').trim();
  if (!name) return null;
  let subgroupId = Number(fields.subgroupId || 0);
  if (subgroupId) {
    const okSub = await env.DB.prepare(
      'SELECT s.id FROM subgroups s JOIN groups g ON g.id = s.group_id ' +
      'WHERE s.id = ?1 AND s.deleted_at IS NULL AND g.deleted_at IS NULL AND g.is_pantry = 1'
    ).bind(subgroupId).first();
    if (!okSub) subgroupId = 0;
  }
  if (!subgroupId) {
    const first = await env.DB.prepare(
      'SELECT s.id FROM subgroups s JOIN groups g ON g.id = s.group_id ' +
      'WHERE s.deleted_at IS NULL AND g.deleted_at IS NULL AND g.is_pantry = 1 ' +
      'ORDER BY s.sort_order LIMIT 1'
    ).first();
    if (!first) return null;
    subgroupId = first.id;
  }
  const maxRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE subgroup_id = ?1'
  ).bind(subgroupId).first();
  const sortOrder = Number((maxRow && maxRow.m) || 0) + 1;
  const res = await env.DB.prepare(
    "INSERT INTO items (subgroup_id, name, selected, sort_order, stock, stock_min) VALUES (?1, ?2, 0, ?3, ?4, ?5)"
  ).bind(subgroupId, name.slice(0, 80), sortOrder,
    (fields.stock === null || fields.stock === undefined || fields.stock === '') ? null : Number(fields.stock),
    Number.isFinite(Number(fields.stockMin)) && fields.stockMin !== '' ? Number(fields.stockMin) : 2).run();
  return res.meta ? res.meta.last_row_id : null;
}

/** Soft-deletes a pantry item. Same idiom as the meal catalog: nothing is erased,
 * so a week or a trip that mentioned it still reads. */
export async function deletePantryItem(env, itemId) {
  await env.DB.prepare(
    "UPDATE items SET deleted_at = datetime('now') WHERE id = ?1 AND deleted_at IS NULL"
  ).bind(itemId).run();
}

/** The pantry-domain check for a CATEGORY (a subgroup inside an `is_pantry`
 * group) -- the same rule as `isPantryItem`, one level up. The Pantry tab owns
 * its categories, so it must be able to rename and remove them; it must NOT be
 * able to reach a meal group, which is what this asks before either write. */
export async function isPantryCategory(env, subgroupId) {
  const row = await env.DB.prepare(
    'SELECT g.is_pantry AS is_pantry FROM subgroups s ' +
    'JOIN groups g ON g.id = s.group_id ' +
    'WHERE s.id = ?1 AND s.deleted_at IS NULL AND g.deleted_at IS NULL'
  ).bind(subgroupId).first();
  return !!row && Number(row.is_pantry) === 1;
}

/** Renames a pantry category, and/or changes its icon. Name and icon only: the
 * parent group is the pantry domain itself, and `slot_role` is a meal-planning
 * idea (a pantry category is never drawn into a plan). */
export async function renamePantryCategory(env, subgroupId, fields) {
  const sets = [];
  const binds = [];
  if (fields.name !== undefined) { sets.push('name = ?' + (binds.length + 1)); binds.push(fields.name); }
  if (fields.icon !== undefined) { sets.push('icon = ?' + (binds.length + 1)); binds.push(fields.icon || null); }
  if (!sets.length) return false;
  binds.push(subgroupId);
  await env.DB.prepare('UPDATE subgroups SET ' + sets.join(', ') + ' WHERE id = ?' + binds.length)
    .bind(...binds).run();
  return true;
}

/** Removes a pantry category AND the items inside it, in one action.
 *
 * Deleting the category alone is the trap this avoids: `getPantryTree` and
 * `getLowStockItemIds` both filter `s.deleted_at IS NULL`, so its items would
 * disappear from the shelves AND from the to-buy list while still holding a
 * count nobody could see or change -- a handful of orphans. Refusing while it
 * still holds items is the other option, and it makes tidying up a category of
 * ten staples a ten-step job. So the action is honest about its size instead:
 * the confirm names the count, and this returns it.
 *
 * The items' trip lines go first. A line belongs to a trip AND to an item that
 * still exists (`getPantryTripLines` joins `items.deleted_at IS NULL`), but
 * `dropEmptyPantryTrip` counts ROWS -- so leaving them would strand a trip that
 * draws nothing and can never be dropped. Returns how many items went with it. */
export async function deletePantryCategory(env, subgroupId) {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM items WHERE subgroup_id = ?1 AND deleted_at IS NULL'
  ).bind(subgroupId).first();
  const items = Number((row && row.n) || 0);
  await env.DB.prepare(
    'DELETE FROM pantry_lines WHERE item_id IN (SELECT id FROM items WHERE subgroup_id = ?1)'
  ).bind(subgroupId).run();
  await env.DB.prepare(
    "UPDATE items SET deleted_at = datetime('now') WHERE subgroup_id = ?1 AND deleted_at IS NULL"
  ).bind(subgroupId).run();
  await env.DB.prepare(
    "UPDATE subgroups SET deleted_at = datetime('now') WHERE id = ?1 AND deleted_at IS NULL"
  ).bind(subgroupId).run();
  return items;
}

// ------------------------------------------------------- pantry trips
//
// A trip is the pantry's answer to a week: you go when the shelves say so, not
// on a schedule. Prices typed on the Pantry screen belong to the trip, so a
// pushed purchase cannot be re-sent by a price left behind.

/** The trip being shopped right now: the newest one that has not been pushed.
 * Created on demand, because "which trip am I in" is not a setting -- it starts
 * when the household first types a price and ends when it is pushed. */
export async function getCurrentPantryTrip(env, create) {
  const row = await env.DB.prepare(
    'SELECT id, started_at, transaction_id, pushed_at, amount FROM pantry_trips ' +
    'WHERE pushed_at IS NULL ORDER BY id DESC LIMIT 1'
  ).first();
  if (row) return row;
  if (!create) return null;
  const res = await env.DB.prepare('INSERT INTO pantry_trips (started_at) VALUES (datetime(\'now\'))').run();
  const id = res.meta ? res.meta.last_row_id : null;
  return id ? { id: id, started_at: null, transaction_id: null, pushed_at: null, amount: null } : null;
}

/** Prices one pantry item on the current trip: how many were bought (`qty`)
 * and what ONE cost (`price`).
 *
 * `fields.price === null` clears the line (the household emptied the box), and
 * the trip is then not created on demand -- clearing cannot start a shopping.
 * Omitting a field leaves it alone, so the screen can change a quantity without
 * re-sending the unit price, and vice versa.
 *
 * A quantity with no price stores NOTHING: "I bought three" is not a purchase
 * until somebody says what one cost, and a line with no money on it would show
 * on the hand-off as a bought item for Ar 0.
 */
export async function setPantryPrice(env, itemId, fields) {
  const clearing = fields.price === null;
  if (clearing) {
    const trip = await getCurrentPantryTrip(env, false);
    if (!trip) return null;
    await env.DB.prepare('DELETE FROM pantry_lines WHERE item_id = ?1').bind(itemId).run();
    // Emptying the last price empties the trip, and an emptied trip goes with
    // its prices (see dropEmptyPantryTrip): otherwise the screen keeps an "Ar 0"
    // shopping nobody is on, and the next count looks like it continued it.
    await dropEmptyPantryTrip(env, trip.id);
    return trip.id;
  }
  const existing = await env.DB.prepare('SELECT price, qty FROM pantry_lines WHERE item_id = ?1')
    .bind(itemId).first();
  const price = fields.price === undefined
    ? (existing ? Number(existing.price) : null)
    : fields.price;
  const qty = fields.qty === undefined
    ? (existing && existing.qty !== null && existing.qty !== undefined ? Number(existing.qty) : 1)
    : fields.qty;
  if (price === null || price === undefined) {
    // No price means not bought yet. A quantity on its own records nothing AND
    // must not start a trip: "I bought five" is not money, and a trip created
    // by it would be an empty Ar 0 shopping on the screen.
    const open = await getCurrentPantryTrip(env, false);
    return open ? open.id : null;
  }
  const trip = await getCurrentPantryTrip(env, true);
  if (!trip) return null;
  await env.DB.prepare(
    "INSERT INTO pantry_lines (item_id, trip_id, price, qty, updated_at) VALUES (?1, ?2, ?3, ?4, datetime('now')) " +
    'ON CONFLICT(item_id) DO UPDATE SET trip_id = excluded.trip_id, price = excluded.price, ' +
    'qty = excluded.qty, updated_at = excluded.updated_at'
  ).bind(itemId, trip.id, price, qty).run();
  return trip.id;
}

/** Drops an UNPUSHED trip that has no priced lines left: a shopping somebody
 * walked away from. Left in place it would keep an "Ar 0" trip on the Pantry
 * screen, and make the next count look like it continued a trip nobody is on.
 *
 * A PUSHED trip is never dropped: that row is the identity of an expense that
 * exists in the budget, and losing it would let the same shopping be charged
 * twice. Returns true when a row actually went away. */
export async function dropEmptyPantryTrip(env, tripId) {
  const row = await env.DB.prepare(
    'SELECT pushed_at, (SELECT COUNT(*) FROM pantry_lines WHERE trip_id = ?1) AS n ' +
    'FROM pantry_trips WHERE id = ?1'
  ).bind(tripId).first();
  if (!row || row.pushed_at) return false;
  if (Number(row.n) > 0) return false;
  await env.DB.prepare('DELETE FROM pantry_trips WHERE id = ?1 AND pushed_at IS NULL').bind(tripId).run();
  return true;
}

/** The priced lines of a trip: what ONE costs, how many, and what the line came
 * to. The unit price and the quantity stay separate all the way to the screen
 * (so a household can correct either one); `total` is the product, computed
 * HERE so no surface has to re-do the arithmetic. `laokaPricedLines` is the meal
 * side's twin. */
export async function getPantryTripLines(env, tripId) {
  const rows = await env.DB.prepare(
    'SELECT i.id, i.name, p.price, p.qty FROM pantry_lines p ' +
    'JOIN items i ON i.id = p.item_id AND i.deleted_at IS NULL ' +
    'WHERE p.trip_id = ?1 AND p.price IS NOT NULL AND p.price > 0 ' +
    'ORDER BY i.name COLLATE NOCASE'
  ).bind(tripId).all();
  return (rows.results || []).map(function (r) {
    const qty = (r.qty === null || r.qty === undefined) ? 1 : Number(r.qty);
    const price = Number(r.price);
    return { id: r.id, name: r.name, price: price, qty: qty, total: price * qty };
  });
}

/** The last purchase that left the app: which expense it became, how much, and
 * when. The Pantry screen shows it, because "where did that go" is the same
 * question Laoka's export sheet answers for a week — and the suite reads it to
 * prove a re-save lands on the SAME expense instead of a second one. */
export async function getLastPantryTrip(env) {
  const row = await env.DB.prepare(
    "SELECT id, started_at, pushed_at, transaction_id, amount, item_count FROM pantry_trips " +
    "WHERE pushed_at IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).first();
  if (!row) return null;
  return {
    id: row.id,
    startedAt: row.started_at,
    pushedAt: row.pushed_at,
    transactionId: row.transaction_id,
    amount: (row.amount === null || row.amount === undefined) ? null : Number(row.amount),
    // A pushed trip's prices are cleared on purpose, so the line count can only
    // come from what the trip was pushed WITH -- recorded on the row itself.
    count: (row.item_count === null || row.item_count === undefined) ? null : Number(row.item_count)
  };
}

/** A pantry item write never touches a week, so the to-buy list can be rebuilt
 * from the counts alone. Kept as a named function so the rule has one home. */
export async function listPantryToBuy(env) {
  const ids = await getLowStockItemIds(env);
  if (!ids.length) return [];
  const marks = ids.map(function () { return '?'; }).join(',');
  const rows = await env.DB.prepare(
    'SELECT i.id, i.name, i.stock, i.stock_min, p.price AS trip_price, p.qty AS trip_qty ' +
    'FROM items i LEFT JOIN pantry_lines p ON p.item_id = i.id ' +
    'WHERE i.id IN (' + marks + ') ORDER BY i.name COLLATE NOCASE'
  ).bind(...ids).all();
  return (rows.results || []).map(function (r) {
    const qty = (r.trip_qty === null || r.trip_qty === undefined) ? 1 : Number(r.trip_qty);
    return {
      id: r.id, name: r.name, stock: Number(r.stock), stockMin: Number(r.stock_min),
      tripPrice: (r.trip_price === null || r.trip_price === undefined) ? null : Number(r.trip_price),
      tripQty: qty,
      // What this line of the trip comes to, so the screen never multiplies and
      // the total on it cannot disagree with the total that reaches the budget.
      tripTotal: (r.trip_price === null || r.trip_price === undefined) ? null : Number(r.trip_price) * qty
    };
  });
}

// ------------------------------------------------------------ wishlists

export async function listPlans(env, weekId) {
  const rows = await env.DB.prepare(
    'SELECT id, label, is_selected FROM plans WHERE week_id = ?1 ORDER BY id'
  ).bind(weekId).all();
  return rows.results || [];
}

export async function getSelectedPlan(env, weekId) {
  return await env.DB.prepare(
    'SELECT id, label, is_selected FROM plans WHERE week_id = ?1 AND is_selected = 1'
  ).bind(weekId).first();
}

export async function insertPlan(env, weekId, label, days, gourmetIds) {
  const planRow = await env.DB.prepare('INSERT INTO plans (week_id, label) VALUES (?1, ?2)')
    .bind(weekId, label).run();
  const planId = planRow.meta.last_row_id;

  const dayStatements = [];
  for (const day of days) {
    dayStatements.push(
      env.DB.prepare('INSERT INTO plan_days (plan_id, day_date, day_type, gourmet_id, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(planId, day.date, day.dayType, day.gourmetId, days.indexOf(day))
    );
  }
  const inserted = await env.DB.batch(dayStatements);

  const slotStatements = [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    if (day.dayType !== 'normal') continue;
    const dayId = inserted[i].meta.last_row_id;
    for (const role of ['protein', 'side', 'salad']) {
      slotStatements.push(
        env.DB.prepare('INSERT INTO plan_day_items (plan_day_id, slot, item_id) VALUES (?1, ?2, ?3)')
          .bind(dayId, role, day.slots[role])
      );
    }
  }
  if (slotStatements.length) await env.DB.batch(slotStatements);
  return planId;
}

export async function selectPlan(env, weekId, planId) {
  await env.DB.batch([
    env.DB.prepare('UPDATE plans SET is_selected = 0 WHERE week_id = ?1').bind(weekId),
    env.DB.prepare('UPDATE plans SET is_selected = 1 WHERE id = ?1 AND week_id = ?2').bind(planId, weekId)
  ]);
}

export async function discardUnselectedPlans(env, weekId) {
  await env.DB.prepare('DELETE FROM plans WHERE week_id = ?1 AND is_selected = 0').bind(weekId).run();
}

// -------------------------------------------------------------- reading

export async function getPlanDays(env, planId) {
  const sql = 'SELECT d.id, d.day_date, d.day_type, d.gourmet_id, g.title AS gourmet_title, ' +
    'g.link AS gourmet_link, g.ingredients AS gourmet_ingredients, ' +
    'g.image_updated_at AS gourmet_image_at ' +
    'FROM plan_days d LEFT JOIN gourmet g ON g.id = d.gourmet_id ' +
    'WHERE d.plan_id = ?1 ORDER BY d.day_date';
  const dayRows = await env.DB.prepare(sql).bind(planId).all();
  const days = (dayRows.results || []).map(function (d) {
    return {
      id: d.id,
      date: d.day_date,
      type: d.day_type,
      gourmetId: d.gourmet_id,
      gourmetTitle: d.gourmet_title,
      gourmetLink: d.gourmet_link,
      gourmetIngredients: d.gourmet_ingredients,
      gourmetImageAt: d.gourmet_image_at,
      slots: {}
    };
  });
  if (!days.length) return days;

  const slotSql = 'SELECT di.plan_day_id, di.slot, di.item_id, i.name AS item_name, ' +
    's.id AS subgroup_id, s.name AS subgroup_name, s.icon AS subgroup_icon, s.slot_role, ' +
    'gr.id AS group_id, gr.name AS group_name ' +
    'FROM plan_day_items di ' +
    'LEFT JOIN items i ON i.id = di.item_id ' +
    'LEFT JOIN subgroups s ON s.id = i.subgroup_id ' +
    'LEFT JOIN groups gr ON gr.id = s.group_id ' +
    'WHERE di.plan_day_id IN (SELECT id FROM plan_days WHERE plan_id = ?1)';
  const slotRows = await env.DB.prepare(slotSql).bind(planId).all();

  const index = new Map();
  for (const d of days) index.set(d.id, d);
  for (const r of (slotRows.results || [])) {
    const day = index.get(r.plan_day_id);
    if (!day) continue;
    day.slots[r.slot] = r.item_id === null ? null : {
      itemId: r.item_id,
      name: r.item_name,
      subgroupId: r.subgroup_id,
      subgroupName: r.subgroup_name,
      icon: r.subgroup_icon || '',
      slotRole: r.slot_role,
      groupId: r.group_id,
      groupName: r.group_name
    };
  }
  return days;
}

export async function getShoppingLines(env, weekId) {
  const sql = 'SELECT l.id, l.item_id, l.origin, l.price, i.name AS item_name, ' +
    's.id AS subgroup_id, s.name AS subgroup_name, s.slot_role, gr.id AS group_id, gr.name AS group_name, ' +
    'gr.sort_order AS group_sort, gr.is_pantry ' +
    'FROM shopping_lines l ' +
    'JOIN items i ON i.id = l.item_id ' +
    'JOIN subgroups s ON s.id = i.subgroup_id ' +
    'JOIN groups gr ON gr.id = s.group_id ' +
    'WHERE l.week_id = ?1 ' +
    'ORDER BY gr.sort_order, gr.id, i.name COLLATE NOCASE';
  const rows = await env.DB.prepare(sql).bind(weekId).all();
  return (rows.results || []).map(function (r) {
    return {
      id: r.id,
      itemId: r.item_id,
      name: r.item_name,
      groupId: r.group_id,
      groupName: r.group_name,
      subgroupName: r.subgroup_name,
      slotRole: r.slot_role,
      isPantry: !!r.is_pantry,
      origin: r.origin,
      price: r.price,
      bought: r.price !== null && r.price > 0,
      count: 0
    };
  });
}

export async function getPlanItemCounts(env, planId) {
  const sql = 'SELECT di.item_id, COUNT(*) AS n FROM plan_day_items di ' +
    'JOIN plan_days d ON d.id = di.plan_day_id ' +
    'WHERE d.plan_id = ?1 AND di.item_id IS NOT NULL GROUP BY di.item_id';
  const rows = await env.DB.prepare(sql).bind(planId).all();
  const counts = {};
  for (const r of (rows.results || [])) counts[r.item_id] = r.n;
  return counts;
}

// Rebuilds the week shopping lines from the saved plan alone, preserving the
// price of every line that survives. An item swapped out of its last day loses
// its line and its price, exactly as the spec requires.
//
// The pantry is NOT part of this, and must not be folded back in: its items are
// not planned, they are not bought on the week's rhythm, and they are not in the
// week's expense. A shelf that needs restocking appears on the PANTRY list, from
// `stock < stock_min`; the week's list answers a different question (what does
// this week's cooking need?).
export async function syncShoppingLines(env, weekId) {
  const plan = await getSelectedPlan(env, weekId);
  const desired = new Map();

  if (plan) {
    const counts = await getPlanItemCounts(env, plan.id);
    for (const itemId of Object.keys(counts)) desired.set(Number(itemId), 'plan');
  }

  const existing = await env.DB.prepare('SELECT id, item_id, origin FROM shopping_lines WHERE week_id = ?1')
    .bind(weekId).all();
  const current = new Map();
  for (const r of (existing.results || [])) current.set(r.item_id, r);

  const statements = [];
  for (const [itemId, origin] of desired) {
    const row = current.get(itemId);
    if (!row) {
      statements.push(env.DB.prepare('INSERT INTO shopping_lines (week_id, item_id, origin) VALUES (?1, ?2, ?3)')
        .bind(weekId, itemId, origin));
    } else if (row.origin !== origin) {
      statements.push(env.DB.prepare('UPDATE shopping_lines SET origin = ?1 WHERE id = ?2').bind(origin, row.id));
    }
  }
  for (const [itemId, row] of current) {
    if (!desired.has(itemId)) {
      statements.push(env.DB.prepare('DELETE FROM shopping_lines WHERE id = ?1').bind(row.id));
    }
  }
  if (statements.length) await env.DB.batch(statements);
  return statements.length;
}

/** The week the household is shopping for: the newest one that is not
 * archived. Falls back to null on an empty database. */
export async function getCurrentWeekId(env) {
  const row = await env.DB.prepare(
    "SELECT id FROM weeks WHERE status != 'archived' ORDER BY start_date DESC LIMIT 1"
  ).first();
  return row ? row.id : null;
}

export function summarise(lines) {
  let total = 0;
  let priced = 0;
  for (const l of lines) {
    if (l.price !== null && l.price !== undefined && l.price > 0) {
      total += l.price;
      priced++;
    }
  }
  // Bought and priced are the same thing: a price is the only way to mark a
  // line as picked up.
  return {
    total: total,
    priced: priced,
    bought: priced,
    count: lines.length,
    remaining: lines.length - priced,
    unpricedBought: 0
  };
}

export async function buildWeekState(env, week, now) {
  const plan = await getSelectedPlan(env, week.id);
  const today = todayInNairobi(now);

  let days = [];
  let counts = {};
  if (plan) {
    days = await getPlanDays(env, plan.id);
    counts = await getPlanItemCounts(env, plan.id);
  }
  const settled = !!week.confirmed_at;
  for (const d of days) {
    // While the week is still a template every day can change, which is what
    // makes it usable in a shop. Confirming locks only what has passed.
    d.editable = settled ? d.date >= today : true;
    d.dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
      new Date(d.date + 'T00:00:00Z').getUTCDay()
    ];
    if (d.type === 'gourmet') {
      d.slots = null;
    } else {
      for (const role of ['protein', 'side', 'salad']) {
        if (!(role in d.slots)) d.slots[role] = null;
      }
    }
  }

  const lines = await getShoppingLines(env, week.id);
  for (const l of lines) l.count = counts[l.itemId] || 0;
  const totals = summarise(lines);

  // An unsaved candidate has no shopping list yet, so its days are the only
  // way to see what it proposes. They must travel with it.
  const planRows = await listPlans(env, week.id);
  const candidates = [];
  for (const p of planRows) {
    const isSelected = !!p.is_selected;
    candidates.push({
      id: p.id,
      label: p.label,
      isSelected: isSelected,
      // The saved plan's days are already loaded above; fetching them again
      // here cost two queries on every state read.
      days: isSelected ? days : await getPlanDays(env, p.id)
    });
  }

  return {
    week: {
      id: week.id,
      startDate: week.start_date,
      endDate: week.end_date,
      status: week.status,
      budget: week.budget === null || week.budget === undefined ? null : Number(week.budget),
      exportedAt: week.exported_at,
      updatedAt: week.updated_at,
      confirmedAt: week.confirmed_at || null,
      today: today,
      // The exact name the download will carry, so a preview cannot drift from
      // what the browser actually saves.
      exportName: exportFilename(week.start_date, week.end_date)
    },
    planId: plan ? plan.id : null,
    candidates: candidates,
    days: days,
    shopping: lines,
    totals: totals
  };
}
