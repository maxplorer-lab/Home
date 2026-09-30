// ─── One session-repair rule, three adapters ─────────────────────
// A browser can arrive with a live Home session (`home_session`) but no --
// or a stale -- module session. Every module reports that in its own shape
// (the APIs 401, Laoka's public /auth/me answers 200 {user:null}, Sompitra's
// pages redirect), but the repair is one rule: read home_session, mint the
// module's cookie, hand the caller everything it needs to finish the
// request. That rule used to be written out three times -- withRepair,
// repairLaoka and requireAuth -- and the copies were drifting.
//
// This module IS that rule, and nothing else. It never dispatches a request
// and never decides what a failed repair looks like: it returns a PLAN (or
// null when this request cannot be repaired), and each call site stays an
// adapter over it:
//
//   src/index.tsx          module APIs      -- retry the request with the plan
//   src/lib/middleware.ts  Sompitra pages   -- set the cookie and carry on
//
// What a signed-out response LOOKS like is the adapter's business too (the
// 401, the 200-no-user form, the redirect): the rule only answers "can this
// request be repaired, and with what".
//
// promoteSession lives here because "mint every module's cookie, return the
// target's" IS the repair decision; identity.ts keeps provisioning and the
// login-side minting.

import type { Env } from '../env'
import {
  HOME_COOKIE, SOMPITRA_COOKIE, WAY_COOKIE, LAOKA_COOKIE,
  mintModuleCookies, getHomeUserFromCookie,
} from '../identity'
import type { HomeUser } from '../identity'
import { isSecureRequest, readCookie } from './cookies'

export type RepairTarget = 'sompitra' | 'way' | 'laoka'

export interface RepairPlan {
  /** The person the live Home session belongs to. */
  homeUser: HomeUser
  /** The raw token the freshly minted cookie carries (the middleware
   * re-runs its own lookup with it, so nothing has to parse Set-Cookie). */
  token: string
  /** The full Set-Cookie value for the target module's fresh session. */
  setCookie: string
  /** The same request with the fresh cookie added to its Cookie header. A
   * fresh Request, because an incoming request's headers are immutable. */
  retryRequest: Request
}

/** Mint the target module's cookie for whoever holds a live Home session,
 * and return what the caller needs to finish the request -- or null when
 * there is no live Home session, or minting produced nothing (a missing
 * secret or a database hiccup; see mintModuleCookies).
 *
 * Minting runs the login path, so it creates every module's session cookie,
 * not just the target's -- one rule, one code path, so no module can be the
 * one whose repair path was forgotten (the writes are household-scale). It
 * never creates module ACCOUNTS, though: no password is passed, so a repair
 * can only ever restore sessions for people who already exist. */
export async function repairSession(request: Request, env: Env, target: RepairTarget): Promise<RepairPlan | null> {
  const homeUser = await getHomeUserFromCookie(env.HOME_DB, readCookie(request, HOME_COOKIE))
  if (!homeUser) return null

  const setCookie = await promoteSession(env, target, homeUser, isSecureRequest(request.url))
  if (!setCookie) return null

  // Re-send with the fresh module cookie. Cookie headers must be joined
  // with "; " -- Headers.append would join with ", ", which cookie parsers
  // cannot read, so the retry would still look signed-out.
  const pair = setCookie.split(';')[0]!
  const prior = request.headers.get('Cookie')
  const retryRequest = new Request(request.url, request)
  retryRequest.headers.set('Cookie', prior ? prior + '; ' + pair : pair)

  return { homeUser, token: pair.slice(pair.indexOf('=') + 1), setCookie, retryRequest }
}

/** Every module's cookie for this person, and the target's Set-Cookie value
 * or null (used by the auto-repair path only; login mints through
 * mintModuleCookies directly and keeps all of them). */
async function promoteSession(env: Env, target: RepairTarget, user: HomeUser, secure: boolean): Promise<string | null> {
  const cookies = await mintModuleCookies(env, user, secure)
  const want = target === 'sompitra' ? SOMPITRA_COOKIE : target === 'way' ? WAY_COOKIE : LAOKA_COOKIE
  return cookies.find((c) => c.name === want)?.value ?? null
}
