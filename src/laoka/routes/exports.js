// The CSV hand-off to sompitra, plus history browsing and history export.
//
// Contract: filename carries the week range, the file holds two columns, only
// priced lines appear, rows are sorted A to Z and the groups are ignored.

import { ok, fail, text, toInt } from '../lib/http.js';
import { buildCsv, exportFilename, contentDisposition } from '../lib/csv.js';
import { notifyAsync } from '../lib/notify.js';
import { getWeekById, getShoppingLines, touchWeek } from '../data/queries.js';

function csvResponse(csv, filename) {
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': contentDisposition(filename),
      'cache-control': 'no-store'
    }
  });
}

function groupByMonth(weeks) {
  const months = [];
  const index = new Map();
  for (const w of weeks) {
    // These rows are already mapped to camelCase; reading start_date here
    // produced the string "undefin" as every month heading.
    const key = String(w.startDate).slice(0, 7);
    let bucket = index.get(key);
    if (!bucket) {
      bucket = { month: key, weeks: [] };
      index.set(key, bucket);
      months.push(bucket);
    }
    bucket.weeks.push(w);
  }
  return months;
}

export default [
  // Exports the live week. Marks the week as exported so later per-day swaps
  // are visibly not reflected in the file.
  {
    method: 'GET',
    pattern: '/api/weeks/:id/export',
    handler: async function (ctx) {
      const weekId = toInt(ctx.params.id);
      const week = await getWeekById(ctx.env, weekId);
      if (!week) return fail(404, 'no such week');

      const lines = await getShoppingLines(ctx.env, weekId);
      const priced = lines.filter(function (l) { return l.price !== null && l.price > 0; });
      if (!priced.length) {
        return fail(409, 'nothing is priced yet, so there is nothing to export');
      }

      const csv = buildCsv(priced);
      const filename = exportFilename(week.start_date, week.end_date);

      await ctx.env.DB.prepare("UPDATE weeks SET exported_at = datetime('now') WHERE id = ?1").bind(weekId).run();
      await touchWeek(ctx.env, weekId);

      return csvResponse(csv, filename);
    }
  },

  {
    method: 'GET',
    pattern: '/api/history',
    handler: async function (ctx) {
      const rows = await ctx.env.DB.prepare(
        'SELECT h.id, h.source_week_id, h.start_date, h.end_date, h.budget, h.exported_at, h.archived_at, ' +
        '(SELECT COUNT(*) FROM history_lines l WHERE l.history_week_id = h.id) AS line_count, ' +
        '(SELECT COALESCE(SUM(l.price), 0) FROM history_lines l WHERE l.history_week_id = h.id AND l.price > 0) AS total ' +
        'FROM history_weeks h ORDER BY h.start_date DESC'
      ).all();
      const weeks = (rows.results || []).map(function (r) {
        return {
          id: r.id,
          sourceWeekId: r.source_week_id,
          startDate: r.start_date,
          endDate: r.end_date,
          budget: r.budget,
          exportedAt: r.exported_at,
          archivedAt: r.archived_at,
          lineCount: r.line_count,
          total: r.total
        };
      });
      return ok({ months: groupByMonth(weeks) });
    }
  },

  {
    method: 'GET',
    pattern: '/api/history/:id',
    handler: async function (ctx) {
      const historyId = toInt(ctx.params.id);
      const summary = await ctx.env.DB.prepare(
        'SELECT id, source_week_id, start_date, end_date, budget, exported_at, archived_at FROM history_weeks WHERE id = ?1'
      ).bind(historyId).first();
      if (!summary) return fail(404, 'no such archived week');

      const days = await ctx.env.DB.prepare(
        'SELECT day_date, day_type, gourmet_title FROM history_days WHERE history_week_id = ?1 ORDER BY day_date'
      ).bind(historyId).all();
      const lines = await ctx.env.DB.prepare(
        'SELECT day_date, slot, item_name, origin, price FROM history_lines WHERE history_week_id = ?1 ' +
        'ORDER BY day_date, slot'
      ).bind(historyId).all();

      return ok({
        week: summary,
        days: days.results || [],
        lines: lines.results || []
      });
    }
  },

  // Removes an archived week outright, snapshot and all.
  //
  // The week row has to go with the snapshot. Deleting only the history would
  // leave the date occupied by an archived week that can never be reopened,
  // which is exactly what stopped a week being started again after a test run.
  {
    method: 'DELETE',
    pattern: '/api/history/:id',
    handler: async function (ctx) {
      const historyId = toInt(ctx.params.id);
      const entry = await ctx.env.DB.prepare(
        'SELECT id, source_week_id, start_date, end_date FROM history_weeks WHERE id = ?1'
      ).bind(historyId).first();
      if (!entry) return fail(404, 'no such archived week');

      const weekId = entry.source_week_id;
      await ctx.env.DB.batch([
        ctx.env.DB.prepare('DELETE FROM history_lines WHERE history_week_id = ?1').bind(historyId),
        ctx.env.DB.prepare('DELETE FROM history_days WHERE history_week_id = ?1').bind(historyId),
        ctx.env.DB.prepare('DELETE FROM history_weeks WHERE id = ?1').bind(historyId),
        ctx.env.DB.prepare(
          'DELETE FROM plan_day_items WHERE plan_day_id IN (' +
          'SELECT id FROM plan_days WHERE plan_id IN (SELECT id FROM plans WHERE week_id = ?1))'
        ).bind(weekId),
        ctx.env.DB.prepare('DELETE FROM plan_days WHERE plan_id IN (SELECT id FROM plans WHERE week_id = ?1)').bind(weekId),
        ctx.env.DB.prepare('DELETE FROM plans WHERE week_id = ?1').bind(weekId),
        ctx.env.DB.prepare('DELETE FROM shopping_lines WHERE week_id = ?1').bind(weekId),
        ctx.env.DB.prepare("DELETE FROM weeks WHERE id = ?1 AND status = 'archived'").bind(weekId)
      ]);
      notifyAsync(ctx, { archived: true, deleted: true, startDate: entry.start_date });
      return ok({ freedStart: entry.start_date });
    }
  },

  // Past weeks export from the snapshot, which stores names and prices and is
  // not bound to the catalog.
  {
    method: 'GET',
    pattern: '/api/history/:id/export',
    handler: async function (ctx) {
      const historyId = toInt(ctx.params.id);
      const summary = await ctx.env.DB.prepare(
        'SELECT id, start_date, end_date FROM history_weeks WHERE id = ?1'
      ).bind(historyId).first();
      if (!summary) return fail(404, 'no such archived week');

      const rows = await ctx.env.DB.prepare(
        'SELECT item_name, price FROM history_lines WHERE history_week_id = ?1 AND price IS NOT NULL AND price > 0'
      ).bind(historyId).all();
      const lines = (rows.results || []).map(function (r) { return { name: r.item_name, price: r.price }; });
      if (!lines.length) return fail(409, 'that week has no priced lines to export');

      const filename = exportFilename(summary.start_date, summary.end_date);
      const csv = buildCsv(lines);
      await ctx.env.DB.prepare("UPDATE history_weeks SET exported_at = datetime('now') WHERE id = ?1").bind(historyId).run();
      return csvResponse(csv, filename);
    }
  }
];
