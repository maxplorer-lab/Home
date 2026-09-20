// ─── Live share links ────────────────────────────────────────────
// ONE device, ONE PIN, until the next 00:00 UTC, for somebody OUTSIDE the
// household — the "she's still driving, here's how you watch her" case.
//
// The whole feature is an exception to this app's only real rule about
// outsiders: everything else is behind one login. So the design is deliberately
// stingy, and every choice below is a refusal of something easier:
//
//   * the PIN is 6 digits because it has to be typable and relayable over the
//     phone by someone who is not technical — which means it is guessable in
//     principle, so it is never the only defence (see the rate limiter);
//   * the grant expires at the next 00:00 UTC and CANNOT be extended: a share
//     that quietly renews is a subscription nobody agreed to;
//   * it is revoked, not deleted, so the admin can still see that it existed -
//     one grant at a time from the card, or every open one at once; the console
//     lists what ended, and why (an admin, or the clock);
//   * the pin is stored as the same peppered hash as every password here, so a
//     dump of home-db is not a list of live pins;
//   * the viewer is a READER. It gets no session, no cookie, no socket into the
//     chat's Durable Object, and the page it loads is one document with no
//     household chrome in it at all.
//
// What it deliberately does NOT do: tell the person being watched. That was a
// decision, not an oversight (an admin acts for the household here, as it does
// when it creates accounts or resets a password) — but the grant records WHO
// created it, and every refused attempt lands in the diagnostics ledger, so the
// capability is accountable even where it is not announced.

import type { Env } from '../env'
import { hashPassword, verifyPassword, tooManyAttempts, noteAttempt, clearAttempts } from '../identity'
import { recordDiag } from './diagnostics'

/** The only grant kind today. A future one is a new value, not a new table. */
export const WAY_SHARE_KIND = 'way-live'

export const SHARE_PIN_DIGITS = 6

/** How long a grant's pin is verified against before it is treated as gone.
 *  Bounded so the verify loop stays a handful of rows even after a year. */
const RESOLVE_LOOKBACK_DAYS = 7
const RESOLVE_MAX_ROWS = 25

/** Failed pins, per caller, before the endpoint stops answering. Ten an hour
 *  against a 6-digit space is ~11,000 years to walk it, and the grant expires
 *  at midnight anyway — the limiter exists so that guessing is not FREE, not
 *  because the space is small on its own. */
const PIN_MAX_FAILURES = 10
const PIN_WINDOW_MINUTES = 60

export interface ShareRow {
  id: number
  kind: string
  subject: string
  label: string
  created_by: string
  created_at: string
  expires_at: string
  revoked_at: string | null
  last_used_at: string | null
}

export interface ShareStatus extends ShareRow {
  state: 'active' | 'expired' | 'revoked'
}

/** A row as the RESOLVE path needs it: the pin columns are selected only there,
 *  so the admin console can never render a hash by accident. */
type ShareRowWithPin = ShareRow & { pin_hash: string; pin_salt: string; pin_iterations: number }

/** Everything the console is allowed to see. Explicit, not `*`: a `SELECT *`
 *  would carry the pin hash into the rendered page. */
const SHARE_COLUMNS = 'id, kind, subject, label, created_by, created_at, expires_at, revoked_at, last_used_at'

/**
 * The next 00:00 UTC, as an ISO instant.
 *
 * Deliberately UTC midnight and not the app's own day boundary (21:00 UTC, the
 * W.A.Y flush): the person being shared is thinking in calendar days, and
 * "valid until midnight" is what the admin promises the viewer. The two can
 * disagree by three hours, which is written down in project.md rather than
 * smoothed over.
 *
 * Note the consequence for real use: a pin created at 23:50 UTC lives ten
 * minutes. That is the honest reading of "valid until midnight".
 */
export function nextUtcMidnight(from: Date = new Date()): string {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1)).toISOString()
}

/** A uniformly random 6-digit pin. `crypto`, not `Math.random`. */
export function newPin(): string {
  const max = 10 ** SHARE_PIN_DIGITS
  // Rejection sampling would be tidier, but 2^32 mod 10^6 is a bias of ~1 in
  // 4300 over an already-1,000,000 space behind a rate limiter — and the pin is
  // not a bearer token, it is half of one (the other half is the expiry).
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % max
  return String(n).padStart(SHARE_PIN_DIGITS, '0')
}

/** Digits only, exactly SHARE_PIN_DIGITS — so a typo never reaches the hasher. */
export function validPinShape(pin: unknown): pin is string {
  return typeof pin === 'string' && new RegExp(`^[0-9]{${SHARE_PIN_DIGITS}}$`).test(pin)
}

function stateOf(row: ShareRow, now = Date.now()): ShareStatus['state'] {
  if (row.revoked_at) return 'revoked'
  if (Date.parse(row.expires_at) <= now) return 'expired'
  return 'active'
}

/**
 * Mint a grant. Returns the pin ONCE — it is hashed before it is stored, so
 * this value cannot be recovered afterwards; the admin card says so and offers
 * regenerate instead of a "show pin" that could only ever lie.
 */
export async function createShare(
  env: Env,
  input: { kind: string; subject: string; label: string; createdBy: string }
): Promise<{ ok: true; share: ShareStatus; pin: string } | { ok: false; error: string }> {
  const label = String(input.label || '').trim().slice(0, 40)
  const subject = String(input.subject || '').trim()
  if (!subject) return { ok: false, error: 'no_subject' }
  if (!label) return { ok: false, error: 'no_label' }
  if (!String(env.AUTH_PEPPER || '').length) return { ok: false, error: 'no_pepper' }

  const pin = newPin()
  const { hash, salt, iterations } = await hashPassword(env, pin)
  const now = new Date()
  const expiresAt = nextUtcMidnight(now)
  const res = await env.HOME_DB
    .prepare(
      `INSERT INTO share_links (kind, subject, label, created_by, created_at, expires_at, pin_hash, pin_salt, pin_iterations)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(input.kind, subject, label, input.createdBy, now.toISOString(), expiresAt, hash, salt, iterations)
    .run()

  const id = res.meta?.last_row_id
  const row: ShareStatus = {
    id: Number(id ?? 0), kind: input.kind, subject, label,
    created_by: input.createdBy, created_at: now.toISOString(), expires_at: expiresAt,
    revoked_at: null, last_used_at: null, state: 'active',
  }
  return { ok: true, share: row, pin }
}

/** Which grants the console wants. A NAMED filter rather than a boolean: the
 *  card needs two lists (what is open, and what ended) and a `true`/`false`
 *  argument reads the same at both call sites. */
export type ShareFilter = 'active' | 'ended' | 'all'

/** Newest first, capped at 50 rows BEFORE the filter — so the console shows the
 *  newest state of things, not a complete history. It is a control surface, not
 *  an audit trail. */
export async function listShares(env: Env, filter: ShareFilter = 'active'): Promise<ShareStatus[]> {
  try {
    const rows = await env.HOME_DB
      .prepare(`SELECT ${SHARE_COLUMNS} FROM share_links ORDER BY created_at DESC LIMIT 50`)
      .all<ShareRow>()
    const now = Date.now()
    const all = (rows.results ?? []).map((r) => ({ ...r, state: stateOf(r, now) }))
    if (filter === 'all') return all
    return all.filter((r) => (filter === 'active' ? r.state === 'active' : r.state !== 'active'))
  } catch (err) {
    // The table may not exist yet on an environment that has not applied
    // migration 0006 — say so by returning nothing rather than 500ing the
    // admin console, which has to keep working.
    console.log(`share list failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

export async function revokeShare(env: Env, id: number): Promise<boolean> {
  try {
    const res = await env.HOME_DB
      .prepare(`UPDATE share_links SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL`)
      .bind(new Date().toISOString(), id)
      .run()
    return (res.meta?.changes ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * Revoke every grant that is still open — the "she has arrived, stop sharing"
 * button. Returns how many it actually ended (0 is a normal answer: nothing was
 * open, or the table is not there yet).
 *
 * Only grants the CLOCK has not already ended: stamping `revoked_at` on an
 * expired one would rewrite what happened, and the console's Ended list would
 * then credit an admin with a revocation that never took place. Best-effort like
 * the single revoke — a console action must not 500. */
export async function revokeAllShares(env: Env): Promise<number> {
  try {
    const now = new Date().toISOString()
    const res = await env.HOME_DB
      .prepare(`UPDATE share_links SET revoked_at = ?1 WHERE revoked_at IS NULL AND expires_at > ?1`)
      .bind(now)
      .run()
    return res.meta?.changes ?? 0
  } catch {
    return 0
  }
}

export type ResolveResult =
  | { ok: true; share: ShareStatus }
  | { ok: false; code: 'bad_pin' | 'expired' | 'revoked' }

/**
 * Turn a typed pin into the grant it belongs to.
 *
 * There is no lookup by pin — the pin is hashed with a per-row salt, so the
 * only honest way is to verify it against the recent grants. That is why the
 * candidate set is bounded (lookback + LIMIT): the loop stays a handful of
 * PBKDF2 verifies, and an old pin that has aged out simply reads as wrong.
 *
 * An expired or revoked pin is reported AS THAT, not as "wrong pin": the viewer
 * is a close one, and "this link ended at midnight" is a sentence they can act
 * on, while "wrong pin" sends them hunting for a typo that is not there.
 */
export async function resolveSharePin(env: Env, pin: string): Promise<ResolveResult> {
  if (!validPinShape(pin)) return { ok: false, code: 'bad_pin' }
  const cutoff = new Date(Date.now() - RESOLVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  let rows: ShareRowWithPin[] = []
  try {
    const res = await env.HOME_DB
      .prepare(
        `SELECT ${SHARE_COLUMNS}, pin_hash, pin_salt, pin_iterations
           FROM share_links WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT ${RESOLVE_MAX_ROWS}`
      )
      .bind(cutoff)
      .all<ShareRowWithPin>()
    rows = res.results ?? []
  } catch {
    return { ok: false, code: 'bad_pin' }
  }

  for (const row of rows) {
    // Same peppered scheme as a password, so the comparison is the tested one
    // (constant-time inside verifyPassword).
    const matches = await verifyPassword(env, pin, {
      password_hash: row.pin_hash,
      password_salt: row.pin_salt,
      password_iterations: row.pin_iterations,
    })
    if (!matches) continue
    const state = stateOf(row)
    const { pin_hash: _h, pin_salt: _s, pin_iterations: _i, ...share } = row
    if (state === 'revoked') return { ok: false, code: 'revoked' }
    if (state === 'expired') return { ok: false, code: 'expired' }
    return { ok: true, share: { ...share, state } }
  }
  return { ok: false, code: 'bad_pin' }
}

/** True once this caller has burned its failures for the window. */
export async function pinRateLimited(env: Env, ip: string): Promise<boolean> {
  try {
    return await tooManyAttempts(env.HOME_DB, `share-pin:${ip}`)
  } catch {
    return false
  }
}

/**
 * A caller who just resolved a pin is not an attacker, whatever it typed
 * before — so the failure counter is cleared on SUCCESS.
 *
 * That is not a kindness, it is the difference between a limiter and a trap: a
 * grandparent who fat-fingers the code twice, gets it right, and then opens the
 * link again tomorrow must not be two failures closer to being locked out. An
 * attacker never resolves anything, so their counter still runs up.
 */
export async function clearPinFailures(env: Env, ip: string): Promise<void> {
  try {
    await clearAttempts(env.HOME_DB, `share-pin:${ip}`)
  } catch {
    /* best-effort, like the counter itself */
  }
}

async function failureCount(env: Env, ip: string): Promise<number> {
  try {
    const row = await env.HOME_DB
      .prepare(`SELECT count FROM attempts WHERE key = ?1`)
      .bind(`share-pin:${ip}`)
      .first<{ count: number }>()
    return row?.count ?? 0
  } catch {
    return 0
  }
}

/**
 * Count one failed attempt, and leave a RECEIPT the first time this caller
 * fails in the window.
 *
 * The receipt is the point: this endpoint is the only unauthenticated door into
 * the app, so "somebody is guessing pins" must be something the household can
 * find afterwards rather than a line in a log nobody is tailing. It is written
 * on the FIRST failure only — otherwise the ledger becomes the attacker's
 * volume problem, which is the same trade the W.A.Y ledger makes in reverse.
 */
export async function notePinFailure(env: Env, ip: string, reason: string): Promise<void> {
  const before = await failureCount(env, ip)
  try {
    await noteAttempt(env.HOME_DB, `share-pin:${ip}`)
  } catch {
    /* the limiter must never be the thing that breaks the request */
  }
  if (before !== 0) return
  const window = `[${PIN_MAX_FAILURES} in ${PIN_WINDOW_MINUTES} min]`
  await recordDiag(env, {
    module: 'home',
    kind: 'share-refused',
    subject: ip,
    detail:
      reason === 'shape'
        ? `a live-share attempt did not even look like a ${SHARE_PIN_DIGITS}-digit PIN (from ${ip})`
        : `a live-share PIN did not match any grant (from ${ip}) — further failures from this caller are counted against ${window}`,
    outcome: 'refused',
  })
}

/** A refusal that belongs to a KNOWN grant (expired or revoked) — always worth
 *  recording: it means somebody is still holding yesterday's link. */
export async function noteShareRefusal(env: Env, code: string, share: ShareStatus | null, ip: string): Promise<void> {
  await recordDiag(env, {
    module: 'home',
    kind: 'share-refused',
    subject: share ? `${share.subject}` : ip,
    detail:
      code === 'expired'
        ? `a live-share link for ${share?.subject ?? 'a device'} was opened after it ended (${share?.expires_at ?? '?'} UTC)`
        : `a revoked live-share link for ${share?.subject ?? 'a device'} was opened`,
    outcome: 'refused',
  })
}

/** How stale `last_used_at` may get before a poll re-stamps it. */
const SHARE_TOUCH_MIN_MS = 60_000

/** Mark the grant as actually being watched.
 *
 *  A HEARTBEAT, not an audit log: the viewer polls every few seconds, so an
 *  unconditional write would be one D1 write per poll for a fact nobody reads at
 *  that resolution (the console says "opened 12:40"). The comparison lives in
 *  the statement, so this stays a single round trip. Best-effort: a failed stamp
 *  must never stop the viewer from seeing the map. */
export async function touchShare(env: Env, id: number): Promise<void> {
  try {
    const now = Date.now()
    await env.HOME_DB
      .prepare(
        `UPDATE share_links SET last_used_at = ?1
          WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?3)`
      )
      .bind(new Date(now).toISOString(), id, new Date(now - SHARE_TOUCH_MIN_MS).toISOString())
      .run()
  } catch {
    /* not worth failing a read over */
  }
}

// ─── The data the viewer sees ────────────────────────────────────

export interface LiveViewState {
  ok: true
  label: string
  expiresAt: string
  /** The device's newest fix, as the Durable Object knows it. */
  updatedAt: string | null
  /** Age of that fix, computed HERE so a viewer's own clock is irrelevant. */
  ageMs: number | null
  lat: number | null
  lng: number | null
  speed: number | null
  driving: boolean
  stationary: boolean
  /** Current geofence name, when it is inside one ("At Home"). */
  place: string | null
  /** [lat, lng, ISO] — today's track, possibly downsampled (see trackTotal). */
  track: Array<[number, number, string]>
  /** Points the day actually has, so the viewer can say "showing every Nth". */
  trackTotal: number
}

/**
 * Ask the FleetDO for ONE device's live state.
 *
 * The Durable Object and not `way-db`, and this is not an optimisation: D1 only
 * learns where a phone has been at the NIGHTLY flush, so a viewer reading the
 * database would be watching yesterday's commute. The DO is where today is.
 * It is asked for one device by id and answers with one device — a grant for
 * `MaxX` has no path to any other row.
 */
export async function readLiveView(env: Env, share: ShareStatus): Promise<LiveViewState | { ok: false; error: string }> {
  if (!env.FLEET_DO) return { ok: false, error: 'no_do' }
  try {
    const id = env.FLEET_DO.idFromName('fleet')
    const res = await env.FLEET_DO
      .get(id)
      .fetch(`https://fleet-do/share-state?device=${encodeURIComponent(share.subject)}`, { method: 'GET' })
    if (!res.ok) return { ok: false, error: `do_${res.status}` }
    const data = (await res.json()) as {
      position?: { lat: number; lng: number; at: string | null; speed: number | null; driving: boolean; stationary: boolean; place: string | null } | null
      track?: Array<[number, number, string]>
      trackTotal?: number
      now?: number
    }
    const p = data.position ?? null
    const updatedAt = p?.at ?? null
    const ageMs = updatedAt ? Math.max(0, Date.now() - Date.parse(updatedAt)) : null
    return {
      ok: true,
      label: share.label,
      expiresAt: share.expires_at,
      updatedAt,
      ageMs,
      lat: p?.lat ?? null,
      lng: p?.lng ?? null,
      speed: p?.speed ?? null,
      driving: p?.driving === true,
      stationary: p?.stationary === true,
      place: p?.place ?? null,
      track: Array.isArray(data.track) ? data.track : [],
      trackTotal: Number(data.trackTotal ?? (data.track?.length ?? 0)),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
