/**
 * Batched itemized entry — `node --test`.
 *
 * The reader lives in `src/lib/expense-batches.ts`, which the add-expense route
 * imports, so these tests exercise the real copy the Worker runs: no extraction
 * from a template, no second definition to drift. (The client only draws the
 * subtotals; the amounts and the notes are built HERE on the server.)
 *
 * No dev server, no database, no mocks. Run: `npm test`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BATCHES,
  MAX_LINES_PER_BATCH,
  batchNotes,
  legacyItemizedBatch,
  linePrice,
  noteAmount,
  readExpenseBatches,
} from '../src/lib/expense-batches.ts'

test('a batch becomes a category, a name, a subtotal and itemized notes', () => {
  const [batch] = readExpenseBatches({
    b0_category_id: 'cat-food',
    b0_description: 'Groceries',
    b0_name: ['Rice', 'Beans'],
    b0_price: ['3000', '1500'],
  })
  assert.deepEqual(batch, {
    categoryId: 'cat-food',
    description: 'Groceries',
    lines: [
      { name: 'Rice', price: 3000 },
      { name: 'Beans', price: 1500 },
    ],
    amount: 4500,
    notes: 'Rice: Ar 3,000\nBeans: Ar 1,500',
  })
})

test('two batches stay two transactions, each with its own category and total', () => {
  const batches = readExpenseBatches({
    b0_category_id: 'cat-food',
    b0_description: 'Groceries',
    b0_name: ['Rice', 'Beans'],
    b0_price: ['3000', '1500'],
    b1_category_id: 'cat-moto',
    b1_description: 'Motorcycle parts',
    b1_name: ['Chain', 'Oil'],
    b1_price: ['12000', '8000'],
  })
  assert.equal(batches.length, 2)
  assert.equal(batches[0].description, 'Groceries')
  assert.equal(batches[0].amount, 4500)
  assert.equal(batches[1].categoryId, 'cat-moto')
  assert.equal(batches[1].amount, 20000)
  assert.equal(batches[1].notes, 'Chain: Ar 12,000\nOil: Ar 8,000')
})

test('a single-line batch arrives as plain strings, not arrays', () => {
  const [batch] = readExpenseBatches({
    b0_category_id: 'cat-food',
    b0_description: 'Market',
    b0_name: 'Tomatoes',
    b0_price: '2000',
  })
  assert.equal(batch.amount, 2000)
  assert.deepEqual(batch.lines, [{ name: 'Tomatoes', price: 2000 }])
})

test('a removed batch leaves a gap, and the reader still returns the rest in order', () => {
  const batches = readExpenseBatches({
    b2_category_id: 'cat-third',
    b2_description: 'Third',
    b2_price: '300',
    b0_category_id: 'cat-first',
    b0_description: 'First',
    b0_price: '100',
  })
  assert.deepEqual(batches.map((b) => b.description), ['First', 'Third'])
})

test('an unnamed priced line counts in the money but has no note line', () => {
  const [batch] = readExpenseBatches({
    b0_name: ['', 'Beans'],
    b0_price: ['1200', '800'],
  })
  assert.equal(batch.amount, 2000)
  assert.equal(batch.notes, 'Beans: Ar 800')
})

test('a named line at zero keeps its note and adds nothing to the subtotal', () => {
  const [batch] = readExpenseBatches({
    b0_category_id: 'cat-gift',
    b0_description: 'Borrowed',
    b0_name: ['Borrowed chair'],
    b0_price: ['0'],
  })
  assert.equal(batch.amount, 0)
  assert.equal(batch.notes, 'Borrowed chair: Ar 0')
})

test('an empty row nobody filled is not a line', () => {
  const [batch] = readExpenseBatches({
    b0_name: ['Rice', '  ', ''],
    b0_price: ['', '', ''],
  })
  assert.deepEqual(batch.lines, [{ name: 'Rice', price: 0 }])
  assert.equal(batch.amount, 0)
})

test('a batch may have no category yet — the hand-off leaves it to the household', () => {
  const [batch] = readExpenseBatches({
    b0_category_id: '',
    b0_description: 'Laoka shopping 2026-10-24 – 2026-10-30',
    b0_name: 'Pork',
    b0_price: '4500',
  })
  assert.equal(batch.categoryId, null)
  assert.equal(batch.description, 'Laoka shopping 2026-10-24 – 2026-10-30')
})

test('the fields the page does not post are simply absent', () => {
  assert.deepEqual(readExpenseBatches({}), [])
  assert.deepEqual(readExpenseBatches({ mode: 'itemized', date: '2026-10-31' }), [])
})

// ─── prices ──────────────────────────────────────────────────
test('linePrice() reads whole Ariary and strips currency text', () => {
  assert.equal(linePrice('3000'), 3000)
  assert.equal(linePrice('3,000'), 3000)
  assert.equal(linePrice('Ar 3 000'), 3000)
  assert.equal(linePrice('1250.6'), 1251)
})

test('linePrice() refuses a negative instead of letting it shrink a subtotal', () => {
  assert.equal(linePrice('-500'), 0)
  assert.equal(linePrice(' -500 '), 0)
})

test('linePrice() answers 0 for junk, blanks and non-strings', () => {
  for (const value of ['', '   ', 'abc', 'Ar', null, undefined, {}]) {
    assert.equal(linePrice(value), 0, `value: ${JSON.stringify(value)}`)
  }
})

test('a negative or junk price cannot reduce the subtotal', () => {
  const [batch] = readExpenseBatches({
    b0_name: ['Rice', 'Beans', 'Salt'],
    b0_price: ['3000', '-500', 'abc'],
  })
  assert.equal(batch.amount, 3000)
})

// ─── notes ───────────────────────────────────────────────────
test('noteAmount() is the comma form the details panel parses', () => {
  assert.equal(noteAmount(0), 'Ar 0')
  assert.equal(noteAmount(1234), 'Ar 1,234')
  assert.equal(noteAmount(1234567), 'Ar 1,234,567')
})

test('batchNotes() returns null when no line is named', () => {
  assert.equal(batchNotes([]), null)
  assert.equal(batchNotes([{ name: '', price: 500 }]), null)
})

test('batchNotes() keeps a name containing a colon readable', () => {
  assert.equal(
    batchNotes([{ name: 'Pork: lean', price: 4500 }]),
    'Pork: lean: Ar 4,500',
  )
})

// ─── limits ──────────────────────────────────────────────────
test('the reader caps how many batches one form can create', () => {
  const body = {}
  for (let i = 0; i < MAX_BATCHES + 5; i += 1) {
    body[`b${i}_category_id`] = 'cat'
    body[`b${i}_description`] = `Batch ${i}`
    body[`b${i}_price`] = '100'
  }
  const batches = readExpenseBatches(body)
  assert.equal(batches.length, MAX_BATCHES)
  assert.equal(batches[0].description, 'Batch 0')
  assert.equal(batches.at(-1).description, `Batch ${MAX_BATCHES - 1}`)
})

test('the reader caps the lines a single batch can carry', () => {
  const names = Array.from({ length: MAX_LINES_PER_BATCH + 10 }, (_, i) => `Item ${i}`)
  const prices = names.map(() => '100')
  const [batch] = readExpenseBatches({ b0_name: names, b0_price: prices })
  assert.equal(batch.lines.length, MAX_LINES_PER_BATCH)
  assert.equal(batch.amount, MAX_LINES_PER_BATCH * 100)
})

// ─── the pre-batch form (a tab opened before the deploy) ─────
test('a stale single-list post still saves as one batch', () => {
  const batch = legacyItemizedBatch(
    { itemized_total: '4500', itemized_notes: 'Rice: Ar 3,000\r\nBeans: Ar 1,500' },
    'cat-food',
    'Groceries',
  )
  assert.deepEqual(batch, {
    categoryId: 'cat-food',
    description: 'Groceries',
    lines: [],
    amount: 4500,
    notes: 'Rice: Ar 3,000\nBeans: Ar 1,500',
  })
})

test('a stale post with no positive total is not a batch', () => {
  assert.equal(legacyItemizedBatch({ itemized_total: '0' }, null, null), null)
  assert.equal(legacyItemizedBatch({}, null, null), null)
})
