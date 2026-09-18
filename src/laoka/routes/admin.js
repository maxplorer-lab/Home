// Gourmet titles, household settings, and user management.
//
// Authentication is Cloudflare Access, which answers who someone is. This
// users table answers whether they are still allowed, so an admin can revoke
// somebody without touching the Cloudflare dashboard.

import { ok, fail, readJson, toInt, toStr } from '../lib/http.js';
import { requireAdmin } from '../lib/auth.js';
import { randomInviteCode } from '../lib/password.js';
import { getSettings, setSetting, getGourmetList } from '../data/queries.js';

const SETTING_KEYS = ['default_budget', 'max_active_weeks'];

// D1 caps a row at 2 MB, so a base64 picture is held well under that. The
// browser downscales before upload, which keeps a photo around 150 to 300 KB.
const MAX_IMAGE_BASE64 = 1800000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Returns { ok: true, image, imageType } or { ok: false, response }.
function readImage(body) {
  if (body.image === undefined) return { ok: true, image: undefined, imageType: undefined };
  const raw = toStr(body.image);
  if (!raw) return { ok: true, image: null, imageType: null };
  if (raw.length > MAX_IMAGE_BASE64) {
    return { ok: false, response: fail(413, 'that picture is too large. It should be resized before upload.') };
  }
  const type = IMAGE_TYPES.indexOf(toStr(body.imageType, 40)) === -1 ? 'image/jpeg' : toStr(body.imageType, 40);
  return { ok: true, image: raw, imageType: type };
}

export default [
  // ------------------------------------------------------------- gourmet
  {
    method: 'GET',
    pattern: '/api/gourmet',
    handler: async function (ctx) {
      return ok({ gourmet: await getGourmetList(ctx.env) });
    }
  },
  {
    method: 'POST',
    pattern: '/api/gourmet',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const title = toStr(body.title, 80);
      if (!title) return fail(400, 'a title is required');
      const pic = readImage(body);
      if (!pic.ok) return pic.response;
      const hasPic = !!pic.image;
      const r = await ctx.env.DB.prepare(
        'INSERT INTO gourmet (title, link, ingredients, notes, image, image_type, image_updated_at) ' +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?5 IS NULL THEN NULL ELSE datetime('now') END)"
      ).bind(
        title, toStr(body.link, 300) || null, toStr(body.ingredients) || null, toStr(body.notes, 200) || null,
        pic.image || null, hasPic ? pic.imageType : null
      ).run();
      return ok({ id: r.meta.last_row_id });
    }
  },
  {
    method: 'PATCH',
    pattern: '/api/gourmet/:id',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const sets = [];
      const binds = [];
      if (body.title !== undefined) { sets.push('title = ?' + (binds.length + 1)); binds.push(toStr(body.title, 80)); }
      if (body.link !== undefined) { sets.push('link = ?' + (binds.length + 1)); binds.push(toStr(body.link, 300) || null); }
      if (body.ingredients !== undefined) { sets.push('ingredients = ?' + (binds.length + 1)); binds.push(toStr(body.ingredients) || null); }
      if (body.image !== undefined) {
        const pic = readImage(body);
        if (!pic.ok) return pic.response;
        sets.push('image = ?' + (binds.length + 1)); binds.push(pic.image);
        sets.push('image_type = ?' + (binds.length + 1)); binds.push(pic.image ? pic.imageType : null);
        sets.push("image_updated_at = datetime('now')");
      }
      if (body.notes !== undefined) { sets.push('notes = ?' + (binds.length + 1)); binds.push(toStr(body.notes, 200) || null); }
      if (!sets.length) return fail(400, 'nothing to update');
      binds.push(toInt(ctx.params.id));
      const sql = 'UPDATE gourmet SET ' + sets.join(', ') + ' WHERE id = ?' + binds.length;
      await ctx.env.DB.prepare(sql).bind(...binds).run();
      return ok({});
    }
  },
  // The bytes are served from their own URL so the recipe list stays small and
  // the browser can cache the picture.
  {
    method: 'GET',
    pattern: '/api/gourmet/:id/image',
    handler: async function (ctx) {
      const row = await ctx.env.DB.prepare('SELECT image, image_type FROM gourmet WHERE id = ?1')
        .bind(toInt(ctx.params.id)).first();
      if (!row || !row.image) return fail(404, 'no picture for that recipe');
      return new Response(base64ToBytes(row.image), {
        headers: {
          'content-type': row.image_type || 'image/jpeg',
          'cache-control': 'public, max-age=31536000, immutable'
        }
      });
    }
  },
  {
    method: 'DELETE',
    pattern: '/api/gourmet/:id/image',
    handler: async function (ctx) {
      await ctx.env.DB.prepare(
        "UPDATE gourmet SET image = NULL, image_type = NULL, image_updated_at = datetime('now') WHERE id = ?1"
      ).bind(toInt(ctx.params.id)).run();
      return ok({});
    }
  },
  {
    method: 'DELETE',
    pattern: '/api/gourmet/:id',
    handler: async function (ctx) {
      await ctx.env.DB.prepare("UPDATE gourmet SET deleted_at = datetime('now') WHERE id = ?1")
        .bind(toInt(ctx.params.id)).run();
      return ok({});
    }
  },

  // ------------------------------------------------------------ settings
  {
    method: 'PATCH',
    pattern: '/api/settings',
    handler: async function (ctx) {
      const body = (await readJson(ctx.request)) || {};
      const applied = {};
      for (const key of SETTING_KEYS) {
        if (body[key] === undefined) continue;
        let value = toStr(body[key], 40);
        if (key === 'max_active_weeks') value = String(Math.max(1, Math.min(10, toInt(value) || 2)));
        if (key === 'default_budget') value = value === '' ? '' : String(Math.max(0, toInt(value) || 0));
        await setSetting(ctx.env, key, value);
        applied[key] = value;
      }
      return ok({ settings: await getSettings(ctx.env) });
    }
  },

  // --------------------------------------------------------------- users
  {
    method: 'GET',
    pattern: '/api/users',
    handler: async function (ctx) {
      const admin = await requireAdmin(ctx.request, ctx.env);
      if (admin.error) return admin.error;
      const rows = await ctx.env.DB.prepare(
        'SELECT id, username, role, display_name, created_at, last_login_at FROM users ORDER BY id'
      ).all();
      return ok({ users: rows.results || [] });
    }
  },

  // An invite is a 6 digit code the admin reads out. The new person uses it
  // once, alongside a username and password of their own choosing.
  {
    method: 'GET',
    pattern: '/api/invites',
    handler: async function (ctx) {
      const admin = await requireAdmin(ctx.request, ctx.env);
      if (admin.error) return admin.error;
      const rows = await ctx.env.DB.prepare(
        "SELECT id, code, created_at, expires_at FROM invites " +
        "WHERE used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC"
      ).all();
      return ok({ invites: rows.results || [] });
    }
  },
  {
    method: 'POST',
    pattern: '/api/invites',
    handler: async function (ctx) {
      const admin = await requireAdmin(ctx.request, ctx.env);
      if (admin.error) return admin.error;
      const body = (await readJson(ctx.request)) || {};
      const hours = Math.max(1, Math.min(168, toInt(body.hours) || 24));

      let code = null;
      for (let attempt = 0; attempt < 8 && !code; attempt++) {
        const candidate = randomInviteCode();
        const clash = await ctx.env.DB.prepare('SELECT id FROM invites WHERE code = ?1').bind(candidate).first();
        if (!clash) code = candidate;
      }
      if (!code) return fail(500, 'could not allocate a code, try again');

      const r = await ctx.env.DB.prepare(
        "INSERT INTO invites (code, created_by, expires_at) VALUES (?1, ?2, datetime('now', ?3))"
      ).bind(code, admin.user.id, '+' + hours + ' hours').run();
      return ok({ id: r.meta.last_row_id, code: code, hours: hours });
    }
  },
  {
    method: 'DELETE',
    pattern: '/api/invites/:id',
    handler: async function (ctx) {
      const admin = await requireAdmin(ctx.request, ctx.env);
      if (admin.error) return admin.error;
      await ctx.env.DB.prepare('DELETE FROM invites WHERE id = ?1').bind(toInt(ctx.params.id)).run();
      return ok({});
    }
  },
  {
    method: 'PATCH',
    pattern: '/api/users/:id',
    handler: async function (ctx) {
      const admin = await requireAdmin(ctx.request, ctx.env);
      if (admin.error) return admin.error;
      const body = (await readJson(ctx.request)) || {};
      const id = toInt(ctx.params.id);
      const sets = [];
      const binds = [];
      if (body.role !== undefined) { sets.push('role = ?' + (binds.length + 1)); binds.push(body.role === 'admin' ? 'admin' : 'member'); }
      if (body.displayName !== undefined) { sets.push('display_name = ?' + (binds.length + 1)); binds.push(toStr(body.displayName, 60)); }
      if (!sets.length) return fail(400, 'nothing to update');

      if (body.role !== undefined && body.role !== 'admin') {
        const admins = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first();
        if (admins && admins.n <= 1) return fail(409, 'the last admin cannot be demoted');
      }

      binds.push(id);
      const sql = 'UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?' + binds.length;
      await ctx.env.DB.prepare(sql).bind(...binds).run();
      return ok({});
    }
  },
  {
    method: 'DELETE',
    pattern: '/api/users/:id',
    handler: async function (ctx) {
      const admin = await requireAdmin(ctx.request, ctx.env);
      if (admin.error) return admin.error;
      const id = toInt(ctx.params.id);

      const target = await ctx.env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?1').bind(id).first();
      if (!target) return fail(404, 'no such user');
      if (target.id === admin.user.id) return fail(409, 'you cannot remove your own account');
      if (target.role === 'admin') {
        const admins = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first();
        if (admins && admins.n <= 1) return fail(409, 'the last admin cannot be removed');
      }
      await ctx.env.DB.batch([
        ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(id),
        ctx.env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(id)
      ]);
      return ok({});
    }
  }
];
