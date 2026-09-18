// The shopping list carries exactly one piece of state per line: the price.
// A price above zero means bought, in the bag, and exported. Empty or zero
// means not bought, and it stays out of the CSV.

import { ok, fail, readJson, toInt } from '../lib/http.js';
import { notifyAsync } from '../lib/notify.js';
import { getWeekById, touchWeek, buildWeekState } from '../data/queries.js';

export default [
  {
    method: 'PATCH',
    pattern: '/api/lines/:id',
    handler: async function (ctx) {
      const lineId = toInt(ctx.params.id);
      const body = (await readJson(ctx.request)) || {};

      const line = await ctx.env.DB.prepare('SELECT id, week_id FROM shopping_lines WHERE id = ?1').bind(lineId).first();
      if (!line) return fail(404, 'no such line');

      const week = await getWeekById(ctx.env, line.week_id);
      if (!week) return fail(404, 'no such week');
      if (week.status === 'archived') return fail(409, 'that week is archived and cannot be priced');

      // Price is the only line state. Entering one marks the line as bought;
      // clearing it puts the line back in the remaining list.
      if (body.price !== undefined) {
        let price = null;
        if (body.price !== null && body.price !== '') {
          const n = toInt(body.price);
          if (n === null || n < 0) return fail(400, 'a price must be a whole number of zero or more');
          price = n > 0 ? n : null;
        }
        await ctx.env.DB.prepare('UPDATE shopping_lines SET price = ?1 WHERE id = ?2').bind(price, lineId).run();
      }
      await touchWeek(ctx.env, line.week_id);
      const fresh = await getWeekById(ctx.env, line.week_id);
      notifyAsync(ctx, { weekId: line.week_id, updatedAt: fresh.updated_at, kind: 'lines' });
      return ok(await buildWeekState(ctx.env, fresh, undefined));
    }
  }
];
