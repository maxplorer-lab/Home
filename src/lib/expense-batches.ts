/**
 * Batched itemized entry: ONE form, MANY transactions.
 *
 * A batch is a category, a name and a list of priced lines. Its subtotal is the
 * sum of those lines, and saving the form writes one transaction per batch — so
 * the household can enter the groceries, the motorcycle parts and the
 * activities in one sitting and have each land in its own category, instead of
 * filling the form once per category.
 *
 * The page posts indexed field names (`b0_category_id`, `b0_name`, …) and a
 * repeated name carries an array of values. This module is the ONE reader of
 * that shape: the route imports it and `scripts/expense-batches.test.mjs` calls
 * it, so the subtotal shown on the form and the amount written to the budget
 * cannot disagree.
 *
 * Nothing here touches D1, the DOM or the request — it is plain data, which is
 * what lets a node test exercise the real copy.
 */

export interface ExpenseLine {
  name: string
  price: number
}

export interface ExpenseBatch {
  /** The chosen subcategory, or null — a hand-off deliberately leaves it empty. */
  categoryId: string | null
  /** The batch's name, which becomes its transaction's description. */
  description: string | null
  lines: ExpenseLine[]
  /** The subtotal: the sum of the lines' whole-Ariary prices. */
  amount: number
  /** `Name: Ar 1,234` per NAMED line — the ledger's existing itemized shape. */
  notes: string | null
}

/** A form cannot post more than this; each batch can hold at most this many lines. */
export const MAX_BATCHES = 20
export const MAX_LINES_PER_BATCH = 200

type Body = Record<string, unknown>

/** One field as posted: Hono gives an array for a repeated name and a string
 *  for a name that appears once (and a File when the form carried one). */
const list = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (value === undefined || value === null || typeof value === 'object') return []
  return [String(value)]
}

const text = (value: unknown): string => list(value)[0] || ''

/** Money as the itemized notes show it: `Ar 1 234` (comma form, like mga()). */
export function noteAmount(amount: number): string {
  const n = Math.round(Number.isFinite(amount) ? amount : 0)
  return 'Ar ' + n.toLocaleString('en-US')
}

/**
 * Whole Ariary from a typed or imported price. The boxes and the CSV importer
 * only produce digits, but the route is a door too: thousands separators are
 * stripped, a fraction is rounded (money here is whole Ariary), and a negative
 * or unreadable value is ZERO rather than a number that could reduce a subtotal.
 */
export function linePrice(raw: unknown): number {
  const s = String(raw ?? '').trim()
  if (!s || s.startsWith('-')) return 0
  const n = Number.parseFloat(s.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/**
 * The notes shape an itemized expense has always had: one `Name: Ar 1,234`
 * line per NAMED item, and nothing for an unnamed price (the money still counts;
 * there is simply no item to name). `parseItemLines` in the budget route turns
 * this back into the details panel's list.
 */
export function batchNotes(lines: ExpenseLine[]): string | null {
  const parts = lines
    .filter((l) => l.name)
    .map((l) => `${l.name}: ${noteAmount(l.price)}`)
  return parts.length ? parts.join('\n') : null
}

/**
 * Every batch the form posted, in the order the batches appear, gaps in the
 * indexes included. Each line's price is read on its own, so one junk row is a
 * zero rather than a broken subtotal.
 */
export function readExpenseBatches(body: Body): ExpenseBatch[] {
  const indexes = new Set<number>()
  for (const key of Object.keys(body)) {
    const m = /^b(\d+)_(?:category_id|description|name|price)$/.exec(key)
    if (m) indexes.add(Number(m[1]))
  }

  return [...indexes]
    .sort((a, b) => a - b)
    .slice(0, MAX_BATCHES)
    .map((i) => {
      const prefix = `b${i}_`
      const names = list(body[prefix + 'name'])
      const prices = list(body[prefix + 'price'])
      const lines: ExpenseLine[] = []
      const count = Math.min(Math.max(names.length, prices.length), MAX_LINES_PER_BATCH)
      for (let j = 0; j < count; j += 1) {
        const name = (names[j] || '').trim()
        const price = linePrice(prices[j])
        // A row nobody filled is not an item; a named row at 0 is (it is how a
        // free/owed line reads in the details panel), exactly as before.
        if (!name && !price) continue
        lines.push({ name, price })
      }
      const amount = lines.reduce((sum, line) => sum + line.price, 0)
      return {
        categoryId: text(body[prefix + 'category_id']).trim() || null,
        description: text(body[prefix + 'description']).trim() || null,
        lines,
        amount,
        notes: batchNotes(lines),
      }
    })
}

/**
 * The pre-batch form's single list, for a tab that was opened before the
 * deploy that introduced batches. It posted `itemized_total` + `itemized_notes`
 * and one top-level category/description, and a stale tab must still be able to
 * save rather than lose the receipt it is holding.
 *
 * Null when there is no positive total to save.
 */
export function legacyItemizedBatch(
  body: Body,
  categoryId: string | null,
  description: string | null,
): ExpenseBatch | null {
  const amount = linePrice(text(body.itemized_total))
  if (amount <= 0) return null
  const notes = text(body.itemized_notes).replace(/\r\n?/g, '\n').trim() || null
  return { categoryId, description, lines: [], amount, notes }
}
