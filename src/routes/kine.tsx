/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { Layout, Card, KineClientStats } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import { mga, formatDate, generateId, currentWeekBounds } from '../lib/utils'
import { notifyTransaction, kineNotify } from '../lib/notify'
import type { Env, User, AttendanceTick, IncomeAccount, Customer, ServiceContract } from '../db/schema'

const kine = new Hono<{ Bindings: Env; Variables: { user: User } }>()
kine.use('*', requireAuth)

// ─── Which income account a Kiné payment lands in ─────────────
// Resolved, never hardcoded. This used to be `WHERE u.username='niri' AND
// ia.name='Kiné Privée'`, copied into both the preview page and the save
// handler, with the person's name printed in the copy: a rename, a second
// practitioner, or an admin-created account silently broke the sync, and the
// form promised income into an account it had not looked up.
//
// Order: the signed-in person's OWN Kiné account first (so a second
// practitioner works), then any account named "Kiné Privée" — which is where
// the household's existing payments already post, so nothing moves. The
// display name comes back with the row so the copy can name it from data.
async function kineIncomeAccount(
  db: D1Database,
  user: { id: string } | null,
): Promise<{ account: IncomeAccount; owner: string | null } | null> {
  const row = await db.prepare(
    `SELECT ia.* FROM income_accounts ia JOIN users u ON ia.user_id = u.id
      WHERE ia.name LIKE 'Kin%'
      ORDER BY CASE WHEN ia.user_id = ?1 THEN 0 ELSE 1 END, ia.created_at
      LIMIT 1`
  ).bind(user?.id ?? '').first<IncomeAccount & { owner?: string }>().catch(() => null)
  if (!row) return null
  const owner = await db
    .prepare('SELECT display_name FROM users WHERE id = ?')
    .bind(row.user_id)
    .first<{ display_name: string | null }>()
    .catch(() => null)
  return { account: row, owner: owner?.display_name || null }
}

interface ClientRow {
  customer_id: string
  customer_name: string
  phone: string | null
  default_rate: number
  contract_id: string | null
  title: string | null
  session_rate: number | null
  total_scheduled: number | null
  status: string | null
  start_date: string | null
  delivered_count: number
  paid_amount: number
}

interface EndedContractRow {
  contract_id: string
  customer_id: string
  customer_name: string
  phone: string | null
  default_rate: number
  title: string
  session_rate: number
  total_scheduled: number
  status: string
  start_date: string | null
  end_date: string | null
  delivered_count: number
  paid_amount: number
}

// ─── GET /kine ─────────────────────────────────────────────
kine.get('/', async (c) => {
  const user = c.get('user')
  const weekOffset = parseInt(c.req.query('w') || '0') || 0
  const { start, end } = currentWeekBounds(weekOffset)
  const weekLabel = `${formatDate(start)} – ${formatDate(end)}`

  // Search & filter
  const q = (c.req.query('q') || '').trim()
  const month = (c.req.query('month') || '').trim()
  const like = `%${q}%`

  // Active clients (with an active contract, or no contract yet)
  let activeSQL = `SELECT
       cu.id          AS customer_id,
       cu.name        AS customer_name,
       cu.phone       AS phone,
       cu.default_rate AS default_rate,
       sc.id          AS contract_id,
       sc.title       AS title,
       sc.session_rate AS session_rate,
       sc.total_scheduled AS total_scheduled,
       sc.status      AS status,
       sc.start_date  AS start_date,
       COALESCE((SELECT COUNT(*) FROM attendance_ticks at WHERE at.contract_id = sc.id AND at.is_delivered = 1), 0) AS delivered_count,
       COALESCE((SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.contract_id = sc.id), 0) AS paid_amount
     FROM customers cu
     LEFT JOIN service_contracts sc ON sc.customer_id = cu.id AND sc.status = 'active'`
  const activeParams: string[] = []
  const activeWheres: string[] = []
  // Always exclude clients who only have ended contracts (show them in "Ended" instead).
  // Include clients with an active contract OR no contracts at all.
  activeWheres.push('(sc.id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM service_contracts sc2 WHERE sc2.customer_id = cu.id))')
  if (q) { activeWheres.push('cu.name LIKE ?'); activeParams.push(like) }
  if (month) { activeWheres.push('sc.start_date LIKE ?'); activeParams.push(month + '%') }
  activeSQL += ' WHERE ' + activeWheres.join(' AND ')
  activeSQL += ' ORDER BY cu.created_at DESC'

  // Ended contracts (completed / cancelled)
  let endedSQL = `SELECT
       sc.id          AS contract_id,
       sc.customer_id AS customer_id,
       sc.title       AS title,
       sc.session_rate AS session_rate,
       sc.total_scheduled AS total_scheduled,
       sc.status      AS status,
       sc.start_date  AS start_date,
       sc.end_date    AS end_date,
       cu.name        AS customer_name,
       cu.phone       AS phone,
       cu.default_rate AS default_rate,
       COALESCE((SELECT COUNT(*) FROM attendance_ticks at WHERE at.contract_id = sc.id AND at.is_delivered = 1), 0) AS delivered_count,
       COALESCE((SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.contract_id = sc.id), 0) AS paid_amount
     FROM service_contracts sc
     JOIN customers cu ON cu.id = sc.customer_id
     WHERE sc.status != 'active'`
  const endedParams: string[] = []
  if (q) { endedSQL += ' AND cu.name LIKE ?'; endedParams.push(like) }
  if (month) { endedSQL += ' AND COALESCE(sc.end_date, sc.start_date) LIKE ?'; endedParams.push(month + '%') }
  endedSQL += ' ORDER BY sc.created_at DESC'

  const [clients, ended, weekTicks] = await Promise.all([
    activeParams.length > 0 ? c.env.DB.prepare(activeSQL).bind(...activeParams).all<ClientRow>() : c.env.DB.prepare(activeSQL).all<ClientRow>(),
    endedParams.length > 0 ? c.env.DB.prepare(endedSQL).bind(...endedParams).all<EndedContractRow>() : c.env.DB.prepare(endedSQL).all<EndedContractRow>(),
    c.env.DB.prepare(`SELECT * FROM attendance_ticks WHERE tick_date BETWEEN ? AND ?`).bind(start, end).all<AttendanceTick>(),
  ])
  const tickedSet = new Set(weekTicks.results.map(t => `${t.contract_id}:${t.tick_date}`))

  // Build 7 days SAT→FRI
  const days: string[] = []
  const d = new Date(start + 'T00:00:00')
  for (let i = 0; i < 7; i++) {
    days.push(d.toISOString().slice(0, 10))
    d.setDate(d.getDate() + 1)
  }
  const dayLabels = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']

  return c.html(
    <Layout title="Kiné" user={user} activeTab="kine">

      {/* Week nav */}
      <div class="flex items-center justify-between mb-4">
        <a href={`/kine?w=${weekOffset - 1}`} class="px-3 py-1.5 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm hover:bg-gray-50">◀ Prev</a>
        <span class="text-sm font-semibold text-gray-600 dark:text-gray-300">📅 {weekLabel}</span>
        <a href={`/kine?w=${weekOffset + 1}`} class="px-3 py-1.5 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm hover:bg-gray-50">Next ▶</a>
      </div>

      {/* Search + filter */}
      <form method="get" action="/kine" class="flex gap-2 mb-4">
        <input type="text" name="q" value={q} placeholder="Search by name…"
          class="flex-1 min-w-0 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm" />
        <input type="month" name="month" value={month}
          class="rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-2 py-2 text-sm" />
        <button type="submit" class="px-3 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-medium">Search</button>
        {(q || month) && <a href="/kine" class="px-3 py-2 rounded-xl text-sm text-red-500 font-medium self-center">Clear</a>}
      </form>

      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-bold">Active Clients</h2>
        <div class="flex gap-2">
          <a href="/kine/export" class="px-3 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">⬇ CSV</a>
          <a href="/kine/clients/new" class="px-4 py-2 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-semibold">+ New Client</a>
        </div>
      </div>

      {clients.results.length === 0
        ? (
          <div class="text-center py-16 text-gray-400">
            <div class="text-4xl mb-3">👐</div>
            <p>No clients yet.</p>
            <a href="/kine/clients/new" class="mt-3 inline-block text-green-600 dark:text-green-400 hover:underline text-sm">Add your first client →</a>
          </div>
        )
        : clients.results.map(client => {
            // Client without an active contract
            if (!client.contract_id) {
              return (
                <Card className="mb-4">
                  <div class="flex items-start justify-between">
                    <div class="min-w-0">
                      <h3 class="text-lg font-bold leading-tight truncate">{client.customer_name}</h3>
                      <p class="text-xs text-gray-500">Default rate: {mga(client.default_rate || 0)}</p>
                      {client.phone && <p class="text-xs text-gray-400">{client.phone}</p>}
                    </div>
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-bold text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">No Active Contract</span>
                      <a href={`/kine/clients/view/${client.customer_id}`} class="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded" title="View details">👁</a>
                      <a href={`/kine/clients/edit/${client.customer_id}`} class="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded">✏️</a>
                      <a href={`/kine/clients/delete/${client.customer_id}`} class="text-xs px-2 py-1 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 text-red-500 rounded">🗑</a>
                    </div>
                  </div>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <form method="post" action="/kine/contract/new">
                       <input type="hidden" name="customer_id" value={client.customer_id} />
                       <input type="hidden" name="session_rate" value={String(client.default_rate || 0)} />
                       <input type="hidden" name="title" value="5-Session Package" />
                       <input type="hidden" name="total_scheduled" value="5" />
                       <button type="submit" class="text-xs px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold">
                         + Start Package
                       </button>
                    </form>
                  </div>
                </Card>
              )
            }

            const billed = (client.delivered_count ?? 0) * (client.session_rate ?? 0)
            const paid   = client.paid_amount ?? 0
            const due    = billed - paid
            const total  = client.total_scheduled ?? 0
            const pct    = total > 0 ? Math.round(((client.delivered_count ?? 0) / total) * 100) : 0
            const rate   = client.session_rate ?? client.default_rate ?? 0

            return (
              <Card className="mb-4">
                {/* Header */}
                <div class="flex items-start justify-between gap-2 mb-2">
                  <div class="min-w-0">
                    <h3 class="text-lg sm:text-xl font-bold leading-tight truncate">{client.customer_name}</h3>
                    <p class="text-xs text-gray-500 mt-0.5">{client.title} · {mga(client.session_rate || 0)}/session</p>
                  </div>
                  <div class="flex items-center gap-1 shrink-0">
                    <a href={`/kine/clients/view/${client.customer_id}`} class="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded" title="View details">👁</a>
                    <a href={`/kine/clients/edit/${client.customer_id}`} class="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded">✏️</a>
                    <a href={`/kine/clients/delete/${client.customer_id}`} class="text-xs px-2 py-1 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 text-red-500 rounded">🗑</a>
                  </div>
                </div>

                {/* Per-client summary: delivered / paid / due */}
                <KineClientStats delivered={client.delivered_count ?? 0} paid={paid} rate={rate} />

                {/* Progress */}
                <div class="flex items-center gap-2 my-2">
                  <div class="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div class="h-full bg-green-500 rounded-full transition-all" style={`width:${pct}%`} />
                  </div>
                  <span class="text-[11px] text-gray-500 whitespace-nowrap">
                    {client.delivered_count ?? 0}/{total} sessions
                  </span>
                </div>

                {/* 7-day tick grid */}
                <div class="grid grid-cols-7 gap-1 mb-2">
                  {days.map((day, i) => {
                    const key = `${client.contract_id}:${day}`
                    const ticked = tickedSet.has(key)
                    const isToday = day === new Date().toISOString().slice(0, 10)
                    const isWeekend = i === 0 || i === 1 // Sat, Sun
                    return (
                      <form method="post" action={ticked ? `/kine/untick` : `/kine/tick`}>
                        <input type="hidden" name="contract_id" value={client.contract_id!} />
                        <input type="hidden" name="tick_date" value={day} />
                        <input type="hidden" name="week_offset" value={String(weekOffset)} />
                        <button type="submit"
                          class={`w-full aspect-square rounded-lg text-center text-[10px] font-semibold transition-all
                            ${ticked
                              ? 'bg-green-500 text-white'
                              : isWeekend
                                ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400 hover:bg-yellow-100 dark:hover:bg-yellow-900/40'
                                : 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40'}
                            ${!ticked && isToday ? ' ring-2 ring-amber-500' : ''}`}
                          title={day}
                        >
                          <span class="block leading-tight">{dayLabels[i]}</span>
                          <span class="block text-sm leading-none">{ticked ? '✓' : '·'}</span>
                        </button>
                      </form>
                    )
                  })}
                </div>

                {/* Actions */}
                <div class="flex gap-2 flex-wrap">
                  {due > 0 && (
                    <a href={`/kine/payment/new?contract_id=${client.contract_id}`}
                      class="text-xs px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white rounded-lg font-semibold">
                      💰 Log Payment
                    </a>
                  )}
                  <form method="post" action={`/kine/contract/${client.contract_id}/add-sessions`} class="flex items-center gap-1">
                    <input type="hidden" name="delta" value="5" />
                    <button type="submit" class="text-xs px-3 py-1.5 bg-blue-100 dark:bg-blue-900/30 hover:bg-blue-200 text-blue-600 dark:text-blue-400 rounded-lg">+5 Sessions</button>
                  </form>
                  <form method="post" action={`/kine/contract/${client.contract_id}/end`}
                    onsubmit="return confirm('Finish this contract?')">
                    <button type="submit" class="text-xs px-3 py-1.5 bg-green-50 dark:bg-green-900/20 hover:bg-green-100 dark:hover:bg-green-900/40 text-green-600 dark:text-green-400 rounded-lg font-semibold">✅ Finish</button>
                  </form>
                </div>
              </Card>
            )
          })
      }

      {/* Ended contracts */}
      {ended.results.length > 0 && (
        <div class="mt-6">
          <h2 class="text-lg font-bold mb-3">Ended Contracts</h2>
          <div class="space-y-3">
            {ended.results.map(ec => (
              <Card>
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <h4 class="font-semibold text-sm">{ec.customer_name}</h4>
                    <p class="text-xs text-gray-500">{ec.title} · {mga(ec.session_rate)}/session{ec.start_date ? ` · started ${ec.start_date}` : ''}{ec.end_date ? ` · finished ${ec.end_date}` : ''}</p>
                    <p class="text-xs mt-1">
                      <span class="text-blue-600 dark:text-blue-400 font-semibold">{ec.delivered_count} delivered</span>
                      <span class="mx-1 text-gray-400">·</span>
                      <span class="text-orange-600 dark:text-orange-400 font-semibold">{ec.paid_amount.toLocaleString('en-US')} MGA paid</span>
                    </p>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <span class={`text-[11px] px-2 py-0.5 rounded font-semibold capitalize ${ec.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>{ec.status}</span>
                    <a href={`/kine/clients/view/${ec.customer_id}`} class="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded" title="View details">👁</a>
                    <a href={`/kine/clients/edit/${ec.customer_id}`} class="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded" title="Edit client">✏️</a>
                    <form method="post" action={`/kine/contract/${ec.contract_id}/reopen`}>
                      <button type="submit" class="text-xs px-2 py-1 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 text-blue-600 dark:text-blue-400 rounded" title="Reopen contract">↻ Reopen</button>
                    </form>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </Layout>
  )
})

// ─── POST /kine/tick ───────────────────────────────────────
kine.post('/tick', async (c) => {
  const body = await c.req.parseBody()
  const contractId = String(body.contract_id)
  const tickDate   = String(body.tick_date)
  const wo = String(body.week_offset || '0')
  const id = generateId()
  const tickResult = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO attendance_ticks (id, contract_id, tick_date, is_delivered) VALUES (?, ?, ?, 1)`
  ).bind(id, contractId, tickDate).run()

  // Only a genuinely new tick notifies — INSERT OR IGNORE makes a repeat tap a
  // no-op, and a "session logged" push for it would be a lie.
  if (tickResult.meta.changes > 0) {
    const info = await c.env.DB.prepare(
      `SELECT cu.name AS customer_name,
              (SELECT COUNT(*) FROM attendance_ticks t
                WHERE t.contract_id = sc.id AND t.is_delivered = 1) AS delivered
         FROM service_contracts sc JOIN customers cu ON sc.customer_id = cu.id
        WHERE sc.id = ?`
    ).bind(contractId).first<{ customer_name: string; delivered: number }>()
    if (info) await kineNotify.sessionLogged(c.env, info.customer_name, info.delivered)
  }

  return c.redirect(`/kine?w=${wo}`)
})

// ─── POST /kine/untick ─────────────────────────────────────
kine.post('/untick', async (c) => {
  const body = await c.req.parseBody()
  const contractId = String(body.contract_id)
  const tickDate   = String(body.tick_date)
  const wo = String(body.week_offset || '0')
  await c.env.DB.prepare(
    `DELETE FROM attendance_ticks WHERE contract_id = ? AND tick_date = ?`
  ).bind(contractId, tickDate).run()
  return c.redirect(`/kine?w=${wo}`)
})

// ─── GET /kine/clients/new ────────────────────────────────
kine.get('/clients/new', async (c) => {
  const user = c.get('user')
  return c.html(
    <Layout title="New Client" user={user} activeTab="kine">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">👤 Add New Client</h2>
        <form method="post" action="/kine/clients/new" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client Name *</label>
            <input type="text" name="name" required placeholder="e.g. Sarah Johnson"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Phone / WhatsApp (optional)</label>
            <input type="text" name="phone" placeholder="+261 34 …"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Default Session Rate (MGA) *</label>
            <div class="grid grid-cols-4 gap-2 mb-2">
              {[{ l: '20k', v: 20000 }, { l: '15k', v: 15000 }, { l: '10k', v: 10000 }, { l: '25k', v: 25000 }].map(p => (
                <button type="button" data-v={p.v} onclick={`pickRate(${p.v})`}
                  class={`rate-chip py-2 rounded-xl text-sm font-semibold border transition-colors ${p.v === 20000 ? 'bg-green-600 text-white border-green-600' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600'}`}>
                  {p.l}
                </button>
              ))}
            </div>
            <input type="number" name="default_rate" id="default-rate" min="0" step="1" required value="20000" placeholder="Custom amount"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
            <p class="text-xs text-gray-400 mt-1">Tap a preset or type a custom amount.</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes / Address (optional)</label>
            <textarea name="notes" rows={2}
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500 resize-none" />
          </div>
          <hr class="border-gray-200 dark:border-gray-700" />
          <p class="text-sm font-semibold text-gray-700 dark:text-gray-300">Start First Package (optional)</p>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Package Title</label>
            <input type="text" name="pkg_title" placeholder="e.g. 10-Session Package"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Sessions</label>
            <div class="grid grid-cols-4 gap-2 mb-2">
              {[5, 7, 10, 15].map(n => (
                <button type="button" data-v={n} onclick={`pickSessions(${n})`}
                  class={`sess-chip py-2 rounded-xl text-sm font-semibold border transition-colors ${n === 5 ? 'bg-green-600 text-white border-green-600' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600'}`}>
                  {n}
                </button>
              ))}
            </div>
            <input type="number" name="pkg_sessions" id="pkg-sessions" min="1" value="5" placeholder="Custom"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Start Date</label>
            <input type="date" name="pkg_start" value={new Date().toISOString().slice(0, 10)}
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <button type="submit"
            class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl">
            Save Client
          </button>
        </form>
        <script dangerouslySetInnerHTML={{ __html: `
          const chipOff = 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600';
          const chipOn = 'bg-green-600 text-white border-green-600';
          function pickRate(v) {
            document.getElementById('default-rate').value = v;
            document.querySelectorAll('.rate-chip').forEach(function(c) {
              c.className = 'rate-chip py-2 rounded-xl text-sm font-semibold border transition-colors ' + (c.dataset.v === String(v) ? chipOn : chipOff);
            });
          }
          function pickSessions(v) {
            document.getElementById('pkg-sessions').value = v;
            document.querySelectorAll('.sess-chip').forEach(function(c) {
              c.className = 'sess-chip py-2 rounded-xl text-sm font-semibold border transition-colors ' + (c.dataset.v === String(v) ? chipOn : chipOff);
            });
          }
        `}} />
      </div>
    </Layout>
  )
})

// ─── POST /kine/clients/new ───────────────────────────────
kine.post('/clients/new', async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  const phone = String(body.phone || '').trim() || null
  const defaultRate = parseFloat(String(body.default_rate || '0'))
  const notes = String(body.notes || '').trim() || null
  const pkgTitle = String(body.pkg_title || '').trim()
  const pkgSessions = parseInt(String(body.pkg_sessions || '0'))
  const pkgStart = String(body.pkg_start || new Date().toISOString().slice(0, 10))

  if (!name || defaultRate <= 0) return c.redirect('/kine/clients/new')

  const customerId = generateId()
  await c.env.DB.prepare(
    'INSERT INTO customers (id, name, phone, default_rate, notes) VALUES (?, ?, ?, ?, ?)'
  ).bind(customerId, name, phone, defaultRate, notes).run()

  if (pkgTitle && pkgSessions > 0) {
    const contractId = generateId()
    await c.env.DB.prepare(
      `INSERT INTO service_contracts (id, customer_id, title, session_rate, total_scheduled, start_date)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(contractId, customerId, pkgTitle, defaultRate, pkgSessions, pkgStart).run()
  }

  await kineNotify.newClient(c.env, name)

  return c.redirect('/kine')
})

// ─── GET /kine/clients/view/:id (client detail) ──────────
kine.get('/clients/view/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const client = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first<Customer>()
  if (!client) return c.redirect('/kine')

  const [contracts, ticks, payments] = await Promise.all([
    c.env.DB.prepare(
      `SELECT sc.*,
         (SELECT COUNT(*) FROM attendance_ticks at WHERE at.contract_id = sc.id AND at.is_delivered = 1) AS delivered_count,
         COALESCE((SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.contract_id = sc.id), 0) AS paid_amount
       FROM service_contracts sc WHERE sc.customer_id = ? ORDER BY sc.created_at DESC`
    ).bind(id).all<ServiceContract>(),
    c.env.DB.prepare(
      `SELECT at.tick_date, at.is_delivered, sc.title AS contract_title
       FROM attendance_ticks at JOIN service_contracts sc ON at.contract_id = sc.id
       WHERE sc.customer_id = ? ORDER BY at.tick_date DESC`
    ).bind(id).all<{ tick_date: string; is_delivered: number; contract_title: string }>(),
    c.env.DB.prepare(
      `SELECT cp.amount, cp.payment_date, cp.notes, sc.title AS contract_title
       FROM client_payments cp JOIN service_contracts sc ON cp.contract_id = sc.id
       WHERE sc.customer_id = ? ORDER BY cp.payment_date DESC`
    ).bind(id).all<{ amount: number; payment_date: string; notes: string | null; contract_title: string }>(),
  ])

  return c.html(
    <Layout title={client.name} user={user} activeTab="kine">
      <a href="/kine" class="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mb-4 inline-block">← Back to Kiné</a>

      <Card className="mb-4">
        <div class="flex items-start justify-between">
          <div>
            <h2 class="text-xl font-bold">{client.name}</h2>
            <p class="text-sm text-gray-500 mt-1">Default rate: {mga(client.default_rate)}</p>
            {client.phone && <p class="text-sm text-gray-500">📞 {client.phone}</p>}
            {client.notes && <p class="text-sm text-gray-500 mt-1">📝 {client.notes}</p>}
          </div>
          <div class="flex gap-1.5">
            <a href={`/kine/clients/edit/${client.id}`} class="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded">✏️ Edit</a>
            <a href={`/kine/clients/delete/${client.id}`} class="text-xs px-2 py-1 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 text-red-500 rounded">🗑</a>
          </div>
        </div>
      </Card>

      {/* Contracts */}
      {contracts.results.length === 0
        ? <p class="text-sm text-gray-400 text-center py-6">No contracts yet.</p>
        : contracts.results.map(sc => {
            const delivered = sc.delivered_count ?? 0
            const paid = sc.paid_amount ?? 0
            const billed = delivered * sc.session_rate
            const due = billed - paid
            return (
              <Card className="mb-3">
                <div class="flex items-start justify-between mb-1">
                  <div>
                    <p class="font-semibold">{sc.title}</p>
                    <p class="text-xs text-gray-500">
                      {mga(sc.session_rate)}/session · {sc.total_scheduled} scheduled · started {sc.start_date}
                      {sc.end_date ? ` · finished ${sc.end_date}` : ''}
                    </p>
                  </div>
                  <span class={`text-[11px] px-2 py-0.5 rounded font-semibold capitalize ${sc.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>{sc.status}</span>
                </div>
                <div class="grid grid-cols-3 gap-2 text-center text-sm">
                  <div class="rounded-lg bg-blue-50 dark:bg-blue-900/20 py-2">
                    <p class="text-[12px] text-blue-600 dark:text-blue-400 font-semibold">Delivered</p>
                    <p class="font-bold text-blue-600 dark:text-blue-400">{delivered}</p>
                  </div>
                  <div class="rounded-lg bg-orange-50 dark:bg-orange-900/20 py-2">
                    <p class="text-[12px] text-orange-600 dark:text-orange-400 font-semibold">Paid</p>
                    <p class="font-bold text-orange-600 dark:text-orange-400">{paid.toLocaleString('en-US')}</p>
                  </div>
                  <div class={`rounded-lg py-2 ${due === 0 ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400' : due > 0 ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' : 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400'}`}>
                    <p class="text-[12px] font-semibold">Due</p>
                    <p class="font-bold">{due.toLocaleString('en-US')}</p>
                  </div>
                </div>
              </Card>
            )
          })
      }

      {/* Session history */}
      <Card title="🗓 Session History" className="mb-4">
        {ticks.results.length === 0
          ? <p class="text-sm text-gray-400 text-center py-3">No sessions recorded yet.</p>
          : (
            <div class="space-y-1 max-h-64 overflow-y-auto">
              {ticks.results.map(t => (
                <div class="flex justify-between text-sm py-1 border-b border-gray-100 dark:border-gray-700 last:border-0">
                  <span class="text-gray-600 dark:text-gray-300">{t.contract_title}</span>
                  <span class="text-gray-400">{t.tick_date} {t.is_delivered ? '✓' : ''}</span>
                </div>
              ))}
            </div>
          )
        }
      </Card>

      {/* Payment history */}
      <Card title="💰 Payment History">
        {payments.results.length === 0
          ? <p class="text-sm text-gray-400 text-center py-3">No payments yet.</p>
          : (
            <div class="space-y-1 max-h-64 overflow-y-auto">
              {payments.results.map(p => (
                <div class="flex justify-between text-sm py-1 border-b border-gray-100 dark:border-gray-700 last:border-0">
                  <div>
                    <span class="text-gray-600 dark:text-gray-300">{p.contract_title}</span>
                    {p.notes && <span class="text-xs text-gray-400"> · {p.notes}</span>}
                  </div>
                  <span class="font-semibold text-green-600 dark:text-green-400">{mga(p.amount)} <span class="text-xs text-gray-400">({p.payment_date})</span></span>
                </div>
              ))}
            </div>
          )
        }
      </Card>
    </Layout>
  )
})

// ─── GET /kine/export (CSV) ───────────────────────────────
kine.get('/export', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT cu.name AS client, sc.title, sc.session_rate, sc.total_scheduled, sc.status, sc.start_date, sc.end_date,
       (SELECT COUNT(*) FROM attendance_ticks at WHERE at.contract_id = sc.id AND at.is_delivered = 1) AS delivered,
       COALESCE((SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.contract_id = sc.id), 0) AS paid
     FROM service_contracts sc
     JOIN customers cu ON cu.id = sc.customer_id
     ORDER BY sc.created_at DESC`
  ).all<any>()

  const header = 'Client,Contract,Session Rate,Total Sessions,Status,Start Date,End Date,Delivered,Paid (MGA)'
  const csv = [header, ...rows.results.map((r: any) =>
    [r.client, r.title, r.session_rate, r.total_scheduled, r.status, r.start_date || '', r.end_date || '', r.delivered, r.paid]
      .map((v: any) => `"${v}"`).join(',')
  )].join('\n')

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sompitra-kine-contracts.csv"'
    }
  })
})

// ─── GET /kine/clients/edit/:id ─────────────────────────
kine.get('/clients/edit/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const client = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first<Customer>()
  if (!client) return c.redirect('/kine')

  return c.html(
    <Layout title="Edit Client" user={user} activeTab="kine">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">✏️ Edit Client</h2>
        <form method="post" action={`/kine/clients/edit/${id}`} class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Client Name *</label>
            <input type="text" name="name" required value={client.name}
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Phone / WhatsApp (optional)</label>
            <input type="text" name="phone" value={client.phone || ''} placeholder="+261 34 …"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Default Session Rate (MGA) *</label>
            <input type="number" name="default_rate" min="0" step="1" required value={String(client.default_rate)}
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes / Address (optional)</label>
            <textarea name="notes" rows={2}
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500 resize-none">{client.notes || ''}</textarea>
          </div>
          <button type="submit"
            class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl">
            Update Client
          </button>
        </form>
      </div>
    </Layout>
  )
})

// ─── POST /kine/clients/edit/:id ─────────────────────────
kine.post('/clients/edit/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  const phone = String(body.phone || '').trim() || null
  const defaultRate = parseFloat(String(body.default_rate || '0'))
  const notes = String(body.notes || '').trim() || null

  if (!name || defaultRate <= 0) return c.redirect(`/kine/clients/edit/${id}`)

  await c.env.DB.prepare(
    'UPDATE customers SET name = ?, phone = ?, default_rate = ?, notes = ? WHERE id = ?'
  ).bind(name, phone, defaultRate, notes, id).run()

  return c.redirect('/kine')
})

// ─── GET /kine/clients/delete/:id ───────────────────────
kine.get('/clients/delete/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const client = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first<Customer>()
  if (!client) return c.redirect('/kine')

  const linked = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM client_payments cp
     JOIN service_contracts sc ON cp.contract_id = sc.id
     WHERE sc.customer_id = ? AND cp.synced_transaction_id IS NOT NULL`
  ).bind(id).first<{ cnt: number }>()

  return c.html(
    <Layout title="Delete Client" user={user} activeTab="kine">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">🗑 Delete Client</h2>
        <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">
          You are about to delete <strong>{client.name}</strong> and all their contracts, attendance and payments.
        </p>
        <form method="post" action={`/kine/clients/delete/${id}`} class="space-y-4">
          <label class="flex items-start gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-600 cursor-pointer">
            <input type="checkbox" name="delete_transactions" value="1" checked class="mt-0.5 w-4 h-4 accent-red-600" />
            <div>
              <p class="text-sm font-semibold">Also delete linked budget income transactions</p>
              <p class="text-xs text-gray-400">Removes {linked?.cnt ?? 0} income transaction(s) that were synced to the budget from this client's payments.</p>
            </div>
          </label>
          <button type="submit" class="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl">Delete Client</button>
          <a href="/kine" class="block text-center text-sm text-gray-500 hover:underline">Cancel</a>
        </form>
      </div>
    </Layout>
  )
})

// ─── POST /kine/clients/delete/:id ───────────────────────
kine.post('/clients/delete/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.parseBody()
  const deleteTxns = body.delete_transactions === '1'

  const contracts = await c.env.DB.prepare('SELECT id FROM service_contracts WHERE customer_id = ?').bind(id).all<{ id: string }>()
  const contractIds = contracts.results.map(sc => sc.id)

  if (deleteTxns) {
    // Delete budget income transactions that were synced from this client's payments
    for (const cid of contractIds) {
      const payments = await c.env.DB.prepare(
        'SELECT synced_transaction_id FROM client_payments WHERE contract_id = ? AND synced_transaction_id IS NOT NULL'
      ).bind(cid).all<{ synced_transaction_id: string }>()
      for (const p of payments.results) {
        await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(p.synced_transaction_id).run()
      }
    }
  }

  for (const cid of contractIds) {
    await c.env.DB.prepare('DELETE FROM attendance_ticks WHERE contract_id = ?').bind(cid).run()
    await c.env.DB.prepare('DELETE FROM client_payments WHERE contract_id = ?').bind(cid).run()
  }
  await c.env.DB.prepare('DELETE FROM service_contracts WHERE customer_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM customers WHERE id = ?').bind(id).run()

  return c.redirect('/kine')
})

// ─── POST /kine/contract/new ─────────────────────────────
kine.post('/contract/new', async (c) => {
  const body = await c.req.parseBody()
  const customerId = String(body.customer_id)
  const title = String(body.title)
  const rate = parseFloat(String(body.session_rate))
  const sessions = parseInt(String(body.total_scheduled))
  const startDate = new Date().toISOString().slice(0, 10)

  const contractId = generateId()
  await c.env.DB.prepare(
    `INSERT INTO service_contracts (id, customer_id, title, session_rate, total_scheduled, start_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(contractId, customerId, title, rate, sessions, startDate).run()

  return c.redirect('/kine')
})

// ─── POST /kine/contract/:id/add-sessions ────────────────
kine.post('/contract/:id/add-sessions', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.parseBody()
  const delta = parseInt(String(body.delta || '5'))
  await c.env.DB.prepare(
    'UPDATE service_contracts SET total_scheduled = total_scheduled + ? WHERE id = ?'
  ).bind(delta, id).run()
  return c.redirect('/kine')
})

// ─── POST /kine/contract/:id/end ─────────────────────────
kine.post('/contract/:id/end', async (c) => {
  const id = c.req.param('id')
  const today = new Date().toISOString().slice(0, 10)
  await c.env.DB.prepare(
    "UPDATE service_contracts SET status='completed', end_date = ? WHERE id = ?"
  ).bind(today, id).run()

  const ended = await c.env.DB.prepare(
    `SELECT cu.name AS customer_name FROM service_contracts sc
       JOIN customers cu ON sc.customer_id = cu.id WHERE sc.id = ?`
  ).bind(id).first<{ customer_name: string }>()
  if (ended) await kineNotify.contractFinished(c.env, ended.customer_name)

  return c.redirect('/kine')
})

// ─── POST /kine/contract/:id/reopen ──────────────────────
kine.post('/contract/:id/reopen', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare(
    "UPDATE service_contracts SET status='active', end_date = NULL WHERE id = ?"
  ).bind(id).run()
  return c.redirect('/kine')
})

// ─── GET /kine/payment/new ───────────────────────────────
kine.get('/payment/new', async (c) => {
  const user = c.get('user')
  const contractId = c.req.query('contract_id') || ''
  const contract = await c.env.DB.prepare(
    `SELECT sc.*, cu.name AS customer_name,
       (SELECT COUNT(*) FROM attendance_ticks at WHERE at.contract_id = sc.id AND at.is_delivered=1) AS delivered_count,
       COALESCE((SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.contract_id = sc.id),0) AS paid_amount
     FROM service_contracts sc
     JOIN customers cu ON sc.customer_id = cu.id WHERE sc.id = ?`
  ).bind(contractId).first<any>()

  if (!contract) return c.redirect('/kine')

  const billed  = (contract.delivered_count ?? 0) * (contract.session_rate ?? 0)
  const balance = billed - (contract.paid_amount || 0)

  // Where this payment can sync to (see kineIncomeAccount).
  const syncTarget = await kineIncomeAccount(c.env.DB, user)

  return c.html(
    <Layout title="Log Payment" user={user} activeTab="kine">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-2">💰 Log Payment</h2>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-5">Client: <strong>{contract.customer_name}</strong></p>

        <Card className="mb-5">
          <div class="flex justify-between text-sm">
            <span class="text-gray-500">Total Billed</span>
            <span class="font-semibold">{mga(billed)}</span>
          </div>
          <div class="flex justify-between text-sm mt-1">
            <span class="text-gray-500">Already Paid</span>
            <span class="font-semibold text-green-600 dark:text-green-400">{mga(contract.paid_amount || 0)}</span>
          </div>
          <div class="flex justify-between text-sm mt-1 pt-1 border-t border-gray-100 dark:border-gray-700">
            <span class="font-semibold">Balance Due</span>
            <span class="font-bold text-orange-600">{mga(balance)}</span>
          </div>
        </Card>

        <form method="post" action="/kine/payment/new" class="space-y-4">
          <input type="hidden" name="contract_id" value={contractId} />
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Payment Amount (MGA)</label>
            <input type="number" name="amount" min="1" step="1" value={Math.round(balance)} required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Payment Date</label>
            <input type="date" name="payment_date" value={new Date().toISOString().slice(0, 10)} required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
            <input type="text" name="notes" placeholder="e.g. Cash payment"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          {syncTarget && (
            <label class="flex items-start gap-3 p-4 rounded-xl border-2 border-green-500 bg-green-50 dark:bg-green-900/20 cursor-pointer">
              <input type="checkbox" name="sync_to_budget" value="1" checked class="mt-0.5 w-4 h-4 accent-green-600" />
              <div>
                <p class="text-sm font-semibold text-green-700 dark:text-green-400">Sync to Budget Income</p>
                <p class="text-xs text-green-600 dark:text-green-500">
                  Adds this payment as income in {syncTarget.account.name}{syncTarget.owner ? ` (${syncTarget.owner})` : ''}
                </p>
              </div>
            </label>
          )}
          <button type="submit"
            class="w-full bg-orange-600 hover:bg-orange-700 text-white font-semibold py-3 rounded-xl">
            Save Payment
          </button>
        </form>
      </div>
    </Layout>
  )
})

// ─── POST /kine/payment/new ───────────────────────────────
kine.post('/payment/new', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const contractId = String(body.contract_id)
  const amount     = parseFloat(String(body.amount || '0'))
  const paymentDate= String(body.payment_date)
  const notes      = String(body.notes || '').trim() || null
  const syncBudget = body.sync_to_budget === '1'

  if (!amount || amount <= 0) return c.redirect('/kine')

  let syncedTxnId: string | null = null
  let clientName = ''

  if (syncBudget) {
    const target = await kineIncomeAccount(c.env.DB, user)
    if (target) {
      syncedTxnId = generateId()
      const contract = await c.env.DB.prepare(
        `SELECT sc.*, cu.name AS customer_name FROM service_contracts sc JOIN customers cu ON sc.customer_id=cu.id WHERE sc.id=?`
      ).bind(contractId).first<any>()
      clientName = contract?.customer_name || ''
      await c.env.DB.prepare(
        `INSERT INTO transactions (id, date, amount, type, income_account_id, description, added_by_user_id)
         VALUES (?, ?, ?, 'income', ?, ?, ?)`
      ).bind(syncedTxnId, paymentDate, amount, target.account.id, `${clientName} - ${target.account.name}`, user.id).run()
      // Renders as "{client} (Ar …) paid" via classifyTransaction
      await notifyTransaction(c.env, syncedTxnId)
    }
  }

  const paymentId = generateId()
  await c.env.DB.prepare(
    `INSERT INTO client_payments (id, contract_id, amount, payment_date, synced_transaction_id, notes) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(paymentId, contractId, amount, paymentDate, syncedTxnId, notes).run()

  // A payment that was NOT synced to the budget has no transaction to describe,
  // so it notifies directly — otherwise it would be silent.
  if (!syncedTxnId) {
    if (!clientName) {
      const p = await c.env.DB.prepare(
        `SELECT cu.name AS customer_name FROM service_contracts sc
           JOIN customers cu ON sc.customer_id = cu.id WHERE sc.id = ?`
      ).bind(contractId).first<{ customer_name: string }>()
      clientName = p?.customer_name || 'Kiné'
    }
    await kineNotify.paid(c.env, clientName, amount)
  }

  return c.redirect('/kine')
})

export default kine
