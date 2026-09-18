// ─── Session / Auth Middleware ────────────────────────────────
// Sompitra's pages keep their native D1-backed sessions. The central login
// (src/routes/auth.tsx) mints a Sompitra session at login time; this
// middleware transparently REPAIRS a missing/stale one when the central
// home session is still alive (e.g. module account created after login).
import { getCookie } from 'hono/cookie'
import type { Context, Next } from 'hono'
import type { Env, User, Session } from '../db/schema'
import { SOMPITRA_COOKIE, getHomeUserFromCookie, promoteSession } from '../identity'

export async function requireAuth(c: Context<{ Bindings: Env; Variables: { user: User } }>, next: Next) {
  const token = getCookie(c, SOMPITRA_COOKIE)

  if (token) {
    const session = await c.env.DB.prepare(
      "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
    ).bind(token).first<Session>()

    if (session) {
      const user = await c.env.DB.prepare(
        'SELECT * FROM users WHERE id = ?'
      ).bind(session.user_id).first<User>()

      if (user) {
        c.set('user', user)
        await next()
        return
      }
    }
  }

  // No valid Sompitra session — can the central home session repair it?
  const homeToken = getCookie(c, 'home_session')
  const homeUser = await getHomeUserFromCookie(c.env.HOME_DB, homeToken)
  if (homeUser) {
    const setCookieValue = await promoteSession(c.env, 'sompitra', homeUser, secureFromUrl(c.req.url))
    if (setCookieValue) {
      // Re-extract the raw token from the Set-Cookie value and re-run the
      // same lookup the normal path uses — the freshly minted session row
      // exists, so the query now succeeds.
      const raw = setCookieValue.split(';')[0]!.split('=').slice(1).join('=')
      const session = await c.env.DB.prepare(
        "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
      ).bind(raw).first<Session>()
      const user = session
        ? await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first<User>()
        : null
      if (user) {
        c.header('Set-Cookie', setCookieValue, { append: true })
        c.set('user', user)
        await next()
        return
      }
    }
  }

  return c.redirect('/login')
}

function secureFromUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  } catch {
    return true
  }
}
