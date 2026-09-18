// Catalog CRUD across all three levels. Removal is a soft delete so that live
// weeks and history keep resolving, and any signed-in user may do it.

import { ok, fail, readJson, toInt, toStr, toBool } from '../lib/http.js';
import { getCatalogTree } from '../data/queries.js';

const SLOT_ROLES = ['protein', 'side', 'salad', 'none'];

function conflict(err) {
  const message = err && err.message ? err.message : '';
  if (message.indexOf('UNIQUE') !== -1) return fail(409, 'that name already exists here');
  return null;
}

export default [
  {
    method: 'GET',
    pattern: '/api/catalog',
    handler: async function (ctx) {
      return ok({ catalog: await getCatalogTree(ctx.env) });
    }
  },

  // ------------------------------------------------------------- level 1
  {
    method: 'POST',
    pattern: '/api/groups',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const name = toStr(body.name, 60);
      if (!name) return fail(400, 'a name is required');
      try {
        const r = await ctx.env.DB.prepare('INSERT INTO groups (name, is_pantry, sort_order) VALUES (?1, ?2, ?3)')
          .bind(name, toBool(body.isPantry) ? 1 : 0, toInt(body.sortOrder) || 0).run();
        return ok({ id: r.meta.last_row_id });
      } catch (err) {
        return conflict(err) || fail(500, err.message);
      }
    }
  },
  {
    method: 'PATCH',
    pattern: '/api/groups/:id',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const id = toInt(ctx.params.id);
      const sets = [];
      const binds = [];
      if (body.name !== undefined) { sets.push('name = ?' + (binds.length + 1)); binds.push(toStr(body.name, 60)); }
      if (body.isPantry !== undefined) { sets.push('is_pantry = ?' + (binds.length + 1)); binds.push(toBool(body.isPantry) ? 1 : 0); }
      if (body.sortOrder !== undefined) { sets.push('sort_order = ?' + (binds.length + 1)); binds.push(toInt(body.sortOrder) || 0); }
      if (!sets.length) return fail(400, 'nothing to update');
      binds.push(id);
      const sql = 'UPDATE groups SET ' + sets.join(', ') + ' WHERE id = ?' + binds.length;
      try {
        await ctx.env.DB.prepare(sql).bind(...binds).run();
        return ok({});
      } catch (err) {
        return conflict(err) || fail(500, err.message);
      }
    }
  },
  {
    method: 'DELETE',
    pattern: '/api/groups/:id',
    handler: async function (ctx) {
      await ctx.env.DB.prepare("UPDATE groups SET deleted_at = datetime('now') WHERE id = ?1")
        .bind(toInt(ctx.params.id)).run();
      return ok({});
    }
  },

  // ------------------------------------------------------------- level 2
  {
    method: 'POST',
    pattern: '/api/subgroups',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const name = toStr(body.name, 60);
      const groupId = toInt(body.groupId);
      const slotRole = SLOT_ROLES.indexOf(body.slotRole) === -1 ? 'none' : body.slotRole;
      if (!name || !groupId) return fail(400, 'a name and a parent group are required');
      try {
        const r = await ctx.env.DB.prepare('INSERT INTO subgroups (group_id, name, icon, slot_role, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)')
          .bind(groupId, name, toStr(body.icon, 8) || null, slotRole, toInt(body.sortOrder) || 0).run();
        return ok({ id: r.meta.last_row_id });
      } catch (err) {
        return conflict(err) || fail(500, err.message);
      }
    }
  },
  {
    method: 'PATCH',
    pattern: '/api/subgroups/:id',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const sets = [];
      const binds = [];
      if (body.name !== undefined) { sets.push('name = ?' + (binds.length + 1)); binds.push(toStr(body.name, 60)); }
      if (body.icon !== undefined) { sets.push('icon = ?' + (binds.length + 1)); binds.push(toStr(body.icon, 8) || null); }
      if (body.slotRole !== undefined) {
        sets.push('slot_role = ?' + (binds.length + 1));
        binds.push(SLOT_ROLES.indexOf(body.slotRole) === -1 ? 'none' : body.slotRole);
      }
      if (body.groupId !== undefined) { sets.push('group_id = ?' + (binds.length + 1)); binds.push(toInt(body.groupId)); }
      if (body.sortOrder !== undefined) { sets.push('sort_order = ?' + (binds.length + 1)); binds.push(toInt(body.sortOrder) || 0); }
      if (!sets.length) return fail(400, 'nothing to update');
      binds.push(toInt(ctx.params.id));
      const sql = 'UPDATE subgroups SET ' + sets.join(', ') + ' WHERE id = ?' + binds.length;
      try {
        await ctx.env.DB.prepare(sql).bind(...binds).run();
        return ok({});
      } catch (err) {
        return conflict(err) || fail(500, err.message);
      }
    }
  },
  {
    method: 'DELETE',
    pattern: '/api/subgroups/:id',
    handler: async function (ctx) {
      await ctx.env.DB.prepare("UPDATE subgroups SET deleted_at = datetime('now') WHERE id = ?1")
        .bind(toInt(ctx.params.id)).run();
      return ok({});
    }
  },

  // ------------------------------------------------------------- level 3
  {
    method: 'POST',
    pattern: '/api/items',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const name = toStr(body.name, 80);
      const subgroupId = toInt(body.subgroupId);
      if (!name || !subgroupId) return fail(400, 'a name and a parent group are required');
      try {
        // Available unless the caller says otherwise: a new item is something
        // the household wants, so the exception is what gets recorded.
        const available = body.selected === undefined ? 1 : (toBool(body.selected) ? 1 : 0);
        const r = await ctx.env.DB.prepare('INSERT INTO items (subgroup_id, name, selected, notes, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)')
          .bind(subgroupId, name, available, toStr(body.notes, 200) || null, toInt(body.sortOrder) || 0).run();
        return ok({ id: r.meta.last_row_id });
      } catch (err) {
        return conflict(err) || fail(500, err.message);
      }
    }
  },
  {
    method: 'PATCH',
    pattern: '/api/items/:id',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const sets = [];
      const binds = [];
      if (body.name !== undefined) { sets.push('name = ?' + (binds.length + 1)); binds.push(toStr(body.name, 80)); }
      if (body.subgroupId !== undefined) { sets.push('subgroup_id = ?' + (binds.length + 1)); binds.push(toInt(body.subgroupId)); }
      if (body.selected !== undefined) { sets.push('selected = ?' + (binds.length + 1)); binds.push(toBool(body.selected) ? 1 : 0); }
      if (body.notes !== undefined) { sets.push('notes = ?' + (binds.length + 1)); binds.push(toStr(body.notes, 200) || null); }
      if (body.sortOrder !== undefined) { sets.push('sort_order = ?' + (binds.length + 1)); binds.push(toInt(body.sortOrder) || 0); }
      if (!sets.length) return fail(400, 'nothing to update');
      binds.push(toInt(ctx.params.id));
      const sql = 'UPDATE items SET ' + sets.join(', ') + ' WHERE id = ?' + binds.length;
      try {
        await ctx.env.DB.prepare(sql).bind(...binds).run();
        return ok({});
      } catch (err) {
        return conflict(err) || fail(500, err.message);
      }
    }
  },
  {
    method: 'DELETE',
    pattern: '/api/items/:id',
    handler: async function (ctx) {
      await ctx.env.DB.prepare("UPDATE items SET deleted_at = datetime('now'), selected = 0 WHERE id = ?1")
        .bind(toInt(ctx.params.id)).run();
      return ok({});
    }
  },

  // Selection is the one persistent checkbox: it decides what generation may
  // draw from, and it carries forward between weeks.
  {
    method: 'POST',
    pattern: '/api/items/selection',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const ids = Array.isArray(body.ids) ? body.ids.map(toInt).filter(function (n) { return n !== null; }) : [];
      if (!ids.length) return fail(400, 'at least one item is required');
      const selected = toBool(body.selected) ? 1 : 0;
      const statements = ids.map(function (id) {
        return ctx.env.DB.prepare('UPDATE items SET selected = ?1 WHERE id = ?2 AND deleted_at IS NULL')
          .bind(selected, id);
      });
      await ctx.env.DB.batch(statements);
      return ok({ updated: ids.length });
    }
  }
];
