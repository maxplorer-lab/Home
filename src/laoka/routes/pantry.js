// Pantry. The second domain, and the second shopping list.
//
// Two facts live here, and they are deliberately different kinds:
//
//   A COUNT (`stock`, `stock_min`) is a statement about the SHELF. It belongs to
//   the item and survives every shopping trip. Nothing in this app decrements or
//   increments it on its own: no plan eats a shelf, no purchase tops it up. The
//   household counts, and the house answers.
//
//   A PRICE belongs to a TRIP. It is what this shopping cost, not what the item
//   costs, which is why it lives on `pantry_lines` and not on `items` -- and why
//   pushing a trip clears it.
//
// So: counting down changes what is on the to-buy list immediately (derived, not
// stored); pricing changes the trip's total; pushing the trip is the only thing
// that reaches the budget.
//
// Another domain rule lives here too: every write asks `isPantryItem` first. The
// screen must not be able to put a count on a chicken thigh, and a meal screen
// must not be able to read one.

import { ok, fail, readJson } from '../lib/http.js';
import {
  getPantryTree, listPantryToBuy, getCurrentPantryTrip, getPantryTripLines, getLastPantryTrip,
  setItemStock, isPantryItem, addPantryItem, deletePantryItem, setPantryPrice, dropEmptyPantryTrip,
  isPantryCategory, renamePantryCategory, deletePantryCategory
} from '../data/queries.js';

// A count is a small non-negative number of things (2.5 kg of rice is real, so
// fractions are allowed; 1e9 is not a pantry).
const MAX_STOCK = 10000;
// Prices are whole Ariary in practice; the ceiling only exists to reject a typo
// that would push a nonsensical expense into the budget.
const MAX_PRICE = 100000000;
// How many of one thing a single shopping trip can contain. A limit, not a
// rule: it is there so a slipped keystroke cannot turn "2" into 200000 and
// multiply the trip's total by it (the price ceiling alone would not catch that,
// because the price is not what got mistyped).
const MAX_QTY = 10000;

function readAmount(value, max, allowNull) {
  if (value === null || value === '' || value === undefined) return { ok: allowNull, value: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) return { ok: false };
  return { ok: true, value: n };
}

/** The whole screen, in one payload: the shelves, what is below its reorder
 * level, and where the current trip stands. Every write answers with this, so a
 * client never has to guess what changed -- it redraws from the answer. */
async function pantryPayload(env) {
  const trip = await getCurrentPantryTrip(env, false);
  let lines = [];
  if (trip) lines = await getPantryTripLines(env, trip.id);
  // The LINE totals, not the unit prices: a line is what was bought (quantity)
  // at what one cost, and the trip's total has to be the money actually spent.
  const total = lines.reduce(function (n, l) { return n + l.total; }, 0);
  return {
    pantry: await getPantryTree(env),
    toBuy: await listPantryToBuy(env),
    lastTrip: await getLastPantryTrip(env),
    trip: trip ? {
      id: trip.id,
      startedAt: trip.started_at,
      pushedAt: trip.pushed_at || null,
      transactionId: trip.transaction_id || null,
      count: lines.length,
      total: total,
      lines: lines
    } : null
  };
}

export default [
  {
    method: 'GET',
    pattern: '/api/pantry',
    handler: async function (ctx) {
      return ok(await pantryPayload(ctx.env));
    }
  },
  {
    method: 'POST',
    pattern: '/api/pantry/items',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const name = String(body.name || '').trim();
      if (!name) return fail(400, 'a name is required');
      const stock = readAmount(body.stock, MAX_STOCK, true);
      if (!stock.ok) return fail(400, 'stock must be a number between 0 and ' + MAX_STOCK);
      const min = readAmount(body.stockMin, MAX_STOCK, false);
      if (!min.ok) return fail(400, 'a reorder level must be a number between 0 and ' + MAX_STOCK);
      const id = await addPantryItem(ctx.env, {
        name: name, subgroupId: body.subgroupId, stock: stock.value, stockMin: min.value
      });
      if (!id) return fail(400, 'a usable pantry category is required');
      return ok(await pantryPayload(ctx.env));
    }
  },
  {
    method: 'PATCH',
    pattern: '/api/pantry/items/:id',
    handler: async function (ctx) {
      const itemId = Number(ctx.params.id);
      if (!itemId) return fail(400, 'a numeric item id is required');
      if (!await isPantryItem(ctx.env, itemId)) return fail(404, 'no such pantry item');
      const body = (await readJson(ctx.request)) || {};

      const fields = {};
      if (body.stock !== undefined) {
        const amount = readAmount(body.stock, MAX_STOCK, true);
        if (!amount.ok) return fail(400, 'stock must be a number between 0 and ' + MAX_STOCK);
        fields.stock = amount.value;
      }
      if (body.stockMin !== undefined) {
        const min = readAmount(body.stockMin, MAX_STOCK, false);
        if (!min.ok || min.value === null) return fail(400, 'a reorder level must be a number between 0 and ' + MAX_STOCK);
        fields.stockMin = min.value;
      }
      if (!Object.keys(fields).length) return fail(400, 'nothing to update');

      const item = await setItemStock(ctx.env, itemId, fields);
      if (!item) return fail(404, 'no such pantry item');
      const payload = await pantryPayload(ctx.env);
      payload.item = item;
      return ok(payload);
    }
  },
  {
    method: 'POST',
    pattern: '/api/pantry/items/:id/delete',
    handler: async function (ctx) {
      const itemId = Number(ctx.params.id);
      if (!itemId) return fail(400, 'a numeric item id is required');
      if (!await isPantryItem(ctx.env, itemId)) return fail(404, 'no such pantry item');
      await deletePantryItem(ctx.env, itemId);
      return ok(await pantryPayload(ctx.env));
    }
  },
  {
    method: 'PATCH',
    pattern: '/api/pantry/trip',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const itemId = Number(body.itemId || 0);
      if (!itemId) return fail(400, 'a numeric item id is required');
      if (!await isPantryItem(ctx.env, itemId)) return fail(404, 'no such pantry item');
      // Both halves of a line are optional, and each is left alone when it is
      // absent: the screen can correct a quantity without re-sending the unit
      // price (and the other way round). An explicitly null price still means
      // "clear this line", which is how a box emptied on the screen clears it.
      const hasPrice = Object.prototype.hasOwnProperty.call(body, 'price');
      const hasQty = Object.prototype.hasOwnProperty.call(body, 'qty');
      if (!hasPrice && !hasQty) return fail(400, 'nothing to update');
      const fields = {};
      if (hasPrice) {
        const price = readAmount(body.price, MAX_PRICE, true);
        if (!price.ok) return fail(400, 'a price must be a number between 0 and ' + MAX_PRICE);
        fields.price = price.value;
      }
      if (hasQty) {
        const qty = readAmount(body.qty, MAX_QTY, false);
        if (!qty.ok) return fail(400, 'a quantity must be a number between 0 and ' + MAX_QTY);
        fields.qty = qty.value;
      }
      await setPantryPrice(ctx.env, itemId, fields);
      return ok(await pantryPayload(ctx.env));
    }
  },
  {
    // Renaming a CATEGORY. The categories live in `subgroups`, the same table
    // the meal catalog uses, so this is deliberately not routed through
    // /api/subgroups: that handler knows nothing about the pantry boundary, and
    // the Pantry tab must not be able to rename a meal group by guessing its id.
    method: 'PATCH',
    pattern: '/api/pantry/categories/:id',
    handler: async function (ctx) {
      const id = Number(ctx.params.id);
      if (!id) return fail(400, 'a numeric category id is required');
      if (!await isPantryCategory(ctx.env, id)) return fail(404, 'no such pantry category');
      const body = (await readJson(ctx.request)) || {};
      const name = String(body.name === undefined ? '' : body.name).trim().slice(0, 60);
      if (!name) return fail(400, 'a name is required');
      const fields = { name: name };
      if (body.icon !== undefined) fields.icon = String(body.icon).trim().slice(0, 8);
      await renamePantryCategory(ctx.env, id, fields);
      return ok(await pantryPayload(ctx.env));
    }
  },
  {
    // Removing a category takes its items with it -- see deletePantryCategory
    // for why (the alternative is a shelf of invisible counts). The payload says
    // how many went, so the screen can be honest about what it just did.
    method: 'POST',
    pattern: '/api/pantry/categories/:id/delete',
    handler: async function (ctx) {
      const id = Number(ctx.params.id);
      if (!id) return fail(400, 'a numeric category id is required');
      if (!await isPantryCategory(ctx.env, id)) return fail(404, 'no such pantry category');
      const items = await deletePantryCategory(ctx.env, id);
      // Those items are gone from every surface, so a trip they were priced on
      // has to be re-checked: an emptied one is dropped, exactly as clearing the
      // last price does.
      const trip = await getCurrentPantryTrip(ctx.env, false);
      if (trip) await dropEmptyPantryTrip(ctx.env, trip.id);
      const payload = await pantryPayload(ctx.env);
      payload.removed = { categoryId: id, items: items };
      return ok(payload);
    }
  },
  {
    // Clear the trip's prices without pushing: a half-typed list somebody wants
    // to walk away from. The counts are untouched, so the to-buy list is exactly
    // as it was -- only the money goes.
    method: 'POST',
    pattern: '/api/pantry/trip/clear',
    handler: async function (ctx) {
      const trip = await getCurrentPantryTrip(ctx.env, false);
      if (trip) {
        const lines = await getPantryTripLines(ctx.env, trip.id);
        for (const l of lines) await setPantryPrice(ctx.env, l.id, { price: null });
        // …and the emptied trip goes with the prices. See dropEmptyPantryTrip:
        // a pushed trip is kept, an abandoned one is not.
        await dropEmptyPantryTrip(ctx.env, trip.id);
      }
      return ok(await pantryPayload(ctx.env));
    }
  }
];
