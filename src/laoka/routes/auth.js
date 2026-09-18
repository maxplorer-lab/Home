// Sign in, sign up, sign out. These routes are public: they are how a session
// is obtained in the first place.

import { ok, fail, readJson, toStr } from '../lib/http.js';
import {
  SESSION_COOKIE, sessionCookie, clearedCookie, createSession, destroySession,
  resolveUser, userCount, findUserByName, publicUser, clientIp,
  tooManyAttempts, noteAttempt, clearAttempts
} from '../lib/auth.js';
import {
  hashPassword, verifyPassword, validUsername, validPassword,
  iterationsFor, pepperConfigured, newSalt
} from '../lib/password.js';

const MAX_ATTEMPTS = 10;
const WINDOW_MINUTES = 60;

function jsonWithCookie(data, cookie, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': cookie
    }
  });
}

async function requirePepper(env) {
  if (pepperConfigured(env)) return null;
  return fail(500, 'AUTH_PEPPER is not set on this Worker. It is required, and must be at least 16 characters.');
}

export default [
  // Who am I. Deliberately public: the client uses it to decide between the
  // sign in screen and the app.
  {
    method: 'GET',
    pattern: '/api/auth/me',
    public: true,
    handler: async function (ctx) {
      const user = await resolveUser(ctx.request, ctx.env);
      const count = await userCount(ctx.env);
      return ok({
        user: user,
        needsSetup: count === 0,
        // Whether the form should ask for a setup token. Only true when the
        // deployer has set one and no account exists yet.
        setupTokenRequired: count === 0 && String(ctx.env.SETUP_TOKEN || '').length > 0
      });
    }
  },

  {
    method: 'POST',
    pattern: '/api/auth/signup',
    public: true,
    handler: async function (ctx) {
      const missing = await requirePepper(ctx.env);
      if (missing) return missing;

      const body = (await readJson(ctx.request)) || {};
      const username = toStr(body.username, 24);
      const password = typeof body.password === 'string' ? body.password : '';
      const invite = toStr(body.invite, 6);
      const setupToken = toStr(body.setupToken, 120);

      if (!validUsername(username)) {
        return fail(400, 'Usernames are 3 to 24 characters: letters, numbers, dot, dash or underscore.');
      }
      if (!validPassword(password)) {
        return fail(400, 'Passwords must be at least 8 characters.');
      }

      const ip = clientIp(ctx.request);
      const gateKey = 'signup:' + ip;
      if (await tooManyAttempts(ctx.env, gateKey, MAX_ATTEMPTS, WINDOW_MINUTES)) {
        return fail(429, 'Too many attempts from here. Try again later.');
      }

      const existing = await findUserByName(ctx.env, username);
      if (existing) {
        await noteAttempt(ctx.env, gateKey, WINDOW_MINUTES);
        return fail(409, 'That username is taken.');
      }

      const count = await userCount(ctx.env);
      let role = 'member';
      let inviteRow = null;

      if (count === 0) {
        // The first account becomes the admin. If the deployer has set
        // SETUP_TOKEN then it must be supplied as well, which closes the
        // window between deploying and claiming the app; setting it is
        // optional and nothing else changes.
        const expected = String(ctx.env.SETUP_TOKEN || '');
        if (expected && setupToken !== expected) {
          await noteAttempt(ctx.env, gateKey, WINDOW_MINUTES);
          return fail(403, 'That setup token is not correct.');
        }
        role = 'admin';
      } else {
        if (!/^[0-9]{6}$/.test(invite)) {
          await noteAttempt(ctx.env, gateKey, WINDOW_MINUTES);
          return fail(403, 'An invite code is needed to join. Ask an admin for a 6 digit code.');
        }
        inviteRow = await ctx.env.DB.prepare(
          "SELECT id, code FROM invites WHERE code = ?1 AND used_at IS NULL AND expires_at > datetime('now')"
        ).bind(invite).first();
        if (!inviteRow) {
          await noteAttempt(ctx.env, gateKey, WINDOW_MINUTES);
          return fail(403, 'That invite code is not valid or has expired.');
        }
      }

      const salt = newSalt();
      const made = await hashPassword(password, ctx.env, salt, iterationsFor(ctx.env));
      const inserted = await ctx.env.DB.prepare(
        'INSERT INTO users (username, role, display_name, password_hash, password_salt, password_iterations, last_login_at) ' +
        "VALUES (?1, ?2, ?1, ?3, ?4, ?5, datetime('now'))"
      ).bind(username, role, made.hash, made.salt, made.iterations).run();

      const userId = inserted.meta.last_row_id;
      if (inviteRow) {
        await ctx.env.DB.prepare("UPDATE invites SET used_by = ?1, used_at = datetime('now') WHERE id = ?2")
          .bind(userId, inviteRow.id).run();
      }
      await clearAttempts(ctx.env, gateKey);

      const token = await createSession(ctx.env, userId);
      const user = await publicUser(ctx.env, userId);
      return jsonWithCookie({ ok: true, user: user }, sessionCookie(ctx.request, token));
    }
  },

  {
    method: 'POST',
    pattern: '/api/auth/login',
    public: true,
    handler: async function (ctx) {
      const missing = await requirePepper(ctx.env);
      if (missing) return missing;

      const body = (await readJson(ctx.request)) || {};
      const username = toStr(body.username, 24);
      const password = typeof body.password === 'string' ? body.password : '';

      const ip = clientIp(ctx.request);
      const gateKey = 'login:' + ip;
      if (await tooManyAttempts(ctx.env, gateKey, MAX_ATTEMPTS, WINDOW_MINUTES)) {
        return fail(429, 'Too many attempts from here. Try again later.');
      }

      const user = await findUserByName(ctx.env, username);
      const good = user ? await verifyPassword(password, user, ctx.env) : false;
      if (!good) {
        await noteAttempt(ctx.env, gateKey, WINDOW_MINUTES);
        return fail(401, 'That username and password do not match.');
      }

      await clearAttempts(ctx.env, gateKey);
      await ctx.env.DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?1").bind(user.id).run();
      const token = await createSession(ctx.env, user.id);
      const fresh = await publicUser(ctx.env, user.id);
      return jsonWithCookie({ ok: true, user: fresh }, sessionCookie(ctx.request, token));
    }
  },

  {
    method: 'POST',
    pattern: '/api/auth/logout',
    public: true,
    handler: async function (ctx) {
      await destroySession(ctx.env, ctx.request);
      return jsonWithCookie({ ok: true }, clearedCookie(ctx.request));
    }
  },

  {
    method: 'POST',
    pattern: '/api/auth/password',
    handler: async function (ctx) {
      const missing = await requirePepper(ctx.env);
      if (missing) return missing;
      const body = (await readJson(ctx.request)) || {};
      const current = typeof body.current === 'string' ? body.current : '';
      const next = typeof body.next === 'string' ? body.next : '';
      if (!validPassword(next)) return fail(400, 'The new password must be at least 8 characters.');

      const stored = await findUserByName(ctx.env, ctx.user.username);
      if (!stored || !(await verifyPassword(current, stored, ctx.env))) {
        return fail(403, 'The current password is not correct.');
      }
      const salt = newSalt();
      const made = await hashPassword(next, ctx.env, salt, iterationsFor(ctx.env));
      await ctx.env.DB.prepare(
        'UPDATE users SET password_hash = ?1, password_salt = ?2, password_iterations = ?3 WHERE id = ?4'
      ).bind(made.hash, made.salt, made.iterations, ctx.user.id).run();
      return ok({});
    }
  }
];
