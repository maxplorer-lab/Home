/** @jsxImportSource hono/jsx */
// ─── Medicine stock ───────────────────────────────────────────
// The household cupboard: what is in it, when a box was opened, when it goes
// off, and how much is left — in Units or mL.
//
// This is a HOME surface, not a Sompitra money screen: it renders through the
// shared `Layout`/`Card` and wears the Home tab's accent (activeTab="dashboard"),
// because there is no medicine tab and the five-tab chrome is deliberate.
// Home's cupboard card links here; the card and this list share one expiry
// rule (`src/lib/medicine.ts`), so they cannot disagree.
import { Hono } from 'hono'
import { Layout, Card } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import { formatDate, generateId, localDate } from '../lib/utils'
import {
  MED_UNITS, MED_UNIT_KEYS, MED_COLORS, MED_COLOR_KEYS,
  formatMedQty, medExpiry, medUnitOf, medColorOf, medRowTone,
} from '../lib/medicine'
import type { Env, User, Medication } from '../db/schema'

const meds = new Hono<{ Bindings: Env; Variables: { user: User } }>()
meds.use('*', requireAuth)

// The form's one input shape, so the date boxes, the name box and the quantity
// box line up instead of each carrying its own idea of a field.
const INPUT = 'w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3'

/** A 'YYYY-MM-DD' from a form box, or NULL when it was left empty/invalid.
    Never a guessed date: an unopened box has no open date, and "no expiry"
    is a fact the list has to be able to say out loud. */
function dateOrNull(value: unknown): string | null {
  const s = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/** The quantity left. REAL because a bottle is measured in mL and part-used;
    clamped to two decimals so a typo cannot store 41.666666666. */
function qtyOf(value: unknown): number {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0
}

function medForm(opts: {
  action: string
  submit: string
  med?: Medication
  error?: string
}) {
  const { action, submit, med, error } = opts
  return (
    <form method="post" action={action} class="space-y-4">
      {error && <p class="text-sm font-semibold text-red-600 dark:text-red-400">{error}</p>}

      <div>
        <label for="name" class="block text-sm font-medium mb-1">Name</label>
        <input
          id="name" name="name" type="text" required
          value={med?.name ?? ''}
          placeholder="Paracetamol 500 mg"
          class={INPUT}
        />
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="opened_on" class="block text-sm font-medium mb-1">Open date</label>
          <input
            id="opened_on" name="opened_on" type="date"
            value={med?.opened_on ?? ''}
            class={INPUT}
          />
        </div>
        <div>
          <label for="expires_on" class="block text-sm font-medium mb-1">Expiry date</label>
          <input
            id="expires_on" name="expires_on" type="date"
            value={med?.expires_on ?? ''}
            class={INPUT}
          />
        </div>
      </div>

      <div>
        <label for="quantity" class="block text-sm font-medium mb-1">Current quantity</label>
        <div class="flex gap-2">
          <input
            id="quantity" name="quantity" type="number" required
            min="0" step="0.01" inputmode="decimal"
            value={med ? String(med.quantity) : ''}
            placeholder="0"
            class={`${INPUT} min-w-0 flex-1`}
          />
          <select name="unit" aria-label="Unit" class={`${INPUT} w-28 shrink-0`}>
            {MED_UNIT_KEYS.map(unit => (
              <option value={unit} selected={(med?.unit ?? 'units') === unit}>{MED_UNITS[unit]}</option>
            ))}
          </select>
        </div>
        <p class="t-micro mt-1">Units for tablets and capsules, mL for syrups and drops.</p>
      </div>

      <div>
        <label for="color" class="block text-sm font-medium mb-1">Colour</label>
        <select id="color" name="color" class={INPUT}>
          <option value="" selected={!med?.color}>None</option>
          {MED_COLOR_KEYS.map(color => (
            <option value={color} selected={med?.color === color}>{MED_COLORS[color]}</option>
          ))}
        </select>
        <p class="t-micro mt-1">Tints the whole line in the cupboard. Optional.</p>
      </div>

      <div class="flex gap-2 pt-1">
        <button
          type="submit"
          class="flex-1 text-white font-bold py-3 rounded-xl"
          style={{ backgroundColor: 'var(--accent-ink)' }}
        >
          {submit}
        </button>
        <a href="/meds" class="px-4 py-3 rounded-xl text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>
          Cancel
        </a>
      </div>
    </form>
  )
}

// ── The cupboard ───────────────────────────────────────────────
meds.get('/', async (c) => {
  const user = c.get('user')
  const today = localDate()
  // Soonest expiry first, so what needs using is at the top. A box with no
  // date on it is not urgent (there is nothing to be urgent about), so the
  // undated rows sit at the end rather than sorting as the oldest date.
  const rows = await c.env.DB
    .prepare('SELECT * FROM medications ORDER BY (expires_on IS NULL), expires_on, name COLLATE NOCASE')
    .all<Medication>()

  const items = rows.results

  return c.html(
    <Layout title="Medicine" user={user} activeTab="dashboard">
      <div class="flex items-baseline justify-between gap-3 mb-4">
        <h1 class="text-xl font-bold">Medicine</h1>
        <a
          href="/meds/new"
          class="text-white px-4 py-2 rounded-xl text-sm font-semibold"
          style={{ backgroundColor: 'var(--accent-ink)' }}
        >
          + Add
        </a>
      </div>

      <Card title="In the cupboard" icon="pill">
        {items.length === 0 ? (
          <div class="text-center py-6">
            <p class="text-sm font-semibold">Nothing tracked yet.</p>
            <p class="t-micro mt-1">
              <a href="/meds/new" class="underline decoration-dotted">Add the first item</a> so the family can see what is left.
            </p>
          </div>
        ) : (
          <div class="ledger">
            {items.map(m => {
              const expiry = medExpiry(m, today)
              return (
                <a
                  href={`/meds/${m.id}/edit`}
                  class={`flex items-center justify-between gap-3 py-3 pl-3 pr-1 -mx-1 rounded-r-xl border-l-[3px] transition-opacity active:opacity-70 ${medRowTone(m.color)}`}
                >
                  <span class="min-w-0">
                    <span class="block text-[13.5px] font-semibold truncate">{m.name}</span>
                    <span class="t-micro block truncate">
                      {m.opened_on ? `Opened ${formatDate(m.opened_on)}` : 'Not opened'}
                      {' · '}
                      {m.expires_on ? `Expires ${formatDate(m.expires_on)}` : 'No expiry date'}
                    </span>
                    {expiry && (
                      <span class={`block t-micro font-semibold ${expiry.tone}`}>{expiry.text}</span>
                    )}
                  </span>
                  <span class="shrink-0 text-right">
                    <span class="t-value block whitespace-nowrap">{formatMedQty(m)}</span>
                    <span class="t-micro">left</span>
                  </span>
                </a>
              )
            })}
          </div>
        )}
      </Card>
    </Layout>
  )
})

// ── Add ────────────────────────────────────────────────────────
meds.get('/new', (c) => {
  return c.html(
    <Layout title="Add medicine" user={c.get('user')} activeTab="dashboard">
      <div class="max-w-xl">
        <h1 class="text-xl font-bold mb-4">Add medicine</h1>
        <Card>
          {medForm({
            action: '/meds',
            submit: 'Save',
            error: c.req.query('err') === 'name' ? 'A medicine needs a name.' : undefined,
          })}
        </Card>
      </div>
    </Layout>
  )
})

meds.post('/', async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name ?? '').trim()
  if (!name) return c.redirect('/meds/new?err=name')

  await c.env.DB
    .prepare('INSERT INTO medications (id, name, opened_on, expires_on, quantity, unit, color) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(
      'med_' + generateId().slice(0, 8),
      name,
      dateOrNull(body.opened_on),
      dateOrNull(body.expires_on),
      qtyOf(body.quantity),
      medUnitOf(body.unit),
      medColorOf(body.color),
    )
    .run()

  return c.redirect('/meds')
})

// ── Edit / restock ─────────────────────────────────────────────
meds.get('/:id/edit', async (c) => {
  const med = await c.env.DB
    .prepare('SELECT * FROM medications WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Medication>()
  if (!med) return c.redirect('/meds')

  return c.html(
    <Layout title="Edit medicine" user={c.get('user')} activeTab="dashboard">
      <div class="max-w-xl">
        <h1 class="text-xl font-bold mb-4">Edit medicine</h1>
        <Card>
          {medForm({
            action: `/meds/${med.id}`,
            submit: 'Save changes',
            med,
            error: c.req.query('err') === 'name' ? 'A medicine needs a name.' : undefined,
          })}
          <form
            method="post"
            action={`/meds/${med.id}/delete`}
            class="mt-4 pt-4 hairline"
            onsubmit="return confirm('Remove this medicine from the cupboard?')"
          >
            <button type="submit" class="w-full text-sm font-semibold text-red-600 dark:text-red-400 py-2">
              Remove from the cupboard
            </button>
          </form>
        </Card>
      </div>
    </Layout>
  )
})

meds.post('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.parseBody()
  const name = String(body.name ?? '').trim()
  if (!name) return c.redirect(`/meds/${id}/edit?err=name`)

  await c.env.DB
    .prepare(
      `UPDATE medications
          SET name = ?, opened_on = ?, expires_on = ?, quantity = ?, unit = ?, color = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .bind(
      name,
      dateOrNull(body.opened_on),
      dateOrNull(body.expires_on),
      qtyOf(body.quantity),
      medUnitOf(body.unit),
      medColorOf(body.color),
      id,
    )
    .run()

  return c.redirect('/meds')
})

meds.post('/:id/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM medications WHERE id = ?').bind(c.req.param('id')).run()
  return c.redirect('/meds')
})

export default meds
