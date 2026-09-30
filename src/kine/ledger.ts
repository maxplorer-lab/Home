// ─── Kiné's one ledger ──────────────────────────────────────────
// The arithmetic that decides what a client owes, and what the week brought
// in, written once. Before this module the delivered/paid subqueries were
// pasted into eight statements across two routes, and "the balance" was
// derived in five places in two dialects: Home's balance tile counted SESSIONS
// (Math.round(paid / rate) − delivered, money printed as sessions × rate)
// while /kine, the client view and the payment form subtracted money
// (delivered × rate − paid). One client at Ar 10,000/session, 3 delivered and
// 25,000 paid read "balanced" on Home while /kine's own card said "Due 5,000";
// at 24,000 paid Home said "owes 10,000" against a real 6,000. Home's
// Uncollected Dues summed a third copy that multiplied by `sc.session_rate`
// with no fallback, so a contract with no session rate contributed 0 —
// COUNT(*) * NULL is NULL, and SUM ignores it.
//
// Kiné's truth is MONEY, exact: balance = delivered × rate − paid. The
// session-equivalent is a derived label (`sessionBalance`), never a second
// computation.
//
// The two SQL fragments are the row expressions every caller pastes into its
// OWN statement, under one contract: alias the contract table `sc`. Callers
// keep their own WHERE / ORDER / filters; they only stop re-writing what
// "delivered" and "paid" mean.
//
// No runtime imports, on purpose: plain node loads this file (scripts/smoke.mjs
// imports it directly), which is the test surface the pasted copies never had.
// ────────────────────────────────────────────────────────────────

/** One contract's delivered sessions, COALESCEd. Alias the contract table `sc`. */
export const DELIVERED_COUNT_SQL =
  `COALESCE((SELECT COUNT(*) FROM attendance_ticks at WHERE at.contract_id = sc.id AND at.is_delivered = 1), 0)`

/** One contract's payments, COALESCEd. Alias the contract table `sc`. */
export const PAID_SQL =
  `COALESCE((SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.contract_id = sc.id), 0)`

// `delivered` and `paid` are REQUIRED, and named exactly as the SQL selects
// them (`${DELIVERED_COUNT_SQL} AS delivered`, `${PAID_SQL} AS paid`). They were
// optional once, and a route whose columns were aliased `delivered_count` /
// `paid_amount` passed the row straight in: every field was undefined-able, so
// tsc said nothing and /kine's balance tile read a client with four delivered
// sessions as zero and called them settled. A missing name is now a type
// error, which is the only guard that runs before the page does.
export interface LedgerRow {
  delivered: number
  paid: number
  session_rate?: number | null
  default_rate?: number | null
}

export type LedgerState = 'balanced' | 'prepaid' | 'owes'

export interface ClientLedger {
  /** Sessions delivered against this contract. */
  delivered: number
  /** Money received against it. */
  paid: number
  /** What one session bills at: the contract's own rate, else the client's default. */
  rate: number
  billed: number
  /** billed − paid, in francs. > 0 the client owes; < 0 they paid ahead. */
  balance: number
  /** balance ÷ rate — the balance as a label for the balance tile, never an input. */
  sessionBalance: number
  state: LedgerState
}

export function clientLedger(row: LedgerRow): ClientLedger {
  const delivered = row.delivered ?? 0
  const paid = row.paid ?? 0
  const rate = row.session_rate ?? row.default_rate ?? 0
  const billed = delivered * rate
  const balance = billed - paid
  return {
    delivered,
    paid,
    rate,
    billed,
    balance,
    sessionBalance: rate > 0 ? balance / rate : 0,
    state: balance > 0 ? 'owes' : balance < 0 ? 'prepaid' : 'balanced',
  }
}

export interface WeekLedger {
  /** Delivered sessions (attendance ticks) dated inside the window. */
  delivered: number
  /** Payments dated inside the window. */
  paid: number
}

/** The week's two figures, as Home's summary reads them: every contract, no status filter. */
export async function weekLedger(db: D1Database, bounds: { start: string; end: string }): Promise<WeekLedger> {
  const [delivered, paid] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total FROM attendance_ticks WHERE is_delivered = 1 AND tick_date BETWEEN ? AND ?`
    ).bind(bounds.start, bounds.end).first<{ total: number }>(),
    db.prepare(
      `SELECT COALESCE(SUM(amount),0) AS total FROM client_payments WHERE payment_date BETWEEN ? AND ?`
    ).bind(bounds.start, bounds.end).first<{ total: number }>(),
  ])
  return { delivered: delivered?.total ?? 0, paid: paid?.total ?? 0 }
}
