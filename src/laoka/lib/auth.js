// Local accounts with cookie sessions. No email, no phone, no external
// identity provider: an admin issues a 6 digit invite code and the new person
// picks their own username and password.
//
// The session token is random and only its SHA-256 is stored, so a database
// read does not hand anybody a usable session.

import { fail } from './http.js';
import { sha256Hex, randomToken } from './password.js';

export const SESSION_COOKIE = 'laoka_session';
export const SESSION_DAYS = 90;

const USER_COLUMNS = 'id, username, role, display_name, created_at, last_login_at';

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const piece = parts[i];
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    if (piece.slice(0, eq).trim() === name) return decodeURIComponent(piece.slice(eq + 1).trim());
  }
  return null;
}

function isSecure(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch (e) {
    return true;
  }
}

export function sessionCookie(request, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge +
    (isSecure(request) ? '; Secure' : '');
}

export function clearedCookie(request) {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (isSecure(request) ? '; Secure' : '');
}

export async function createSession(env, userId) {
  const token = randomToken();
  const hash = await sha256Hex(token);
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, datetime('now', ?3))"
  ).bind(hash, userId, '+' + SESSION_DAYS + ' days').run();
  // Opportunistic tidy up, so the table cannot grow without bound.
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  return token;
}

export async function destroySession(env, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return;
  const hash = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(hash).run();
}

export async function destroyAllSessions(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId).run();
}

export async function userCount(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  return row ? row.n : 0;
}

export async function findUserByName(env, username) {
  return await env.DB.prepare(
    'SELECT ' + USER_COLUMNS + ', password_hash, password_salt, password_iterations FROM users WHERE lower(username) = lower(?1)'
  ).bind(String(username || '')).first();
}

export async function publicUser(env, id) {
  return await env.DB.prepare('SELECT ' + USER_COLUMNS + ' FROM users WHERE id = ?1').bind(id).first();
}

// Returns the signed in user, or null. DEV_MODE is an explicit opt in that
// only ever appears in .dev.vars, never in the deployed configuration.
export async function resolveUser(request, env) {
  if (String(env.DEV_MODE) === 'true') {
    let dev = await env.DB.prepare('SELECT ' + USER_COLUMNS + ' FROM users ORDER BY id LIMIT 1').first();
    if (!dev) {
      const made = await env.DB.prepare(
        "INSERT INTO users (username, role, display_name) VALUES ('dev', 'admin', 'dev')"
      ).run();
      dev = await publicUser(env, made.meta.last_row_id);
    }
    return dev;
  }

  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    'SELECT u.' + USER_COLUMNS.split(', ').join(', u.') + ', s.token_hash ' +
    'FROM sessions s JOIN users u ON u.id = s.user_id ' +
    "WHERE s.token_hash = ?1 AND s.expires_at > datetime('now')"
  ).bind(hash).first();
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    display_name: row.display_name,
    created_at: row.created_at,
    last_login_at: row.last_login_at
  };
}

export async function requireUser(request, env) {
  const user = await resolveUser(request, env);
  if (!user) return { error: fail(401, 'not signed in') };
  return { user: user };
}

export async function requireAdmin(request, env) {
  const res = await requireUser(request, env);
  if (res.error) return res;
  if (res.user.role !== 'admin') return { error: fail(403, 'admin only') };
  return res;
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';
}

// A 6 digit code is only 10^6 possibilities, so guessing has to be throttled.
export async function tooManyAttempts(env, key, limit, windowMinutes) {
  const row = await env.DB.prepare('SELECT count, window_start FROM attempts WHERE key = ?1').bind(key).first();
  if (!row) return false;
  const started = Date.parse(row.window_start.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(started)) return false;
  if (Date.now() - started > windowMinutes * 60000) return false;
  return row.count >= limit;
}

export async function noteAttempt(env, key, windowMinutes) {
  const cutoff = '-' + windowMinutes + ' minutes';
  await env.DB.prepare(
    "INSERT INTO attempts (key, count, window_start) VALUES (?1, 1, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET " +
    "count = CASE WHEN attempts.window_start < datetime('now', ?2) THEN 1 ELSE attempts.count + 1 END, " +
    "window_start = CASE WHEN attempts.window_start < datetime('now', ?2) THEN datetime('now') ELSE attempts.window_start END"
  ).bind(key, cutoff).run();
}

export async function clearAttempts(env, key) {
  await env.DB.prepare('DELETE FROM attempts WHERE key = ?1').bind(key).run();
}
