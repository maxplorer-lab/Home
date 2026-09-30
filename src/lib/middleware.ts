// ─── Session / Auth Middleware ────────────────────────────────
// Sompitra's pages keep their native D1-backed sessions. The central login
// (src/routes/auth.tsx) mints a Sompitra session at login time; this
// middleware transparently REPAIRS a missing/stale one when the central
// home session is still alive (e.g. module account created after login).
//
// The repair RULE lives in src/lib/session-repair.ts; this file is the
// page-shaped adapter over its plan -- set the fresh cookie (the one place
// Hono needs `c.header(..., { append: true })`) and carry on, no retry.
import type { Context, Next } from 'hono'
import type { Env, User, Session } from '../db/schema'
import { SOMPITRA_COOKIE } from '../identity'
import { repairSession } from '../lib/session-repair'
import { readCookie } from '../lib/cookies'

export async function requireAuth(c: Context<{ Bindings: Env; Variables: { user: User } }>, next: Next) {
  const token = readCookie(c.req.raw, SOMPITRA_COOKIE)

  if (token) {
    const user = await sompitraUser(c.env, token)
    if (user) {
      c.set('user', user)
      await next()
      return
    }
  }

  // No valid Sompitra session — can the central home session repair it?
  // The plan carries the raw token, so the same lookup simply runs again
  // against the session row that was just minted (no Set-Cookie parsing).
  const plan = await repairSession(c.req.raw, c.env, 'sompitra')
  if (plan) {
    const user = await sompitraUser(c.env, plan.token)
    if (user) {
      c.header('Set-Cookie', plan.setCookie, { append: true })
      c.set('user', user)
      await next()
      return
    }
  }

  return c.redirect('/login')
}

/** The Sompitra session row + its user, or null. The repair path re-runs
 * this after minting, which is why the lookup is one function rather than
 * the same two queries written twice. */
async function sompitraUser(env: Env, token: string): Promise<User | null> {
  const session = await env.DB.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).bind(token).first<Session>()
  if (!session) return null
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first<User>()
}
