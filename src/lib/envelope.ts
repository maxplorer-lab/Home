// ─── Envelopes ───────────────────────────────────────────────
// A budgeted category can be an ENVELOPE: money is moved into it (a funding
// transaction), and the purchases inside it are paid from that money.
//
// The ledger stores both kinds of row as `type='expense'`, because both take
// money out of something. What must never happen is counting the same money
// twice: a funded envelope would then charge the household once when it was
// filled and again for every bag of rice. So the two figures the app shows are
// slices of the same table, defined HERE once:
//
//   REAL_SPEND_SQL   what was bought        (reports, monthly Out, donuts)
//   MAIN_OUT_SQL     what left the main pot (cash on hand)
//
// They overlap only on purchases outside an envelope, which is correct: those
// are both spending and money out of the main pot. An envelope purchase is
// spending but NOT main-pot money (the funding already left); funding is the
// reverse.
//
// FUNDING IS MONTHLY. Two years of transfers are not what a Ar 200 000 month
// is measured against, so an envelope is described by the month that is on
// screen:
//
//   carriedIn   the balance it opened the month with (older funding − older
//               spending, i.e. last month's leftover — or its overdraft)
//   funded      transfers INTO it this month
//   spent       purchases FROM it this month
//   left        carriedIn + funded − spent
//
// `left` is also the envelope's whole balance: the three figures are just the
// same money split at the month boundary, so nothing has to be rewritten on
// the 1st. The counterpart sums are still lifetime sums behind the scenes;
// only what the screens PRINT is month-scoped.
//
// Both SQL constants expect the aliases `t` (transactions) and, for
// MAIN_OUT_SQL, `c` (categories) to be in scope.

/** Every expense actually bought, whichever pot paid for it. Needs `t`. */
export const REAL_SPEND_SQL = "(t.type = 'expense' AND t.is_envelope_transfer = 0)"

/** Money that left the main pot: funding, plus spending outside envelopes.
 *  Needs `t` and `c` (a LEFT JOIN is fine — a row with no category has
 *  `c.envelope_from IS NULL` and counts as main-pot spending). */
export const MAIN_OUT_SQL =
  "(t.type = 'expense' AND (t.is_envelope_transfer = 1 OR c.envelope_from IS NULL OR t.date < c.envelope_from))"

export interface EnvelopeBalance {
  /** Balance at the start of the month (negative = overdrawn last month). */
  carriedIn: number
  /** Transfers into the envelope in this month only. */
  funded: number
  /** Purchases from the envelope in this month only. */
  spent: number
  /** carriedIn + funded − spent: everything the envelope still holds. */
  left: number
}

const ALL_TIME = { start: '0000-01-01', end: '9999-12-31' }

/**
 * One row per open envelope, keyed by category id.
 *
 * With no month the figures are lifetime (`carriedIn` is 0). Pass the month
 * on screen to get the carried/funded/spent split that a monthly budget is
 * actually read against.
 *
 * Spending starts at `envelope_from`, so marking a category as an envelope
 * today cannot retroactively re-label last year's groceries or change a past
 * balance. A category that has never been funded has no `envelope_from` and
 * is absent.
 */
export async function envelopeBalances(
  db: D1Database,
  month: { start: string; end: string } = ALL_TIME,
): Promise<Map<string, EnvelopeBalance>> {
  const rows = await db.prepare(
    `SELECT c.id AS category_id,
            COALESCE(SUM(CASE WHEN t.is_envelope_transfer = 1 AND t.date >= ? AND t.date <= ? THEN t.amount END), 0) AS funded,
            COALESCE(SUM(CASE WHEN t.is_envelope_transfer = 0 AND t.date >= ? AND t.date <= ? AND t.date >= c.envelope_from THEN t.amount END), 0) AS spent,
            COALESCE(SUM(CASE WHEN t.is_envelope_transfer = 1 AND t.date < ? THEN t.amount END), 0)
              - COALESCE(SUM(CASE WHEN t.is_envelope_transfer = 0 AND t.date < ? AND t.date >= c.envelope_from THEN t.amount END), 0) AS carried_in
     FROM categories c
     LEFT JOIN transactions t ON t.category_id = c.id AND t.type = 'expense'
     WHERE c.envelope_from IS NOT NULL
     GROUP BY c.id`
  )
    .bind(month.start, month.end, month.start, month.end, month.start, month.start)
    .all<{ category_id: string; funded: number; spent: number; carried_in: number }>()

  const out = new Map<string, EnvelopeBalance>()
  for (const row of rows.results) {
    const carriedIn = row.carried_in
    out.set(row.category_id, {
      carriedIn,
      funded: row.funded,
      spent: row.spent,
      left: carriedIn + row.funded - row.spent,
    })
  }
  return out
}

/** Total money currently sitting in envelopes — part of net worth, not of the
 *  main pot, so the dashboard adds it back beside cash on hand. */
export function envelopeTotal(balances: Map<string, EnvelopeBalance>): number {
  let total = 0
  for (const b of balances.values()) total += b.left
  return total
}
