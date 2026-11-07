// ─── Medicine stock: the cupboard's shared rules ──────────────
// One concept, one module. Both surfaces that talk about medicine read THIS:
// `/meds` (the list and the form) and Home's cupboard card (which counts).
// Keeping the 30-day window and the expiry judgement here is what stops the
// card saying "2 expiring soon" over a list that labels one of them "in date".
//
// The table is `medications` (migrations-sompitra/0013_medications.sql): a
// household table that happens to live in the Sompitra database because that
// is the binding Home's own pages read.
import { localDate } from './utils'
import type { Medication } from '../db/schema'

/** "Expiring soon" means within this many days, in the household calendar. */
export const MED_SOON_DAYS = 30

/** The quantity dropdown's answers. Stored canonically ('units' | 'ml') so the
    LABEL ("Units" / "mL") is display-only and can change without a migration. */
export const MED_UNITS = { units: 'Units', ml: 'mL' } as const
export type MedUnit = keyof typeof MED_UNITS
export const MED_UNIT_KEYS = Object.keys(MED_UNITS) as MedUnit[]

export function medUnitOf(value: unknown): MedUnit {
  return value === 'ml' ? 'ml' : 'units'
}

export function medUnitLabel(unit: string): string {
  return MED_UNITS[medUnitOf(unit)]
}

/** The two line colours the cupboard allows, and ONLY those two. What a colour
    MEANS is the household's own business — this app stores the choice and
    paints it, and never invents a legend for it. NULL = no tint. */
export const MED_COLORS = { red: 'Red', yellow: 'Yellow' } as const
export type MedColor = keyof typeof MED_COLORS
export const MED_COLOR_KEYS = Object.keys(MED_COLORS) as MedColor[]

export function medColorOf(value: unknown): MedColor | null {
  return value === 'red' || value === 'yellow' ? value : null
}

/** The WHOLE row's tint and its 3px edge. An uncoloured row keeps a
    transparent edge of the same width, so choosing a colour does not shift
    the text of every other line sideways. */
export function medRowTone(color: string | null | undefined): string {
  if (color === 'red') return 'bg-red-100 dark:bg-red-900/30 border-red-400 dark:border-red-500'
  if (color === 'yellow') return 'bg-yellow-100 dark:bg-yellow-900/30 border-yellow-400 dark:border-yellow-500'
  return 'border-transparent'
}

/** "24 Units", "12.5 mL" — no trailing ".0" on a tablet count. */
export function formatMedQty(m: Pick<Medication, 'quantity' | 'unit'>): string {
  const n = Number(m.quantity) || 0
  const value = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
  return `${value} ${medUnitLabel(m.unit)}`
}

/** Whole days from `today` to a 'YYYY-MM-DD' date. Date-only, so no clock and
    no timezone arithmetic — the same rule as `addDays`. */
export function medDaysUntil(date: string, today = localDate()): number {
  return Math.round(
    (Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000,
  )
}

export type MedExpiry = { state: 'expired' | 'soon'; text: string; tone: string }

/** The one expiry judgement. NULL for an undated box — and for one that is
    comfortably in date, because the row already prints its date and a green
    "in date" chip on every line is noise. */
export function medExpiry(
  m: Pick<Medication, 'expires_on'>,
  today = localDate(),
): MedExpiry | null {
  if (!m.expires_on) return null
  const days = medDaysUntil(m.expires_on, today)
  if (days < 0) {
    return {
      state: 'expired',
      text: days === -1 ? 'expired yesterday' : `expired ${-days} days ago`,
      tone: 'text-red-600 dark:text-red-400',
    }
  }
  if (days === 0) {
    return { state: 'expired', text: 'expires today', tone: 'text-red-600 dark:text-red-400' }
  }
  if (days <= MED_SOON_DAYS) {
    return {
      state: 'soon',
      text: days === 1 ? 'expires tomorrow' : `expires in ${days} days`,
      // Orange is this app's "needs attention" step above red, and it is what
      // the cupboard card wears for the same fact.
      tone: 'text-orange-600 dark:text-orange-400',
    }
  }
  return null
}

export interface MedsSummary {
  items: number
  /** Already past their expiry date. */
  expired: number
  /** Expiring within MED_SOON_DAYS. */
  soon: number
}

/** Home's one-line answer about the cupboard. Counted in SQL rather than by
    loading every row, and scoped to the same window `medExpiry` uses. */
export async function medsSummary(db: D1Database, today = localDate()): Promise<MedsSummary> {
  const soonTo = new Date(Date.parse(today + 'T00:00:00Z') + MED_SOON_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS items,
              COALESCE(SUM(CASE WHEN expires_on IS NOT NULL AND expires_on < ? THEN 1 ELSE 0 END), 0) AS expired,
              COALESCE(SUM(CASE WHEN expires_on IS NOT NULL AND expires_on >= ? AND expires_on <= ? THEN 1 ELSE 0 END), 0) AS soon
         FROM medications`,
    )
    .bind(today, today, soonTo)
    .first<MedsSummary>()
  return { items: row?.items ?? 0, expired: row?.expired ?? 0, soon: row?.soon ?? 0 }
}
