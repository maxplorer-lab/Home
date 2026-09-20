// ─── Home diagnostics ────────────────────────────────────────
// ONE ledger for the facts that used to vanish.
//
// The app is built on a deliberate-silence contract. µlogger must never see an
// error from an upload, and a notification must never break the action that
// triggered it — both are right, and both mean "silently fine" and "silently
// broken" look identical from the outside. That is the reason a real-world test
// of the tracking rules was not readable: a phone whose parked pings were all
// correctly collapsed and a phone that never uploaded at all produced the same
// observable.
//
// This module is where the difference gets written down.
//
// WHAT BELONGS HERE, and what deliberately does not:
//
//   * Tracking pings do NOT. They arrive every few seconds and a parked phone
//     produces thousands a night; W.A.Y counts its own gates in the FleetDO's
//     own SQLite instead (ingest_gates / ingest_drops), because pushing that
//     volume into D1 to record "the same parked phone was collapsed again" is
//     how a free-tier app dies.
//   * NOTIFICATIONS DO. A push that was refused, or skipped because nobody has
//     a channel or no server is set, is a few rows a day — and until now the
//     only trace was a console.log that a live `wrangler tail` had to be
//     running to catch. project.md documents exactly this class ("the three
//     ways a notification disappears without a trace"); this is the table that
//     answers it after the fact.
//
// Nothing in here may throw. Every caller is either a user action or an ingest
// path, and the project's own rule is that a user action fails loudly — never
// that diagnostics become a new failure mode (project.md, "A user ACTION must
// fail loudly, never silently").

import type { Env } from '../env'

/** Which module a fact belongs to. 'home' is the shell itself: login, admin,
 *  provisioning — facts that belong to no single module. */
export type DiagModule = 'home' | 'sompitra' | 'way' | 'laoka'

/** One word, so the page can group without parsing prose. */
export type DiagOutcome = 'refused' | 'skipped' | 'dropped' | 'failed'

export interface DiagEvent {
  module: DiagModule
  /** A short stable slug: 'notify-refused', 'notify-skipped', ... */
  kind: string
  /** Who or what it was about: a username, a device id, a database. */
  subject?: string | null
  /** Plain language, safe to show a person verbatim. */
  detail: string
  outcome: DiagOutcome
}

/**
 * Append one fact about something that did NOT happen.
 *
 * Best-effort by design and it never throws: the whole point of the ledger is
 * that a missing notification should be findable later, so a ledger that could
 * itself fail a user action would be a strictly worse trade than no ledger.
 * A write that fails says so in the log and returns.
 */
export async function recordDiag(env: Env, e: DiagEvent): Promise<void> {
  try {
    await env.HOME_DB
      .prepare(
        `INSERT INTO diag_events (at, module, kind, subject, detail, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(new Date().toISOString(), e.module, e.kind, e.subject ?? null, e.detail, e.outcome)
      .run()
  } catch (err) {
    console.log(
      `diag write failed (${e.module}/${e.kind}): ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** A grouped counter as the page reads it. */
export interface DiagCount {
  module: string
  kind: string
  outcome: string
  n: number
  last_at: string | null
}

/** A ledger row as the page reads it. */
export interface DiagRow {
  at: string
  module: string
  kind: string
  subject: string | null
  detail: string
  outcome: string
}

export interface DiagLedger {
  /** Newest first, capped at `limit`. */
  events: DiagRow[]
  /** Grouped over the WHOLE table, not just the page of events returned. */
  counts: DiagCount[]
  /** Total rows kept, and the window they cover — so "no failures" can be
   *  distinguished from "the table is empty because nothing ever wrote". */
  total: number
  first_at: string | null
  last_at: string | null
}

/**
 * Read the ledger: the newest page of events, plus counters grouped over the
 * whole table.
 *
 * Never throws either — it powers an admin page, and an admin page that 500s
 * because its own diagnostic table is missing is worse than one that says so.
 * A failure is returned as an `error` field rather than raised.
 */
export async function readDiag(
  env: Env,
  limit = 40
): Promise<DiagLedger & { error?: string }> {
  const empty: DiagLedger = { events: [], counts: [], total: 0, first_at: null, last_at: null }
  try {
    const rows = await env.HOME_DB
      .prepare(
        `SELECT at, module, kind, subject, detail, outcome
           FROM diag_events
          ORDER BY id DESC
          LIMIT ?`
      )
      .bind(Math.max(1, Math.min(500, limit)))
      .all<DiagRow>()

    const counts = await env.HOME_DB
      .prepare(
        `SELECT module, kind, outcome, COUNT(*) AS n, MAX(at) AS last_at
           FROM diag_events
          GROUP BY module, kind, outcome
          ORDER BY n DESC, module ASC`
      )
      .all<DiagCount>()

    const span = await env.HOME_DB
      .prepare(`SELECT COUNT(*) AS n, MIN(at) AS first_at, MAX(at) AS last_at FROM diag_events`)
      .first<{ n: number; first_at: string | null; last_at: string | null }>()

    return {
      events: rows.results ?? [],
      counts: counts.results ?? [],
      total: span?.n ?? 0,
      first_at: span?.first_at ?? null,
      last_at: span?.last_at ?? null,
    }
  } catch (err) {
    return {
      ...empty,
      error: `diag_events is unreadable (${err instanceof Error ? err.message : String(err)}) — apply migrations-home/0005_diagnostics.sql`,
    }
  }
}

/**
 * Drop ledger rows older than `days`. Called by the daily cron.
 *
 * Retention without a human in the loop, for the same reason W.A.Y's flush is
 * on the cron: a table that only shrinks when someone remembers is a table that
 * only grows. Never throws — a failed prune must not fail the nightly flush
 * that shares the handler.
 */
export async function pruneDiag(env: Env, days = 90): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const res = await env.HOME_DB
      .prepare(`DELETE FROM diag_events WHERE at < ?`)
      .bind(cutoff)
      .run()
    return res.meta?.changes ?? 0
  } catch (err) {
    console.log(`diag prune failed: ${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
}
