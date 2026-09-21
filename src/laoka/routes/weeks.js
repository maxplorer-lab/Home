// Week lifecycle: open, generate wishlists, save one, swap slots, archive.

import { ok, fail, readJson, toInt } from '../lib/http.js';
import { notifyAsync } from '../lib/notify.js';
import { generatePlan } from '../lib/generate.js';
import { weekDates, todayInNairobi } from '../lib/dates.js';
import {
  getWeekById, getWeekByStart, getSelectedPlan, insertPlan, selectPlan,
  discardUnselectedPlans, syncShoppingLines, buildWeekState, touchWeek,
  getSelectedPools, getGourmetIds, getSettings, listWeeks, listPlans
} from '../data/queries.js';

const SLOT_ROLES = ['protein', 'side', 'salad'];

async function stateFor(env, week) {
  return buildWeekState(env, week, undefined);
}

export default [
  {
    method: 'GET',
    pattern: '/api/state',
    handler: async function (ctx) {
      const weekId = toInt(ctx.url.searchParams.get('week'));
      if (!weekId) return fail(400, 'a week id is required');
      const week = await getWeekById(ctx.env, weekId);
      if (!week) return fail(404, 'no such week');
      return ok(await stateFor(ctx.env, week));
    }
  },
  {
    method: 'GET',
    pattern: '/api/weeks',
    handler: async function (ctx) {
      return ok({ weeks: await listWeeks(ctx.env) });
    }
  },

  // Opens the week for a start date, or returns the one that already exists.
  // At most two weeks may be open at once.
  {
    method: 'POST',
    pattern: '/api/weeks',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const startDate = String(body.startDate || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return fail(400, 'a start date of the form YYYY-MM-DD is required');

      const existing = await getWeekByStart(ctx.env, startDate);
      if (existing) {
        if (existing.status === 'archived') {
          return fail(409, 'the week of ' + startDate + ' was archived, so it cannot be reopened. Start a later week instead.');
        }
        return ok(await stateFor(ctx.env, existing));
      }

      const settings = await getSettings(ctx.env);
      const open = await listWeeks(ctx.env);
      const maxOpen = Number(settings.max_active_weeks || 2);
      if (open.length >= maxOpen) {
        return fail(409, 'at most ' + maxOpen + ' weeks can be open at once; archive one first');
      }

      const endDate = weekDates(startDate)[6];
      const inserted = await ctx.env.DB.prepare(
        "INSERT INTO weeks (start_date, end_date, status) VALUES (?1, ?2, 'planning')"
      ).bind(startDate, endDate).run();
      const week = await getWeekById(ctx.env, inserted.meta.last_row_id);
      notifyAsync(ctx, { weekId: week.id, updatedAt: week.updated_at });
      return ok(await stateFor(ctx.env, week));
    }
  },

  // Produces a fresh set of candidate wishlists. Allowed before a save, and
  // afterwards only while no price has been entered.
  {
    method: 'POST',
    pattern: '/api/weeks/:id/generate',
    handler: async function (ctx) {
      const weekId = toInt(ctx.params.id);
      const week = await getWeekById(ctx.env, weekId);
      if (!week) return fail(404, 'no such week');
      if (week.status === 'archived') return fail(409, 'that week is archived');
      if (week.confirmed_at) return fail(409, 'that week is confirmed, so it is settled. Swap single days instead.');

      // Generating is free. It produces a draft to look at and leaves the saved
      // plan, its shopping list and every recorded price exactly as they were,
      // so the household can reroll as often as it likes without risk.
      const pools = await getSelectedPools(ctx.env);
      const gourmetIds = await getGourmetIds(ctx.env);
      const dates = weekDates(week.start_date);

      await ctx.env.DB.prepare('DELETE FROM plans WHERE week_id = ?1 AND is_selected = 0').bind(weekId).run();
      await ctx.env.DB.prepare('UPDATE weeks SET generation = generation + 1 WHERE id = ?1').bind(weekId).run();

      // Exactly one candidate at a time. Pressing Generate again replaces it
      // and the counter moves on, so the family sees Wishlist 1, then
      // Wishlist 2, never a wall of options.
      const numbered = await getWeekById(ctx.env, weekId);
      const days = generatePlan({ dates: dates, pools: pools, gourmetIds: gourmetIds, rand: Math.random });
      await insertPlan(ctx.env, weekId, 'Wishlist ' + numbered.generation, days, gourmetIds);

      await touchWeek(ctx.env, weekId);
      const fresh = await getWeekById(ctx.env, weekId);
      notifyAsync(ctx, { weekId: weekId, updatedAt: fresh.updated_at });
      return ok(await stateFor(ctx.env, fresh));
    }
  },

  {
    method: 'POST',
    pattern: '/api/weeks/:id/save',
    handler: async function (ctx) {
      const weekId = toInt(ctx.params.id);
      const week = await getWeekById(ctx.env, weekId);
      if (!week) return fail(404, 'no such week');
      if (week.confirmed_at) return fail(409, 'that week is confirmed, so it is settled. Swap single days instead.');

      const body = (await readJson(ctx.request)) || {};
      const planId = toInt(body.planId);
      if (!planId) return fail(400, 'a wishlist id is required');

      const plans = await listPlans(ctx.env, weekId);
      if (!plans.some(function (p) { return p.id === planId; })) {
        return fail(404, 'that wishlist does not belong to this week');
      }

      // Prices are not a reason to refuse a save. syncShoppingLines keeps the
      // price of every line that survives the change, and the client warns
      // about the ones that will not.
      await selectPlan(ctx.env, weekId, planId);
      await discardUnselectedPlans(ctx.env, weekId);
      await syncShoppingLines(ctx.env, weekId);
      await ctx.env.DB.prepare("UPDATE weeks SET status = 'active' WHERE id = ?1").bind(weekId).run();
      await touchWeek(ctx.env, weekId);

      const fresh = await getWeekById(ctx.env, weekId);
      notifyAsync(ctx, { weekId: weekId, updatedAt: fresh.updated_at });
      return ok(await stateFor(ctx.env, fresh));
    }
  },

  // Settles the week. Until this happens the saved plan is a template that can
  // still be changed anywhere; afterwards only today and later.
  {
    method: 'POST',
    pattern: '/api/weeks/:id/confirm',
    handler: async function (ctx) {
      const weekId = toInt(ctx.params.id);
      const week = await getWeekById(ctx.env, weekId);
      if (!week) return fail(404, 'no such week');
      if (week.status === 'archived') return fail(409, 'that week is archived');
      if (week.confirmed_at) return fail(409, 'that week is already confirmed');

      const plan = await getSelectedPlan(ctx.env, weekId);
      if (!plan) return fail(409, 'save the draft for this week before confirming it');

      await ctx.env.DB.prepare("UPDATE weeks SET confirmed_at = datetime('now') WHERE id = ?1").bind(weekId).run();
      await touchWeek(ctx.env, weekId);
      const fresh = await getWeekById(ctx.env, weekId);
      notifyAsync(ctx, { weekId: weekId, updatedAt: fresh.updated_at });
      return ok(await stateFor(ctx.env, fresh));
    }
  },

  // Throws away the unsaved draft, leaving the saved plan alone.
  {
    method: 'DELETE',
    pattern: '/api/weeks/:id/candidates',
    handler: async function (ctx) {
      const weekId = toInt(ctx.params.id);
      const week = await getWeekById(ctx.env, weekId);
      if (!week) return fail(404, 'no such week');
      await discardUnselectedPlans(ctx.env, weekId);
      await touchWeek(ctx.env, weekId);
      const fresh = await getWeekById(ctx.env, weekId);
      notifyAsync(ctx, { weekId: weekId, updatedAt: fresh.updated_at });
      return ok(await stateFor(ctx.env, fresh));
    }
  },

  // Forgets the saved plan entirely — the way back out of "this is the
  // template".
  //
  // A template is only a proposal: it is unconfirmed, so nothing about it is
  // settled and throwing it away must leave no trace behind. The week row stays
  // (its start date is the slot the plan occupies, and re-opening it must return
  // the same week rather than a second one) but goes back to 'planning' with no
  // plan at all, so the list it produced is rebuilt from nothing — this week
  // planned nothing, and the pantry is not part of a week's list at all.
  {
    method: 'DELETE',
    pattern: '/api/weeks/:id/plan',
    handler: async function (ctx) {
      const weekId = toInt(ctx.params.id);
      const week = await getWeekById(ctx.env, weekId);
      if (!week) return fail(404, 'no such week');
      if (week.status === 'archived') return fail(409, 'that week is archived, so it is history. Start a later week instead.');
      if (week.confirmed_at) {
        return fail(409, 'that week is confirmed, so it is settled. Archive it, or swap single days instead.');
      }

      // Every plan goes, not just the selected one. A leftover draft belongs to
      // the same proposal and would otherwise reappear as a wishlist the moment
      // the week is looked at again.
      await ctx.env.DB.prepare('DELETE FROM plans WHERE week_id = ?1').bind(weekId).run();
      // exported_at described a file that came from this plan, and generation
      // only ever named wishlists drawn from it. Both are forgotten with it.
      await ctx.env.DB.prepare("UPDATE weeks SET status = 'planning', exported_at = NULL, generation = 0 WHERE id = ?1")
        .bind(weekId).run();
      // With no selected plan this leaves an empty list: every line here came
      // from the plan. (A week created before the pantry split may still carry
      // lines marked 'pantry'; they are ordinary rows here and go with the rest.)
      await syncShoppingLines(ctx.env, weekId);
      await touchWeek(ctx.env, weekId);
      const fresh = await getWeekById(ctx.env, weekId);
      notifyAsync(ctx, { weekId: weekId, updatedAt: fresh.updated_at, kind: 'lines' });
      return ok(await stateFor(ctx.env, fresh));
    }
  },
  {
    method: 'PATCH',
    pattern: '/api/weeks/:id',
    handler: async function (ctx) {
      const weekId = toInt(ctx.params.id);
      const week = await getWeekById(ctx.env, weekId);
      if (!week) return fail(404, 'no such week');
      const body = (await readJson(ctx.request)) || {};

      if (body.budget !== undefined) {
        const raw = body.budget;
        const budget = raw === null || raw === '' ? null : Math.max(0, toInt(raw) || 0);
        await ctx.env.DB.prepare('UPDATE weeks SET budget = ?1 WHERE id = ?2').bind(budget, weekId).run();
      }
      await touchWeek(ctx.env, weekId);
      const fresh = await getWeekById(ctx.env, weekId);
      notifyAsync(ctx, { weekId: weekId, updatedAt: fresh.updated_at });
      return ok(await stateFor(ctx.env, fresh));
    }
  },

  // Per-day manual swap.
  //
  // Works on a saved plan and on an unsaved draft. A draft is worth editing
  // precisely because random draws produce unlikely pairings, and fixing them
  // before saving is cheaper than fixing them afterwards. The lock on past days
  // applies only to the saved plan, since a draft records nothing yet.
  {
    method: 'PATCH',
    pattern: '/api/days/:id/slot',
    handler: async function (ctx) {
      const dayId = toInt(ctx.params.id);
      const body = (await readJson(ctx.request)) || {};
      const slot = String(body.slot || '');
      if (SLOT_ROLES.indexOf(slot) === -1) return fail(400, 'slot must be protein, side or salad');

      const day = await ctx.env.DB.prepare(
        'SELECT d.id, d.day_date, d.day_type, d.plan_id, p.week_id, p.is_selected FROM plan_days d ' +
        'JOIN plans p ON p.id = d.plan_id WHERE d.id = ?1'
      ).bind(dayId).first();
      if (!day) return fail(404, 'no such day');

      const week = await getWeekById(ctx.env, day.week_id);
      if (!week || week.status === 'archived') return fail(409, 'that week is archived');
      if (day.day_type !== 'normal') return fail(400, 'gourmet days have no slots');

      // A template is fully editable, which is what makes it usable while
      // shopping. Once the week is confirmed, only today and later.
      const today = todayInNairobi();
      if (day.is_selected && week.confirmed_at && day.day_date < today) {
        return fail(403, 'that day is in the past and the week is confirmed');
      }

      const itemId = body.itemId === null || body.itemId === undefined || body.itemId === '' ? null : toInt(body.itemId);
      if (itemId !== null) {
        const item = await ctx.env.DB.prepare(
          'SELECT i.id, s.slot_role FROM items i JOIN subgroups s ON s.id = i.subgroup_id ' +
          'WHERE i.id = ?1 AND i.deleted_at IS NULL AND s.deleted_at IS NULL'
        ).bind(itemId).first();
        if (!item) return fail(404, 'no such item');
        if (item.slot_role !== slot) {
          return fail(400, 'that item belongs to a ' + item.slot_role + ' slot, not a ' + slot + ' slot');
        }
      }

      await ctx.env.DB.prepare('UPDATE plan_day_items SET item_id = ?1 WHERE plan_day_id = ?2 AND slot = ?3')
        .bind(itemId, dayId, slot).run();
      // Only the saved plan owns the shopping list. Syncing for a draft would
      // rebuild the list from a plan that is not selected, wiping it.
      if (day.is_selected) await syncShoppingLines(ctx.env, day.week_id);
      await touchWeek(ctx.env, day.week_id);

      const fresh = await getWeekById(ctx.env, day.week_id);
      notifyAsync(ctx, { weekId: day.week_id, updatedAt: fresh.updated_at, kind: 'lines' });
      return ok(await stateFor(ctx.env, fresh));
    }
  },

  // Trades the meals between two days.
  //
  // Some combinations take longer to cook than others, so a meal that is fine
  // in principle can still land on the wrong evening. Swapping the slots rather
  // than the dates keeps every day where it is, which matters because Sunday is
  // always gourmet and must not inherit a normal day's slots.
  {
    method: 'POST',
    pattern: '/api/days/:id/swap',
    handler: async function (ctx) {
      const fromId = toInt(ctx.params.id);
      const body = (await readJson(ctx.request)) || {};
      const toId = toInt(body.withDayId);
      if (!toId) return fail(400, 'the day to trade with is required');
      if (toId === fromId) return fail(400, 'a day cannot trade with itself');

      const rows = await ctx.env.DB.prepare(
        'SELECT d.id, d.day_date, d.day_type, d.plan_id, p.week_id, p.is_selected FROM plan_days d ' +
        'JOIN plans p ON p.id = d.plan_id WHERE d.id IN (?1, ?2)'
      ).bind(fromId, toId).all();
      const found = rows.results || [];
      if (found.length !== 2) return fail(404, 'both days have to exist');
      const from = found.filter(function (d) { return d.id === fromId; })[0];
      const to = found.filter(function (d) { return d.id === toId; })[0];
      if (from.plan_id !== to.plan_id) return fail(400, 'both days have to be in the same plan');
      if (from.day_type !== 'normal' || to.day_type !== 'normal') {
        return fail(400, 'only normal days can trade meals, since Sunday is always gourmet');
      }

      const week = await getWeekById(ctx.env, from.week_id);
      if (!week || week.status === 'archived') return fail(409, 'that week is archived');
      const today = todayInNairobi();
      if (from.is_selected && week.confirmed_at) {
        if (from.day_date < today || to.day_date < today) {
          return fail(403, 'a confirmed week cannot trade days that have already passed');
        }
      }

      async function slotsOf(dayId) {
        const res = await ctx.env.DB.prepare('SELECT slot, item_id FROM plan_day_items WHERE plan_day_id = ?1').bind(dayId).all();
        const out = {};
        for (const row of (res.results || [])) out[row.slot] = row.item_id;
        return out;
      }
      const mine = await slotsOf(fromId);
      const theirs = await slotsOf(toId);

      const statements = [];
      for (const slot of SLOT_ROLES) {
        statements.push(ctx.env.DB.prepare('UPDATE plan_day_items SET item_id = ?1 WHERE plan_day_id = ?2 AND slot = ?3')
          .bind(theirs[slot] === undefined ? null : theirs[slot], fromId, slot));
        statements.push(ctx.env.DB.prepare('UPDATE plan_day_items SET item_id = ?1 WHERE plan_day_id = ?2 AND slot = ?3')
          .bind(mine[slot] === undefined ? null : mine[slot], toId, slot));
      }
      await ctx.env.DB.batch(statements);

      // Trading meals leaves the week's set of items unchanged, so the shopping
      // list is the same before and after and does not need rebuilding.
      await touchWeek(ctx.env, from.week_id);
      const fresh = await getWeekById(ctx.env, from.week_id);
      notifyAsync(ctx, { weekId: from.week_id, updatedAt: fresh.updated_at, kind: 'lines' });
      return ok(await stateFor(ctx.env, fresh));
    }
  },

  // Swaps the Sunday Gourmet title, on the same rule as a slot.
  {
    method: 'PATCH',
    pattern: '/api/days/:id/gourmet',
    handler: async function (ctx) {
      const dayId = toInt(ctx.params.id);
      const body = (await readJson(ctx.request)) || {};
      const day = await ctx.env.DB.prepare(
        'SELECT d.id, d.day_date, d.day_type, p.week_id, p.is_selected FROM plan_days d ' +
        'JOIN plans p ON p.id = d.plan_id WHERE d.id = ?1'
      ).bind(dayId).first();
      if (!day) return fail(404, 'no such day');
      if (day.day_type !== 'gourmet') return fail(400, 'that day is not gourmet');

      const gourmetWeek = await getWeekById(ctx.env, day.week_id);
      if (gourmetWeek && gourmetWeek.status === 'archived') return fail(409, 'that week is archived');
      const today = todayInNairobi();
      if (day.is_selected && gourmetWeek && gourmetWeek.confirmed_at && day.day_date < today) {
        return fail(403, 'that day is in the past and the week is confirmed');
      }

      const gourmetId = body.gourmetId === null || body.gourmetId === undefined ? null : toInt(body.gourmetId);
      if (gourmetId !== null) {
        const g = await ctx.env.DB.prepare('SELECT id FROM gourmet WHERE id = ?1 AND deleted_at IS NULL').bind(gourmetId).first();
        if (!g) return fail(404, 'no such gourmet title');
      }
      await ctx.env.DB.prepare('UPDATE plan_days SET gourmet_id = ?1 WHERE id = ?2').bind(gourmetId, dayId).run();
      await touchWeek(ctx.env, day.week_id);
      const fresh = await getWeekById(ctx.env, day.week_id);
      notifyAsync(ctx, { weekId: day.week_id, updatedAt: fresh.updated_at, kind: 'lines' });
      return ok(await stateFor(ctx.env, fresh));
    }
  },

  // Freezes the week into a self-contained snapshot and closes it.
  {
    method: 'POST',
    pattern: '/api/weeks/:id/archive',
    handler: async function (ctx) {
      const weekId = toInt(ctx.params.id);
      const week = await getWeekById(ctx.env, weekId);
      if (!week) return fail(404, 'no such week');
      if (week.status === 'archived') return fail(409, 'that week is already archived');

      const plan = await getSelectedPlan(ctx.env, weekId);
      if (!plan) return fail(409, 'save a wishlist before archiving this week');

      const existing = await ctx.env.DB.prepare('SELECT id FROM history_weeks WHERE source_week_id = ?1').bind(weekId).first();
      if (existing) return fail(409, 'that week already has a snapshot');

      const hist = await ctx.env.DB.prepare(
        'INSERT INTO history_weeks (source_week_id, start_date, end_date, budget, exported_at) VALUES (?1, ?2, ?3, ?4, ?5)'
      ).bind(weekId, week.start_date, week.end_date, week.budget, week.exported_at).run();
      const historyId = hist.meta.last_row_id;

      const dayRows = await ctx.env.DB.prepare(
        'SELECT d.day_date, d.day_type, g.title AS gourmet_title FROM plan_days d ' +
        'LEFT JOIN gourmet g ON g.id = d.gourmet_id WHERE d.plan_id = ?1 ORDER BY d.day_date'
      ).bind(plan.id).all();
      const dayStatements = (dayRows.results || []).map(function (d, i) {
        return ctx.env.DB.prepare(
          'INSERT INTO history_days (history_week_id, day_date, day_type, gourmet_title, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)'
        ).bind(historyId, d.day_date, d.day_type, d.gourmet_title, i);
      });
      if (dayStatements.length) await ctx.env.DB.batch(dayStatements);

      const planLineRows = await ctx.env.DB.prepare(
        'SELECT d.day_date, di.slot, i.name AS item_name, l.price FROM plan_day_items di ' +
        'JOIN plan_days d ON d.id = di.plan_day_id ' +
        'JOIN items i ON i.id = di.item_id ' +
        'LEFT JOIN shopping_lines l ON l.week_id = ?1 AND l.item_id = di.item_id ' +
        'WHERE d.plan_id = ?2 AND di.item_id IS NOT NULL ORDER BY d.day_date, di.slot'
      ).bind(weekId, plan.id).all();

      // LEGACY SHAPE, kept on purpose: a week created before the pantry split
      // could carry lines marked 'pantry' (that was the first iteration, where a
      // counted shelf joined the week's list). No new week can produce one --
      // `syncShoppingLines` builds a week's list from the plan only -- but
      // archiving must not silently DROP a row the list actually had, so it is
      // copied into history like any other line. See AGENTS.md rule 35.
      const pantryRows = await ctx.env.DB.prepare(
        "SELECT i.name AS item_name, l.price FROM shopping_lines l JOIN items i ON i.id = l.item_id " +
        "WHERE l.week_id = ?1 AND l.origin = 'pantry' ORDER BY i.name COLLATE NOCASE"
      ).bind(weekId).all();

      const lineStatements = [];
      for (const r of (planLineRows.results || [])) {
        lineStatements.push(ctx.env.DB.prepare(
          'INSERT INTO history_lines (history_week_id, day_date, slot, item_name, origin, price) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
        ).bind(historyId, r.day_date, r.slot, r.item_name, 'plan', r.price));
      }
      for (const r of (pantryRows.results || [])) {
        lineStatements.push(ctx.env.DB.prepare(
          'INSERT INTO history_lines (history_week_id, day_date, slot, item_name, origin, price) VALUES (?1, NULL, NULL, ?2, ?3, ?4)'
        ).bind(historyId, r.item_name, 'pantry', r.price));
      }
      if (lineStatements.length) await ctx.env.DB.batch(lineStatements);

      await ctx.env.DB.prepare("UPDATE weeks SET status = 'archived' WHERE id = ?1").bind(weekId).run();
      notifyAsync(ctx, { weekId: weekId, archived: true });
      return ok({ historyId: historyId });
    }
  }
];
