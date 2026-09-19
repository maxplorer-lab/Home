/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { Layout, Card } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import { mga, formatDate, generateId, currentWeekBounds, userAccentColor } from '../lib/utils'
// The brand glyph set (see app-chrome.tsx) — money screens use the money icons.
import { Icon } from '../views/app-chrome'
import { notifyTransaction } from '../lib/notify'
import type { Env, User, Transaction, CategoryGroup, Category, IncomeAccount } from '../db/schema'

const budget = new Hono<{ Bindings: Env; Variables: { user: User } }>()
budget.use('*', requireAuth)

// ─── Helper: get categories with group names ──────────────────
async function getCategories(db: D1Database) {
  return db.prepare(
    `SELECT c.*, cg.name AS group_name FROM categories c
     JOIN category_groups cg ON c.group_id = cg.id
     ORDER BY cg.sort_order, c.sort_order`
  ).all<Category>()
}

// ─── Report helpers ──────────────────────────────────────────
function fmtLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function reportPeriod(key: string): { start: string; end: string; label: string } {
  const today = new Date()
  switch (key) {
    case 'last_week': {
      const { start, end } = currentWeekBounds(-1)
      return { start, end, label: 'Last Week (SAT–FRI)' }
    }
    case 'last_7_days': {
      const s = new Date(today); s.setDate(today.getDate() - 6)
      return { start: fmtLocal(s), end: fmtLocal(today), label: 'Last 7 Days' }
    }
    case 'this_month': {
      const s = new Date(today.getFullYear(), today.getMonth(), 1)
      const e = new Date(today.getFullYear(), today.getMonth() + 1, 0)
      return { start: fmtLocal(s), end: fmtLocal(e), label: 'This Month' }
    }
    case 'last_month': {
      const s = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      const e = new Date(today.getFullYear(), today.getMonth(), 0)
      return { start: fmtLocal(s), end: fmtLocal(e), label: 'Last Month' }
    }
    case 'last_30_days': {
      const s = new Date(today); s.setDate(today.getDate() - 29)
      return { start: fmtLocal(s), end: fmtLocal(today), label: 'Last 30 Days' }
    }
    case 'this_year': {
      const s = new Date(today.getFullYear(), 0, 1)
      return { start: fmtLocal(s), end: fmtLocal(today), label: 'This Year' }
    }
    case 'all': {
      return { start: '1970-01-01', end: '2999-12-31', label: 'All Time' }
    }
    default: {
      const { start, end } = currentWeekBounds(0)
      return { start, end, label: 'This Week (SAT–FRI)' }
    }
  }
}

// ── Comparison helpers (month keys are 'YYYY-MM') ──────────
function currentMonthKey(): string {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
}

function prevMonthKey(ym: string): string {
  const parts = ym.split('-')
  const y = parseInt(parts[0]) || new Date().getFullYear()
  const m = parseInt(parts[1]) || (new Date().getMonth() + 1)
  const d = new Date(y, m - 2, 1)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
}

function monthRange(ym: string): { start: string; end: string; label: string } {
  const parts = ym.split('-')
  const y = parseInt(parts[0]) || new Date().getFullYear()
  const m = parseInt(parts[1]) || (new Date().getMonth() + 1)
  const start = new Date(y, m - 1, 1)
  const end = new Date(y, m, 0)
  return {
    start: fmtLocal(start),
    end: fmtLocal(end),
    label: start.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
  }
}

async function getTrend(db: D1Database, start: string, end: string, periodKey: string) {
  const monthly = periodKey === 'this_year' || periodKey === 'all'
  const bucket = monthly ? 'substr(t.date, 1, 7)' : 't.date'
  const rows = await db.prepare(
    `SELECT ${bucket} AS bucket,
       COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END),0) AS income,
       COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END),0) AS expense
     FROM transactions t
     WHERE t.date BETWEEN ? AND ?
     GROUP BY ${bucket}
     ORDER BY bucket`
  ).bind(start, end).all<{ bucket: string; income: number; expense: number }>()
  return rows.results.map(r => ({
    bucket: monthly ? `${r.bucket.slice(5)}/${r.bucket.slice(0, 4)}` : `${r.bucket.slice(5)}/${r.bucket.slice(2, 4)}`,
    income: r.income,
    expense: r.expense,
  }))
}

// Delete a debt/credit and every transaction linked to it (initial + installments).
async function deleteDebtTxns(db: D1Database, accountId: string) {
  const account = await db.prepare(
    'SELECT synced_transaction_id FROM debt_credit_accounts WHERE id = ?'
  ).bind(accountId).first<{ synced_transaction_id: string | null }>()
  const txns: string[] = []
  if (account?.synced_transaction_id) txns.push(account.synced_transaction_id)
  const payments = await db.prepare(
    'SELECT synced_transaction_id FROM debt_credit_payments WHERE account_id = ? AND synced_transaction_id IS NOT NULL'
  ).bind(accountId).all<{ synced_transaction_id: string }>()
  for (const p of payments.results) txns.push(p.synced_transaction_id)
  for (const t of txns) await db.prepare('DELETE FROM transactions WHERE id = ?').bind(t).run()
  await db.prepare('DELETE FROM debt_credit_accounts WHERE id = ?').bind(accountId).run()
}

// ─── GET /budget ──────────────────────────────────────────────
budget.get('/', async (c) => {
  const user = c.get('user')
  const weekOffset = parseInt(c.req.query('w') || '0') || 0
  const { start, end } = currentWeekBounds(weekOffset)
  const weekLabel = `${formatDate(start)} – ${formatDate(end)}`

  const [txns, groups, categories] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.*, c.name AS category_name, cg.name AS group_name,
              ia.name AS income_account_name, u.display_name AS added_by_display_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN category_groups cg ON c.group_id = cg.id
       LEFT JOIN income_accounts ia ON t.income_account_id = ia.id
       LEFT JOIN users u ON t.added_by_user_id = u.id
       WHERE t.date BETWEEN ? AND ?
       ORDER BY t.date DESC, t.created_at DESC`
    ).bind(start, end).all<Transaction>(),

    c.env.DB.prepare('SELECT * FROM category_groups ORDER BY sort_order').all<CategoryGroup>(),
    getCategories(c.env.DB),
  ])

  // Spending by group for progress bars
  const spendingByGroup = await c.env.DB.prepare(
    `SELECT cg.id, cg.name, COALESCE(SUM(t.amount),0) AS spent,
            COALESCE(SUM(c.target_budget),0) AS budget
     FROM category_groups cg
     LEFT JOIN categories c ON c.group_id = cg.id
     LEFT JOIN transactions t ON t.category_id = c.id AND t.type='expense' AND t.date BETWEEN ? AND ?
     GROUP BY cg.id ORDER BY cg.sort_order`
  ).bind(start, end).all<{ id: string; name: string; spent: number; budget: number }>()

  // Income by source for chart
  const incomeBySource = await c.env.DB.prepare(
    `SELECT ia.name, COALESCE(SUM(t.amount),0) AS total
     FROM transactions t
     JOIN income_accounts ia ON t.income_account_id = ia.id
     WHERE t.type='income' AND t.date BETWEEN ? AND ?
     GROUP BY ia.id ORDER BY total DESC`
  ).bind(start, end).all<{ name: string; total: number }>()

  const totalIncome   = txns.results.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0)
  const totalExpenses = txns.results.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
  const net           = totalIncome - totalExpenses

  return c.html(
    <Layout title="Budget" user={user} activeTab="budget">

      {/* Sub-nav */}
      <div class="flex gap-1 mb-4 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
        <a href="/budget" class="flex flex-1 items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-semibold bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white"><Icon name="list" className="w-[15px] h-[15px]" />Overview</a>
        <a href="/budget/reports" class="flex flex-1 items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium text-gray-500 dark:text-gray-400"><Icon name="trend" className="w-[15px] h-[15px]" />Reports</a>
        <a href="/budget/transactions" class="flex flex-1 items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium text-gray-500 dark:text-gray-400"><Icon name="clock" className="w-[15px] h-[15px]" />History</a>
      </div>

      {/* Primary actions (most used) */}
      <div class="flex gap-2 mb-4">
        <a href="/budget/add-expense" class="flex-1 text-center py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-semibold shadow-sm">+ Add Expense</a>
        <a href="/budget/add-income" class="flex-1 text-center py-3 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-semibold shadow-sm">+ Add Income</a>
        <a href={`/budget/export?w=${weekOffset}`} class="flex items-center gap-1.5 px-4 py-3 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 text-sm font-semibold"><Icon name="arrow-in" className="w-[15px] h-[15px]" />CSV</a>
      </div>

      {/* Week navigator */}
      <div class="flex items-center justify-between mb-4">
        <a href={`/budget?w=${weekOffset - 1}`} class="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm hover:bg-gray-50"><Icon name="chev-left" className="w-[13px] h-[13px]" />Prev</a>
        <span class="flex items-center gap-1.5 text-sm font-semibold text-gray-600 dark:text-gray-300">
          <Icon name="calendar" className="w-[15px] h-[15px] text-gray-400" />{weekLabel}
        </span>
        <a href={`/budget?w=${weekOffset + 1}`} class="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm hover:bg-gray-50">Next<Icon name="chev-right" className="w-[13px] h-[13px]" /></a>
      </div>

      {/* Summary — the same palette as the dashboard's tiles, so the same
          three numbers do not change colour between the two screens:
          green = money in, red = money out, teal = net (Sompitra's own hue). */}
      <div class="grid grid-cols-3 gap-2 mb-4">
        <div class="bg-green-50 dark:bg-green-900/20 rounded-2xl p-3 text-center border border-green-100 dark:border-green-800">
          <p class="text-[10px] text-green-700 dark:text-green-400 font-semibold uppercase tracking-[.07em]">Income</p>
          <p class="num text-base sm:text-xl font-bold text-green-700 dark:text-green-400 truncate">{mga(totalIncome)}</p>
        </div>
        <div class="bg-red-50 dark:bg-red-900/20 rounded-2xl p-3 text-center border border-red-100 dark:border-red-800">
          <p class="text-[10px] text-red-700 dark:text-red-400 font-semibold uppercase tracking-[.07em]">Expenses</p>
          <p class="num text-base sm:text-xl font-bold text-red-700 dark:text-red-400 truncate">{mga(totalExpenses)}</p>
        </div>
        <div class={`rounded-2xl p-3 text-center border ${net >= 0 ? 'bg-teal-50 dark:bg-teal-900/20 border-teal-100 dark:border-teal-800' : 'bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-800'}`}>
          <p class={`text-[10px] font-semibold uppercase tracking-[.07em] ${net >= 0 ? 'text-teal-700 dark:text-teal-400' : 'text-orange-700 dark:text-orange-400'}`}>Net</p>
          <p class={`num text-base sm:text-xl font-bold truncate ${net >= 0 ? 'text-teal-700 dark:text-teal-400' : 'text-orange-700 dark:text-orange-400'}`}>{mga(net)}</p>
        </div>
      </div>

      {/* Charts */}
      <div class="grid md:grid-cols-2 gap-4 mb-5">
        <Card title="Expenses by Category" icon="donut">
          <div class="w-full max-w-[240px] mx-auto">
            <canvas id="expenseChart"></canvas>
          </div>
        </Card>
        <Card title="Income by Source" icon="arrow-in">
          <div class="w-full max-w-[240px] mx-auto">
            <canvas id="incomeChart"></canvas>
          </div>
        </Card>
      </div>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script dangerouslySetInnerHTML={{ __html: `
        function chartLegendColor() {
          return document.documentElement.classList.contains('dark') ? '#d1d5db' : '#374151';
        }
        const expenseCtx = document.getElementById('expenseChart').getContext('2d');
        const expenseData = ${JSON.stringify(spendingByGroup.results.filter(g => g.spent > 0))};
        const incomeCtx = document.getElementById('incomeChart').getContext('2d');
        const incomeData = ${JSON.stringify(incomeBySource.results)};
        const palette = ['#ef4444','#f97316','#f59e0b','#84cc16','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#d946ef','#f43f5e'];
        if (expenseData.length) {
          new Chart(expenseCtx, {
            type: 'doughnut',
            data: { labels: expenseData.map(g => g.name), datasets: [{ data: expenseData.map(g => g.spent), backgroundColor: palette, borderWidth: 0 }] },
            options: { responsive: true, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { color: chartLegendColor(), boxWidth: 12, padding: 8 } } } }
          });
        }
        if (incomeData.length) {
          new Chart(incomeCtx, {
            type: 'doughnut',
            data: { labels: incomeData.map(i => i.name), datasets: [{ data: incomeData.map(i => i.total), backgroundColor: ['#22c55e','#06b6d4','#3b82f6','#8b5cf6','#f59e0b','#f43f5e'], borderWidth: 0 }] },
            options: { responsive: true, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { color: chartLegendColor(), boxWidth: 12, padding: 8 } } } }
          });
        }
      `}} />

      {/* Category spending progress */}
      <Card title="Budget Progress" icon="target" className="mb-5">
        <div class="space-y-3">
          {spendingByGroup.results.map(g => {
            const pct = g.budget > 0 ? Math.min(100, Math.round((g.spent / g.budget) * 100)) : 0
            const barColor = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-400' : 'bg-green-500'
            return (
              <div>
                <div class="flex justify-between text-xs mb-1">
                  <span class="font-medium text-gray-700 dark:text-gray-300">{g.name}</span>
                  <span class="text-gray-500">{mga(g.spent)}{g.budget > 0 ? ` / ${mga(g.budget)}` : ''}</span>
                </div>
                {g.budget > 0 && (
                  <div class="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div class={`h-full rounded-full transition-all ${barColor}`} style={`width:${pct}%`} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </Card>

      {/* Transaction list */}
      <Card title="Transactions" icon="list">
        {/* Who the dots belong to, taken from the rows on screen rather than
            from names typed into this page. It used to read "Niri / MaxX"
            literally, so an admin-created third person got no entry at all and
            a rename left a stranger's name on the card. Same helper as the row
            dots, so a colour can never disagree with the legend. */}
        {(() => {
          const people = [...new Set(txns.results.map(t => t.added_by_display_name).filter(Boolean))] as string[]
          if (people.length < 2) return null
          return (
            <p class="text-[10px] text-gray-400 mb-3 -mt-1">
              {people.sort().map((name, i) => (
                <span class={i ? 'ml-3' : ''}>
                  <span class={`inline-block w-2 h-2 rounded-full ${userAccentColor(name)} mr-1 align-middle`} />
                  {name}
                </span>
              ))}
            </p>
          )
        })()}
        {txns.results.length === 0
          ? <p class="text-sm text-gray-400 text-center py-6">No transactions this week</p>
          : (
            <div class="divide-y divide-gray-100 dark:divide-gray-700">
              {txns.results.map(t => (
                <div class="flex items-start justify-between gap-2 py-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class={`w-1 h-4 shrink-0 rounded-full ${userAccentColor(t.added_by_display_name)}`} />
                      <p class="text-sm font-semibold truncate">
                        {t.description || t.category_name || t.income_account_name || '—'}
                      </p>
                      {t.is_recurring ? <span class="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded">🔄 Recurring</span> : null}
                    </div>
                    <p class="text-xs text-gray-400 mt-0.5">
                      {t.group_name ? `${t.group_name} › ${t.category_name}` : (t.income_account_name || '')}
                      {' · '}{t.added_by_display_name} · {t.date}
                    </p>
                    {t.notes && (
                      <details class="mt-1">
                        <summary class="text-xs text-gray-400 cursor-pointer hover:text-gray-600">📝 View items</summary>
                        <pre class="text-xs text-gray-500 dark:text-gray-400 mt-1 whitespace-pre-wrap font-mono bg-gray-50 dark:bg-gray-900 p-2 rounded-lg">{t.notes}</pre>
                      </details>
                    )}
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <span class={`text-sm font-bold ${t.type === 'income' ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                      {t.type === 'income' ? '+' : '-'}{mga(t.amount)}
                    </span>
                    <div class="flex gap-1">
                      <a href={`/budget/edit/${t.id}`} class="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600">✏️</a>
                      <form method="post" action={`/budget/delete/${t.id}`} style="display:inline"
                        onsubmit="return confirm('Delete this transaction?')">
                        <button type="submit" class="text-xs px-2 py-1 bg-red-50 dark:bg-red-900/20 text-red-500 rounded hover:bg-red-100">🗑</button>
                      </form>
                      {t.is_recurring === 0 && (
                        <form method="post" action={`/budget/copy/${t.id}`} style="display:inline">
                          <button type="submit" class="text-xs px-2 py-1 bg-blue-50 dark:bg-blue-900/20 text-blue-500 rounded hover:bg-blue-100" title="Copy as recurring">🔄</button>
                        </form>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        }
      </Card>

    </Layout>
  )
})

// ─── GET /budget/add-expense ──────────────────────────────────
budget.get('/add-expense', async (c) => {
  const user = c.get('user')
  const [cats, groups] = await Promise.all([
    getCategories(c.env.DB),
    c.env.DB.prepare('SELECT * FROM category_groups ORDER BY sort_order').all<CategoryGroup>(),
  ])

  return c.html(
    <Layout title="Add Expense" user={user} activeTab="budget">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">💳 Add Expense</h2>

        {/* Mode toggle */}
        <div class="flex gap-2 mb-5 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
          <button onclick="showMode('quick')" id="btn-quick"
            class="flex-1 py-2 rounded-lg text-sm font-semibold bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white">
            ⚡ Quick Entry
          </button>
          <button onclick="showMode('itemized')" id="btn-itemized"
            class="flex-1 py-2 rounded-lg text-sm font-semibold text-gray-500 dark:text-gray-400">
            📋 Itemized List
          </button>
        </div>

        <form method="post" action="/budget/add-expense" id="expense-form">
          <input type="hidden" name="mode" id="mode-input" value="quick" />

          <div class="space-y-4">
            {/* Date */}
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
              <input type="date" name="date" value={new Date().toISOString().slice(0,10)} required
                class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
            </div>

            {/* Subcategory */}
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category</label>
              <select name="category_id" required
                class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500">
                <option value="">Select subcategory…</option>
                {groups.results.map(g => (
                  <optgroup label={g.name}>
                    {cats.results.filter(c => c.group_id === g.id).map(cat => (
                      <option value={cat.id}>{cat.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {/* Description */}
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name / Description *</label>
              <input type="text" name="description" id="expense-description" required placeholder="e.g. Snack, Groceries…"
                class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
            </div>

            {/* ── QUICK MODE: single amount ── */}
            <div id="mode-quick">
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (MGA)</label>
              <input type="number" name="amount" id="quick-amount" min="0" step="1" placeholder="0"
                class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
            </div>

            {/* ── ITEMIZED MODE: line items table ── */}
            <div id="mode-itemized" class="hidden">
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Line Items</label>
              <div id="line-items" class="space-y-2 mb-3">
                <div class="flex gap-2 line-item">
                  <input type="text" placeholder="Item name" class="flex-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-green-500 item-name" />
                  <input type="number" placeholder="Price" min="0" step="1" class="w-28 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-green-500 item-price" oninput="recalcTotal()" />
                  <button type="button" onclick="this.closest('.line-item').remove();recalcTotal()" class="text-red-400 hover:text-red-600 px-2">✕</button>
                </div>
              </div>
              <div class="flex items-center gap-4 mb-3">
                <button type="button" onclick="addLine()"
                  class="text-sm text-green-600 dark:text-green-400 hover:underline">+ Add line</button>
                {/* Imports a Laoka two-column CSV (Item,Price). Parsed entirely in
                    the browser — the file is never uploaded and never stored. */}
                <button type="button" id="csv-btn"
                  class="text-sm text-gray-500 dark:text-gray-400 hover:underline">⬆ Import CSV</button>
              </div>
              <p id="csv-status" class="hidden text-[11px] mb-2"></p>
              <div class="flex items-center justify-between bg-gray-50 dark:bg-gray-700 rounded-xl px-4 py-3">
                <span class="text-sm font-semibold text-gray-700 dark:text-gray-300">Total</span>
                <span id="itemized-total-display" class="text-lg font-bold text-red-600">Ar 0</span>
              </div>
              <input type="hidden" name="itemized_total" id="itemized-total-input" value="0" />
              <input type="hidden" name="itemized_notes" id="itemized-notes-input" value="" />
            </div>

            {/* Notes */}
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
              <textarea name="notes" rows={2} placeholder="Extra details…"
                class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500 resize-none" />
            </div>

            <div class="flex gap-2">
              <button type="submit"
                class="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl transition-colors">
                Save Expense
              </button>
              {/* data-dismiss — the guard warns only if something was typed */}
              <a href="/budget" data-dismiss="Dismiss this expense? Everything entered will be lost."
                class="px-4 py-3 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 text-sm font-semibold transition-colors">Dismiss</a>
            </div>
          </div>
        </form>

        {/* Deliberately OUTSIDE #expense-form: a file field inside the form would
            be posted to the Worker along with the entry. */}
        <input type="file" id="csv-file" accept=".csv,text/csv" class="hidden" />
      </div>

      <script dangerouslySetInnerHTML={{ __html: `
        function showMode(m) {
          document.getElementById('mode-input').value = m;
          document.getElementById('mode-quick').classList.toggle('hidden', m !== 'quick');
          document.getElementById('mode-itemized').classList.toggle('hidden', m !== 'itemized');
          document.getElementById('btn-quick').classList.toggle('bg-white', m === 'quick');
          document.getElementById('btn-quick').classList.toggle('dark:bg-gray-700', m === 'quick');
          document.getElementById('btn-quick').classList.toggle('shadow', m === 'quick');
          document.getElementById('btn-quick').classList.toggle('text-gray-500', m !== 'quick');
          document.getElementById('btn-itemized').classList.toggle('bg-white', m === 'itemized');
          document.getElementById('btn-itemized').classList.toggle('dark:bg-gray-700', m === 'itemized');
          document.getElementById('btn-itemized').classList.toggle('shadow', m === 'itemized');
          document.getElementById('btn-itemized').classList.toggle('text-gray-500', m !== 'itemized');
        }
        function addLine(name, price) {
          const li = document.getElementById('line-items');
          const div = document.createElement('div');
          div.className = 'flex gap-2 line-item';
          div.innerHTML = \`<input type="text" placeholder="Item name" class="flex-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-green-500 item-name" />
            <input type="number" placeholder="Price" min="0" step="1" class="w-28 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-green-500 item-price" oninput="recalcTotal()" />
            <button type="button" onclick="this.closest('.line-item').remove();recalcTotal()" class="text-red-400 hover:text-red-600 px-2">✕</button>\`;
          // Optional values, used by the CSV import. Both must be set before the
          // row is appended so nothing renders mid-edit.
          if (name !== undefined && name !== null) div.querySelector('.item-name').value = name;
          if (price !== undefined && price !== null) div.querySelector('.item-price').value = price;
          li.appendChild(div);
          return div;
        }
        function recalcTotal() {
          const prices = Array.from(document.querySelectorAll('.item-price')).map(i => parseFloat(i.value)||0);
          const total = prices.reduce((s,v)=>s+v,0);
          document.getElementById('itemized-total-display').textContent = 'Ar ' + total.toLocaleString();
          document.getElementById('itemized-total-input').value = total;
          // build notes string
          const names  = Array.from(document.querySelectorAll('.item-name')).map(i => i.value.trim());
          const notes  = names.map((n,i) => n ? n + ': Ar ' + (prices[i]||0).toLocaleString() : null).filter(Boolean).join('\\n');
          document.getElementById('itemized-notes-input').value = notes;
        }

        // ── Import CSV (Laoka hand-off) ──────────────────────────
        // Two columns, item name and a positive whole price. The file is read in
        // the browser and discarded; nothing is uploaded and nothing is stored.
        // The parser is deliberately tolerant: comma or semicolon, an optional
        // header row, quoted names, UTF-8 BOM, CRLF, and stray currency text.
        function csvTitleFromFilename(filename) {
          // "Laoka_SEP_12__SEP_18(1).csv" -> "Laoka SEP 12 SEP 18"
          let s = String(filename || '').replace(/[.][A-Za-z0-9]{1,5}$/, '');
          // Browsers rename repeat downloads with an optional " (1)" counter.
          s = s.replace(/[(][0-9]+[)]$/, '').replace(/\\s+$/, '');
          // Hyphens inside a date-shaped run are kept; every other separator
          // becomes a space, so "Laoka - 2026-09-12" keeps its date readable.
          const parts = s.split(/([0-9]{4}-[0-9]{1,2}(?:-[0-9]{1,2})?)/);
          for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 1) continue;
            parts[i] = parts[i].replace(/[_\\u2013\\u2014-]+/g, ' ');
          }
          return parts.join('').replace(/\\s+/g, ' ').trim().slice(0, 120);
        }
        function splitCsvLine(line, delimiter) {
          const out = [];
          let cur = '';
          let quoted = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line.charAt(i);
            if (quoted) {
              if (ch === '"') {
                if (line.charAt(i + 1) === '"') { cur += '"'; i++; }
                else { quoted = false; }
              } else { cur += ch; }
            } else if (ch === '"') {
              quoted = true;
            } else if (ch === delimiter) {
              out.push(cur); cur = '';
            } else {
              cur += ch;
            }
          }
          out.push(cur);
          return out;
        }
        function parseCsvRows(text) {
          const rows = [];
          const skipped = [];
          let lines = String(text || '').split('\\n');
          let firstRow = true;
          let delimiter = ',';
          for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (line.charAt(line.length - 1) === '\\r') line = line.slice(0, -1);
            if (i === 0 && line.charAt(0) === '\\uFEFF') line = line.slice(1);
            if (!line.trim()) continue;
            if (firstRow) {
              delimiter = line.indexOf(';') !== -1 && line.indexOf(',') === -1 ? ';' : ',';
              firstRow = false;
            }
            const cells = splitCsvLine(line, delimiter);
            const name = (cells[0] || '').trim();
            // Keep digits only, so "Ar 3 000", "3,000" and "3000" all read the same.
            const digits = (cells[1] || '').replace(/[^0-9]/g, '');
            // The header row ("Item,Price") has no digits in column 2.
            if (i === 0 && !digits) continue;
            // A SHORT column 2 followed by a 3-digit column is a thousands
            // separator that got split ("pork,4,500"), not a third field. Skip and
            // report rather than silently record Ar 4 for a 4,500 purchase. A
            // plausible price ("rice,2000,500") keeps column 2 and ignores the rest.
            let suspicious = false;
            if (cells.length > 2 && /^[0-9]{1,3}$/.test((cells[1] || '').trim())) {
              for (let k = 2; k < cells.length; k++) {
                if (/^[0-9]{3}$/.test(cells[k].trim())) suspicious = true;
              }
            }
            const price = digits ? parseInt(digits, 10) : 0;
            if (!name || price <= 0 || suspicious) { skipped.push(i + 1); continue; }
            rows.push({ name: name, price: price });
          }
          return { rows: rows, skipped: skipped };
        }
        function readFileText(file, cb) {
          try {
            if (typeof file.text === 'function') {
              file.text().then(function (t) { cb(null, t); }, function () { cb(new Error('read failed')); });
              return;
            }
          } catch (e) {}
          try {
            const fr = new FileReader();
            fr.onload = function () { cb(null, String(fr.result || '')); };
            fr.onerror = function () { cb(new Error('read failed')); };
            fr.readAsText(file);
          } catch (e2) {
            cb(new Error('read failed'));
          }
        }
        function csvSay(message, isError) {
          const el = document.getElementById('csv-status');
          if (!el) return;
          el.textContent = message;
          el.className = 'text-[11px] mb-2 ' + (isError ? 'text-red-500' : 'text-gray-400 dark:text-gray-500');
        }
        // Replaces every current line item. Returns false when the user cancels.
        function applyImportedRows(rows, title) {
          const box = document.getElementById('line-items');
          const existing = Array.from(box.querySelectorAll('.line-item'));
          const names = Array.from(box.querySelectorAll('.item-name'));
          const prices = Array.from(box.querySelectorAll('.item-price'));
          const typed = names.some(function (n) { return n.value.trim() !== ''; }) ||
                        prices.some(function (p) { return p.value !== ''; });
          if (typed && !confirm('Replace the ' + existing.length + ' line item(s) already entered?')) {
            return false;
          }
          existing.forEach(function (row) { row.remove(); });
          rows.forEach(function (r) { addLine(r.name, r.price); });
          if (!box.querySelector('.line-item')) addLine();
          // The filename is the title; never overwrite a typed description.
          const desc = document.getElementById('expense-description');
          if (desc && title && !desc.value.trim()) desc.value = title;
          recalcTotal();
          return true;
        }
        const csvBtn = document.getElementById('csv-btn');
        const csvFile = document.getElementById('csv-file');
        if (csvBtn && csvFile) {
          csvBtn.addEventListener('click', function () { csvFile.click(); });
          csvFile.addEventListener('change', function () {
            const file = csvFile.files && csvFile.files[0];
            if (!file) return;
            if (file.size > 262144) {
              csvSay('That file is too big (256 KB limit).', true);
              csvFile.value = '';
              return;
            }
            readFileText(file, function (err, text) {
              // Allow the same file to be picked again after a failed attempt.
              csvFile.value = '';
              if (err) { csvSay('Could not read that file.', true); return; }
              const parsed = parseCsvRows(text);
              if (!parsed.rows.length) {
                csvSay('No rows with both an item name and a price were found.', true);
                return;
              }
              const capped = parsed.rows.length > 200;
              const rows = parsed.rows.slice(0, 200);
              if (!applyImportedRows(rows, csvTitleFromFilename(file.name))) {
                csvSay('Import cancelled — nothing was changed.', true);
                return;
              }
              let total = 0;
              for (let i = 0; i < rows.length; i++) total += rows[i].price;
              let msg = 'Imported ' + rows.length + ' item' + (rows.length === 1 ? '' : 's') +
                        ' · Ar ' + total.toLocaleString();
              if (capped) msg += ' · only the first 200 rows were used';
              if (parsed.skipped.length) {
                const shown = parsed.skipped.slice(0, 5).join(', ');
                msg += ' · skipped ' + parsed.skipped.length + ' (line' +
                       (parsed.skipped.length === 1 ? ' ' : 's ') + shown +
                       (parsed.skipped.length > 5 ? '…' : '') + ')';
              }
              csvSay(msg, false);
            });
          });
        }

        document.getElementById('expense-form').addEventListener('submit', function() {
          if (document.getElementById('mode-input').value === 'itemized') {
            recalcTotal();
          }
        });
      `}} />
    </Layout>
  )
})

// ─── POST /budget/add-expense ─────────────────────────────────
budget.post('/add-expense', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()

  const mode = String(body.mode || 'quick')
  const date = String(body.date)
  const categoryId = String(body.category_id)
  const description = String(body.description || '').trim() || null
  const quickNotes = String(body.notes || '').trim() || null

  let amount: number
  let notes: string | null

  if (mode === 'itemized') {
    amount = parseFloat(String(body.itemized_total || '0'))
    const itemizedNotes = String(body.itemized_notes || '').trim()
    notes = itemizedNotes || quickNotes
  } else {
    amount = parseFloat(String(body.amount || '0'))
    notes = quickNotes
  }

  if (!amount || amount <= 0) return c.redirect('/budget?err=invalid_amount')

  const id = generateId()
  await c.env.DB.prepare(
    `INSERT INTO transactions (id, date, amount, type, category_id, description, notes, added_by_user_id)
     VALUES (?, ?, ?, 'expense', ?, ?, ?, ?)`
  ).bind(id, date, amount, categoryId || null, description, notes, user.id).run()

  await notifyTransaction(c.env, id)
  return c.redirect('/budget')
})

// ─── GET /budget/add-income ───────────────────────────────────
budget.get('/add-income', async (c) => {
  const user = c.get('user')
  const accounts = await c.env.DB.prepare(
    `SELECT ia.*, u.display_name FROM income_accounts ia
     JOIN users u ON ia.user_id = u.id ORDER BY u.username, ia.name`
  ).all<IncomeAccount & { display_name: string }>()

  return c.html(
    <Layout title="Add Income" user={user} activeTab="budget">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">💵 Add Income</h2>
        <form method="post" action="/budget/add-income" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
            <input type="date" name="date" value={new Date().toISOString().slice(0,10)} required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Income Source</label>
            <select name="income_account_id" required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500">
              <option value="">Select income source…</option>
              {accounts.results.map(a => (
                <option value={a.id}>{(a as any).display_name} › {a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (MGA)</label>
            <input type="number" name="amount" min="0" step="1" placeholder="0" required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description *</label>
            <input type="text" name="description" required placeholder="e.g. July Salary"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
            <textarea name="notes" rows={2}
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500 resize-none" />
          </div>
          <div class="flex gap-2">
            <button type="submit"
              class="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl transition-colors">
              Save Income
            </button>
            {/* data-dismiss — the guard warns only if something was typed */}
            <a href="/budget" data-dismiss="Dismiss this income? Everything entered will be lost."
              class="px-4 py-3 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 text-sm font-semibold transition-colors">Dismiss</a>
          </div>
        </form>
      </div>
    </Layout>
  )
})

// ─── POST /budget/add-income ──────────────────────────────────
budget.post('/add-income', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const date = String(body.date)
  const incomeAccountId = String(body.income_account_id)
  const amount = parseFloat(String(body.amount || '0'))
  const description = String(body.description || '').trim() || null
  const notes = String(body.notes || '').trim() || null

  if (!amount || amount <= 0) return c.redirect('/budget?err=invalid_amount')

  const id = generateId()
  await c.env.DB.prepare(
    `INSERT INTO transactions (id, date, amount, type, income_account_id, description, notes, added_by_user_id)
     VALUES (?, ?, ?, 'income', ?, ?, ?, ?)`
  ).bind(id, date, amount, incomeAccountId, description, notes, user.id).run()

  await notifyTransaction(c.env, id)
  return c.redirect('/budget')
})

// ─── Laoka → Sompitra, without the CSV round trip ─────────────
//
// The old hand-off was: Laoka exports a CSV, you download it, open the
// itemized expense modal, click "Import CSV", pick the file. Four steps and a
// file, for data both apps already hold. These two endpoints replace it with
// one press.
//
// The rules are copied from Laoka's export so the result matches what the CSV
// would have produced: only lines with a price above zero, sorted A to Z by
// item name (case-insensitively), one `Name: Ar 1 234`-style note line each, and
// the sum in the amount. Laoka truncates prices to whole units; we do too.
//
// The ledger lives in home-db (`laoka_imports`) and is keyed by week, so this
// is idempotent by construction: a second press UPDATES the expense it created
// instead of adding a second one. That is the difference from the CSV path,
// which could not detect a double import at all.

/** Money as the itemized notes show it: `Ar 1 234` (comma form, like mga()). */
function noteAmount(amount: number): string {
  const n = Math.round(Number.isFinite(amount) ? amount : 0)
  return 'Ar ' + n.toLocaleString('en-US')
}

interface LaokaPricedLine { name: string; price: number }

/**
 * The priced lines of a Laoka week, in the exact order and shape Laoka's own
 * CSV export uses. Unpriced lines are not bought, so they are not expenses.
 */
async function laokaPricedLines(env: Env, weekId: number): Promise<LaokaPricedLine[]> {
  const { results } = await env.LAOKA_DB.prepare(
    `SELECT i.name AS name, l.price AS price
       FROM shopping_lines l
       JOIN items i ON i.id = l.item_id
      WHERE l.week_id = ?1 AND l.price IS NOT NULL AND l.price > 0`
  )
    .bind(weekId)
    .all<LaokaPricedLine>()
  const rows = (results || []).map((r) => ({ name: String(r.name), price: Math.trunc(Number(r.price)) }))
  rows.sort((a, b) => {
    const an = a.name.toLowerCase()
    const bn = b.name.toLowerCase()
    return an < bn ? -1 : an > bn ? 1 : 0
  })
  return rows
}

/**
 * Which category a Laoka shopping expense belongs in. Preferred: an explicit
 * `laoka_category_id` household setting. Otherwise the first category whose
 * name reads like food shopping, so a normal install files it under Groceries
 * with no configuration. NULL is a legitimate answer — the expense still
 * exists and is editable in Sompitra.
 */
async function laokaCategoryId(env: Env): Promise<string | null> {
  try {
    const set = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'laoka_category_id'`).first<{ value: string }>()
    const wanted = (set?.value || '').trim()
    if (wanted) {
      const hit = await env.DB.prepare('SELECT id FROM categories WHERE id = ?').bind(wanted).first<{ id: string }>()
      if (hit) return hit.id
    }
    const guess = await env.DB.prepare(
      `SELECT id, name FROM categories
        ORDER BY CASE WHEN lower(name) LIKE '%grocer%' THEN 0
                      WHEN lower(name) LIKE '%food%' THEN 1
                      WHEN lower(name) LIKE '%market%' THEN 2
                      WHEN lower(name) LIKE '%shopping%' THEN 3
                      ELSE 9 END, sort_order
        LIMIT 1`
    ).first<{ id: string; name: string }>()
    if (guess && /grocer|food|market|shopping/i.test(guess.name)) return guess.id
  } catch { /* a category is a nicety, never a blocker */ }
  return null
}

/** Describe the week the way a person would read it. */
function laokaDescription(startDate: string, endDate: string): string {
  return `Laoka shopping ${startDate} \u2013 ${endDate}`
}

// Status for the button: has this week already been sent, and to which expense?
budget.get('/laoka-import', async (c) => {
  const weekId = Number(c.req.query('week') || 0)
  if (!weekId) return c.json({ ok: false, error: 'a week id is required' }, 400)
  const row = await c.env.HOME_DB.prepare(
    'SELECT transaction_id, amount, item_count, imported_at, updated_at FROM laoka_imports WHERE laoka_week_id = ?'
  )
    .bind(weekId)
    .first<{ transaction_id: string; amount: number; item_count: number; imported_at: string; updated_at: string | null }>()
  if (!row) return c.json({ ok: true, sent: false })
  // The expense may have been deleted in Sompitra since. Reporting `sent` for a
  // transaction that no longer exists is what would make the button lie.
  const live = await c.env.DB.prepare('SELECT id FROM transactions WHERE id = ?').bind(row.transaction_id).first<{ id: string }>()
  return c.json({
    ok: true,
    sent: !!live,
    stale: !live,
    transactionId: row.transaction_id,
    amount: row.amount,
    itemCount: row.item_count,
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  })
})

// The one button. Creates the expense, or refreshes the one this week already
// owns. Returns JSON because the caller is Laoka's single-page app.
budget.post('/import-laoka', async (c) => {
  const user = c.get('user')
  const contentType = c.req.header('content-type') || ''
  let body: Record<string, unknown> = {}
  try {
    body = contentType.includes('application/json')
      ? ((await c.req.json()) as Record<string, unknown>)
      : ((await c.req.parseBody()) as Record<string, unknown>)
  } catch {
    return c.json({ ok: false, error: 'unreadable request body' }, 400)
  }

  const weekId = Number(body.week || 0)
  if (!weekId) return c.json({ ok: false, error: 'a week id is required' }, 400)

  const week = await c.env.LAOKA_DB.prepare('SELECT id, start_date, end_date FROM weeks WHERE id = ?')
    .bind(weekId)
    .first<{ id: number; start_date: string; end_date: string }>()
  if (!week) return c.json({ ok: false, error: 'no such week in Laoka' }, 404)

  const lines = await laokaPricedLines(c.env, weekId)
  if (!lines.length) {
    return c.json({ ok: false, error: 'nothing is priced yet, so there is nothing to send' }, 409)
  }

  const amount = lines.reduce((sum, l) => sum + l.price, 0)
  // Same shape the itemized modal builds from an imported CSV, so notes read
  // identically whichever route the numbers arrived by.
  const notes = lines.map((l) => `${l.name}: ${noteAmount(l.price)}`).join('\n')
  const description = laokaDescription(week.start_date, week.end_date)

  const existing = await c.env.HOME_DB.prepare('SELECT transaction_id FROM laoka_imports WHERE laoka_week_id = ?')
    .bind(weekId)
    .first<{ transaction_id: string }>()

  let transactionId: string | null = null
  let action: 'created' | 'updated' = 'created'

  if (existing) {
    const stillThere = await c.env.DB.prepare('SELECT id FROM transactions WHERE id = ?')
      .bind(existing.transaction_id)
      .first<{ id: string }>()
    if (stillThere) {
      // Refresh amount + items, but deliberately NOT the date, category or
      // description: those are the household's own choices once the expense
      // exists, and re-sending a shopping list must not undo them.
      await c.env.DB.prepare('UPDATE transactions SET amount = ?, notes = ? WHERE id = ?')
        .bind(amount, notes, existing.transaction_id)
        .run()
      transactionId = existing.transaction_id
      action = 'updated'
    }
  }

  if (!transactionId) {
    const categoryId = await laokaCategoryId(c.env)
    const id = generateId()
    await c.env.DB.prepare(
      `INSERT INTO transactions (id, date, amount, type, category_id, description, notes, added_by_user_id)
       VALUES (?, ?, ?, 'expense', ?, ?, ?, ?)`
    )
      .bind(id, new Date().toISOString().slice(0, 10), amount, categoryId, description, notes, user.id)
      .run()
    transactionId = id

    await c.env.HOME_DB.prepare(
      `INSERT INTO laoka_imports (laoka_week_id, transaction_id, amount, item_count, category_id, imported_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(laoka_week_id) DO UPDATE SET
         transaction_id = excluded.transaction_id, amount = excluded.amount,
         item_count = excluded.item_count, category_id = excluded.category_id,
         imported_at = excluded.imported_at, updated_at = NULL`
    )
      .bind(weekId, transactionId, amount, lines.length, categoryId, new Date().toISOString())
      .run()
  } else {
    await c.env.HOME_DB.prepare(
      'UPDATE laoka_imports SET amount = ?, item_count = ?, updated_at = ? WHERE laoka_week_id = ?'
    )
      .bind(amount, lines.length, new Date().toISOString(), weekId)
      .run()
  }

  // Mark the week as having left the app -- the same flag the CSV export sets,
  // so Laoka's "already exported" warning stays truthful about which numbers
  // went where.
  await c.env.LAOKA_DB.prepare("UPDATE weeks SET exported_at = datetime('now') WHERE id = ?1").bind(weekId).run()

  // Announce it to the household chat only the FIRST time. A re-send is a
  // correction to numbers already announced; repeating the "💸 … Ar 46 700"
  // line would read as a second purchase, which is exactly the confusion this
  // endpoint exists to prevent.
  if (action === 'created') await notifyTransaction(c.env, transactionId)

  return c.json({
    ok: true,
    action,
    transactionId,
    amount,
    itemCount: lines.length,
    weekId,
    description,
  })
})

// ─── GET /budget/edit/:id ─────────────────────────────────────
budget.get('/edit/:id', async (c) => {
  const id = c.req.param('id')
  const user = c.get('user')
  const t = await c.env.DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(id).first<Transaction>()
  if (!t) return c.redirect('/budget')

  const groups = await c.env.DB.prepare('SELECT * FROM category_groups ORDER BY sort_order').all<CategoryGroup>()
  const cats = await getCategories(c.env.DB)
  const incomeAccounts = await c.env.DB.prepare('SELECT * FROM income_accounts ORDER BY name').all<IncomeAccount>()

  return c.html(
    <Layout title="Edit Transaction" user={user} activeTab="budget">
      <Card title="Edit Transaction">
        <form method="post" action={`/budget/edit/${id}`} class="space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">Date</label>
            <input type="date" name="date" value={t.date} required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Amount (MGA)</label>
            <input type="number" name="amount" value={String(t.amount)} required min="1" step="1" class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Description</label>
            <input type="text" name="description" value={t.description || ''} class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3" />
          </div>
          {t.type === 'expense' ? (
            <div>
              <label class="block text-sm font-medium mb-1">Category</label>
              <select name="category_id" required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3">
                {groups.results.map(g => (
                  <optgroup label={g.name}>
                    {cats.results.filter(c => c.group_id === g.id).map(cat => (
                      <option value={cat.id} selected={cat.id === t.category_id}>{cat.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label class="block text-sm font-medium mb-1">Income Account</label>
              <select name="income_account_id" required class="w-full rounded-xl bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 p-3">
                {incomeAccounts.results.map(acc => (
                  <option value={acc.id} selected={acc.id === t.income_account_id}>{acc.name}</option>
                ))}
              </select>
            </div>
          )}
          <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition-colors">Update Transaction</button>
        </form>
      </Card>
    </Layout>
  )
})

// ─── POST /budget/edit/:id ────────────────────────────────────
budget.post('/edit/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.parseBody()
  const date = String(body.date)
  const amount = parseFloat(String(body.amount))
  const desc = String(body.description || '')
  
  if (!amount || amount <= 0) return c.redirect('/budget?err=invalid_amount')

  const t = await c.env.DB.prepare('SELECT type FROM transactions WHERE id = ?').bind(id).first<{type: string}>()
  if (!t) return c.redirect('/budget')

  if (t.type === 'expense') {
    const catId = String(body.category_id)
    await c.env.DB.prepare('UPDATE transactions SET date=?, amount=?, description=?, category_id=? WHERE id=?').bind(date, amount, desc, catId, id).run()
  } else {
    const incId = String(body.income_account_id)
    await c.env.DB.prepare('UPDATE transactions SET date=?, amount=?, description=?, income_account_id=? WHERE id=?').bind(date, amount, desc, incId, id).run()
  }

  return c.redirect('/budget')
})

// ─── POST /budget/delete/:id ──────────────────────────────────
budget.post('/delete/:id', async (c) => {
  const id = c.req.param('id')

  // Reverse debt/credit balance if this was a synced repayment/collection
  const payment = await c.env.DB.prepare(
    'SELECT id, account_id, amount FROM debt_credit_payments WHERE synced_transaction_id = ?'
  ).bind(id).first<{ id: string; account_id: string; amount: number }>()
  if (payment) {
    await c.env.DB.prepare(
      'UPDATE debt_credit_accounts SET current_balance = current_balance + ? WHERE id = ?'
    ).bind(payment.amount, payment.account_id).run()
    await c.env.DB.prepare('DELETE FROM debt_credit_payments WHERE id = ?').bind(payment.id).run()
  }

  // If this was the initial borrow/lend transaction, delete the whole debt/credit
  const debt = await c.env.DB.prepare(
    'SELECT id FROM debt_credit_accounts WHERE synced_transaction_id = ?'
  ).bind(id).first<{ id: string }>()
  if (debt) {
    await deleteDebtTxns(c.env.DB, debt.id)
  }

  await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(id).run()
  return c.redirect('/budget')
})

// ─── POST /budget/copy/:id (1-click recurring copy) ──────────
budget.post('/copy/:id', async (c) => {
  const id = c.req.param('id')
  const user = c.get('user')
  const original = await c.env.DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(id).first<Transaction>()
  if (!original) return c.redirect('/budget')

  const today = new Date().toISOString().slice(0, 10)
  const newId = generateId()
  await c.env.DB.prepare(
    `INSERT INTO transactions (id, date, amount, type, income_account_id, category_id, description, notes, added_by_user_id, is_recurring)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).bind(newId, today, original.amount, original.type, original.income_account_id, original.category_id,
    original.description, original.notes, user.id).run()

  return c.redirect('/budget')
})

// ─── GET /budget/export ───────────────────────────────────────
budget.get('/export', async (c) => {
  const weekOffset = parseInt(c.req.query('w') || '0') || 0
  const { start, end } = currentWeekBounds(weekOffset)

  const txns = await c.env.DB.prepare(
    `SELECT t.date, t.type, t.amount, t.description, c.name AS category,
            cg.name AS group_name, ia.name AS income_source, u.display_name AS added_by, t.notes
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     LEFT JOIN category_groups cg ON c.group_id = cg.id
     LEFT JOIN income_accounts ia ON t.income_account_id = ia.id
     LEFT JOIN users u ON t.added_by_user_id = u.id
     WHERE t.date BETWEEN ? AND ?
     ORDER BY t.date DESC`
  ).bind(start, end).all<any>()

  const rows = txns.results
  const header = 'Date,Type,Amount (MGA),Description,Category,Group,Income Source,Added By,Notes'
  const csv = [header, ...rows.map((r: any) =>
    [r.date, r.type, r.amount, r.description||'', r.category||'', r.group_name||'', r.income_source||'', r.added_by||'', (r.notes||'').replace(/\n/g,' ')].map((v: any) => `"${v}"`).join(',')
  )].join('\n')

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sompitra-${start}-${end}.csv"`
    }
  })
})

// ─── GET /budget/categories (manage) ─────────────────────────
budget.get('/categories', async (c) => {
  const user = c.get('user')
  const [groups, cats] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM category_groups ORDER BY sort_order').all<CategoryGroup>(),
    getCategories(c.env.DB),
  ])

  return c.html(
    <Layout title="Manage Categories" user={user} activeTab="settings">
      <h2 class="text-xl font-bold mb-5">⚙️ Manage Categories</h2>
      <div class="grid md:grid-cols-2 gap-4">
        {/* Add group */}
        <Card title="Add Category Group">
          <form method="post" action="/budget/categories/add-group" class="space-y-3">
            <input type="text" name="name" placeholder="Group name (e.g. Bike 2)" required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-green-500" />
            <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white text-sm font-semibold py-2 rounded-xl">Add Group</button>
          </form>
        </Card>
        {/* Add subcategory */}
        <Card title="Add Subcategory">
          <form method="post" action="/budget/categories/add-category" class="space-y-3">
            <select name="group_id" required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-green-500">
              <option value="">Select group…</option>
              {groups.results.map(g => <option value={g.id}>{g.name}</option>)}
            </select>
            <input type="text" name="name" placeholder="Subcategory name" required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-green-500" />
            <input type="number" name="target_budget" placeholder="Monthly target (MGA, optional)" min="0" step="1"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-green-500" />
            <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white text-sm font-semibold py-2 rounded-xl">Add Subcategory</button>
          </form>
        </Card>
      </div>
      {/* Existing categories */}
      <Card title="Existing Categories" className="mt-4">
        {groups.results.map(g => (
          <div class="mb-4">
            <p class="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{g.name}</p>
            <div class="space-y-1 pl-3">
              {cats.results.filter(c => c.group_id === g.id).map(cat => (
                <div class="flex items-center justify-between py-1 border-b border-gray-100 dark:border-gray-700">
                  <span class="text-sm">{cat.name}</span>
                  <div class="flex items-center gap-3">
                    {cat.target_budget > 0 && <span class="text-xs text-gray-400">{mga(cat.target_budget)}/mo</span>}
                    <form method="post" action={`/budget/categories/delete/${cat.id}`} onsubmit="return confirm('Delete this category?')">
                      <button type="submit" class="text-xs text-red-400 hover:text-red-600">🗑</button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Card>
    </Layout>
  )
})

budget.post('/categories/add-group', async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  if (!name) return c.redirect('/budget/categories')
  const id = generateId()
  await c.env.DB.prepare('INSERT INTO category_groups (id, name) VALUES (?, ?)').bind(id, name).run()
  return c.redirect('/budget/categories')
})

budget.post('/categories/add-category', async (c) => {
  const body = await c.req.parseBody()
  const groupId = String(body.group_id || '')
  const name = String(body.name || '').trim()
  const target = parseFloat(String(body.target_budget || '0')) || 0
  if (!name || !groupId) return c.redirect('/budget/categories')
  const id = generateId()
  await c.env.DB.prepare('INSERT INTO categories (id, group_id, name, target_budget) VALUES (?, ?, ?, ?)').bind(id, groupId, name, target).run()
  return c.redirect('/budget/categories')
})

budget.post('/categories/delete/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(c.req.param('id')).run()
  return c.redirect('/budget/categories')
})

// ─── GET /budget/accounts (manage income accounts) ─────────
budget.get('/accounts', async (c) => {
  const user = c.get('user')
  const [accounts, users] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ia.*, u.display_name FROM income_accounts ia JOIN users u ON ia.user_id = u.id ORDER BY u.username, ia.name`
    ).all<IncomeAccount & { display_name: string }>(),
    c.env.DB.prepare('SELECT * FROM users ORDER BY username').all<User>(),
  ])

  return c.html(
    <Layout title="Income Accounts" user={user} activeTab="settings">
      <h2 class="text-xl font-bold mb-5">💵 Income Accounts</h2>

      <Card title="Add Account" className="mb-5">
        <form method="post" action="/budget/accounts/add" class="space-y-3">
          <input type="text" name="name" placeholder="Account name (e.g. Freelance)" required
            class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-green-500" />
          <select name="user_id" required
            class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-green-500">
            <option value="">Assign to…</option>
            {users.results.map(u => <option value={u.id}>{u.display_name}</option>)}
          </select>
          <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white text-sm font-semibold py-2 rounded-xl">Add Account</button>
        </form>
      </Card>

      <Card title="Existing Accounts">
        <div class="space-y-2">
          {accounts.results.map(a => (
            <div class="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700 last:border-0">
              <div>
                <p class="text-sm font-medium">{a.name}</p>
                <p class="text-xs text-gray-400">{a.display_name}</p>
              </div>
              {a.is_protected
                ? <span class="text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">🔒 Service-synced</span>
                : <a href={`/budget/accounts/delete/${a.id}`} class="text-xs px-2 py-1 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 text-red-500 rounded">🗑</a>
              }
            </div>
          ))}
        </div>
      </Card>
    </Layout>
  )
})

// ─── POST /budget/accounts/add ──────────────────────────────
budget.post('/accounts/add', async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  const userId = String(body.user_id || '')
  if (!name || !userId) return c.redirect('/budget/accounts')
  const id = generateId()
  await c.env.DB.prepare('INSERT INTO income_accounts (id, user_id, name) VALUES (?, ?, ?)').bind(id, userId, name).run()
  return c.redirect('/budget/accounts')
})

// ─── GET /budget/accounts/delete/:id ────────────────────────
budget.get('/accounts/delete/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const account = await c.env.DB.prepare('SELECT * FROM income_accounts WHERE id = ?').bind(id).first<IncomeAccount>()
  if (!account || account.is_protected) return c.redirect('/budget/accounts')

  const [others, txnCount] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ia.*, u.display_name FROM income_accounts ia JOIN users u ON ia.user_id = u.id WHERE ia.id != ? ORDER BY u.username, ia.name`
    ).bind(id).all<IncomeAccount & { display_name: string }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS cnt FROM transactions WHERE income_account_id = ?').bind(id).first<{ cnt: number }>(),
  ])

  return c.html(
    <Layout title="Delete Account" user={user} activeTab="settings">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">🗑 Delete Account</h2>
        <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">
          You are about to delete <strong>{account.name}</strong>. It has <strong>{txnCount?.cnt ?? 0}</strong> income transaction(s).
        </p>
        <form method="post" action={`/budget/accounts/delete/${id}`} class="space-y-4">
          <label class="flex items-start gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-600 cursor-pointer">
            <input type="radio" name="action" value="transfer" checked class="mt-0.5 accent-green-600" />
            <div class="flex-1">
              <p class="text-sm font-semibold">Transfer to another account</p>
              <select name="transfer_to"
                class="mt-2 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-3 py-2 text-sm">
                {others.results.map(o => <option value={o.id}>{o.display_name} › {o.name}</option>)}
              </select>
            </div>
          </label>
          <label class="flex items-start gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-600 cursor-pointer">
            <input type="radio" name="action" value="drop" class="mt-0.5 accent-red-600" />
            <div>
              <p class="text-sm font-semibold">Drop transactions completely</p>
              <p class="text-xs text-gray-400">Deletes all income transactions linked to this account.</p>
            </div>
          </label>
          <button type="submit" class="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl">Delete Account</button>
          <a href="/budget/accounts" class="block text-center text-sm text-gray-500 hover:underline">Cancel</a>
        </form>
      </div>
    </Layout>
  )
})

// ─── POST /budget/accounts/delete/:id ───────────────────────
budget.post('/accounts/delete/:id', async (c) => {
  const id = c.req.param('id')
  const account = await c.env.DB.prepare('SELECT * FROM income_accounts WHERE id = ?').bind(id).first<IncomeAccount>()
  if (!account || account.is_protected) return c.redirect('/budget/accounts')

  const body = await c.req.parseBody()
  const action = String(body.action || 'transfer')

  if (action === 'transfer') {
    const transferTo = String(body.transfer_to || '')
    if (transferTo) {
      await c.env.DB.prepare('UPDATE transactions SET income_account_id = ? WHERE income_account_id = ?').bind(transferTo, id).run()
    }
  } else {
    await c.env.DB.prepare('DELETE FROM transactions WHERE income_account_id = ?').bind(id).run()
  }

  await c.env.DB.prepare('DELETE FROM income_accounts WHERE id = ?').bind(id).run()
  return c.redirect('/budget/accounts')
})

// ─── GET /budget/reports ─────────────────────────────────────
budget.get('/reports', async (c) => {
  const user = c.get('user')
  const periodKey = c.req.query('p') || 'this_week'
  const fromParam = c.req.query('from') || ''
  const toParam = c.req.query('to') || ''
  let start: string, end: string, label: string
  if (periodKey === 'custom') {
    start = fromParam
    end = toParam
    label = start && end ? `${start} → ${end}` : 'Custom Range'
  } else {
    ({ start, end, label } = reportPeriod(periodKey))
  }

  const [summary, expensesByGroup, incomeBySource, perUser, trend] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) AS income,
              COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense,
              COUNT(*) AS cnt
       FROM transactions WHERE date BETWEEN ? AND ?`
    ).bind(start, end).first<{ income: number; expense: number; cnt: number }>(),
    c.env.DB.prepare(
      `SELECT cg.name, COALESCE(SUM(t.amount),0) AS total
       FROM transactions t JOIN categories c ON t.category_id = c.id JOIN category_groups cg ON c.group_id = cg.id
       WHERE t.type='expense' AND t.date BETWEEN ? AND ? GROUP BY cg.id ORDER BY total DESC`
    ).bind(start, end).all<{ name: string; total: number }>(),
    c.env.DB.prepare(
      `SELECT ia.name, COALESCE(SUM(t.amount),0) AS total
       FROM transactions t JOIN income_accounts ia ON t.income_account_id = ia.id
       WHERE t.type='income' AND t.date BETWEEN ? AND ? GROUP BY ia.id ORDER BY total DESC`
    ).bind(start, end).all<{ name: string; total: number }>(),
    c.env.DB.prepare(
      `SELECT u.display_name,
              COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END),0) AS income,
              COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END),0) AS expense
       FROM transactions t JOIN users u ON t.added_by_user_id = u.id
       WHERE t.date BETWEEN ? AND ? GROUP BY u.id ORDER BY u.username`
    ).bind(start, end).all<{ display_name: string; income: number; expense: number }>(),
    getTrend(c.env.DB, start, end, periodKey),
  ])

  const income   = summary?.income ?? 0
  const expense  = summary?.expense ?? 0
  const net      = income - expense
  const totalExp = expensesByGroup.results.reduce((s, g) => s + g.total, 0)

  // ── Comparison (current vs previous period, per category group) ──
  const cmpMode = c.req.query('cm') === 'month' ? 'month' : 'week'
  const caParam = c.req.query('ca') || ''
  const cbParam = c.req.query('cb') || ''
  let caKey = ''
  let cbKey = ''
  let cmpA: { start: string; end: string; label: string }
  let cmpB: { start: string; end: string; label: string }
  if (cmpMode === 'month') {
    caKey = /^\d{4}-\d{2}$/.test(caParam) ? caParam : currentMonthKey()
    cbKey = /^\d{4}-\d{2}$/.test(cbParam) ? cbParam : prevMonthKey(caKey)
    cmpA = monthRange(caKey)
    cmpB = monthRange(cbKey)
  } else {
    const wa = currentWeekBounds(0)
    const wb = currentWeekBounds(-1)
    cmpA = { start: wa.start, end: wa.end, label: 'This week' }
    cmpB = { start: wb.start, end: wb.end, label: 'Last week' }
  }

  const cmpRaw = await c.env.DB.prepare(
    `SELECT cg.id, cg.name,
       COALESCE(SUM(CASE WHEN t.type='expense' AND t.date BETWEEN ? AND ? THEN t.amount ELSE 0 END),0) AS a_total,
       COALESCE(SUM(CASE WHEN t.type='expense' AND t.date BETWEEN ? AND ? THEN t.amount ELSE 0 END),0) AS b_total
     FROM category_groups cg
     LEFT JOIN categories c ON c.group_id = cg.id
     LEFT JOIN transactions t ON t.category_id = c.id
     GROUP BY cg.id ORDER BY cg.sort_order`
  ).bind(cmpA.start, cmpA.end, cmpB.start, cmpB.end).all<{ id: string; name: string; a_total: number; b_total: number }>()

  const cmpRows = cmpRaw.results.map(r => {
    const a = r.a_total
    const b = r.b_total
    let icon = '–'
    let text = ''
    let cls = 'text-gray-300 dark:text-gray-600'
    if (a === 0 && b === 0) {
      icon = '–'; text = ''
    } else if (b === 0) {
      icon = '🆕'; text = 'new'; cls = 'text-red-500'
    } else if (a === b) {
      icon = '🔄️'; text = '0%'; cls = 'text-gray-400'
    } else {
      const pct = ((a - b) / b) * 100
      const abs = Math.abs(pct)
      if (pct > 0) {
        icon = '⬆️'
        text = abs.toFixed(0) + '%'
        cls = abs > 50 ? 'text-red-500' : abs >= 30 ? 'text-yellow-500' : abs >= 10 ? 'text-orange-500' : 'text-blue-500'
      } else {
        icon = '⬇️'
        text = abs.toFixed(0) + '%'
        cls = 'text-green-600 dark:text-green-400'
      }
    }
    return { id: r.id, name: r.name, a, b, icon, text, cls }
  })

  const reportBase = 'p=' + periodKey + (periodKey === 'custom' ? '&from=' + fromParam + '&to=' + toParam : '')

  return c.html(
    <Layout title="Reports" user={user} activeTab="budget">

      {/* Sub-nav */}
      <div class="flex gap-1 mb-4 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
        <a href="/budget" class="flex-1 text-center py-2 rounded-lg text-sm font-medium text-gray-500 dark:text-gray-400">📋 Overview</a>
        <a href="/budget/reports" class="flex-1 text-center py-2 rounded-lg text-sm font-semibold bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white">📈 Reports</a>
        <a href="/budget/transactions" class="flex-1 text-center py-2 rounded-lg text-sm font-medium text-gray-500 dark:text-gray-400">📄 History</a>
      </div>

      {/* Period selector */}
      <form method="get" action="/budget/reports" class="mb-2">
        <select name="p" onchange="this.form.submit()"
          class="w-full rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-3 py-2.5 text-sm focus:outline-none focus:border-green-500">
          <option value="this_week" selected={periodKey === 'this_week'}>This Week (SAT–FRI)</option>
          <option value="last_week" selected={periodKey === 'last_week'}>Last Week (SAT–FRI)</option>
          <option value="last_7_days" selected={periodKey === 'last_7_days'}>Last 7 Days</option>
          <option value="this_month" selected={periodKey === 'this_month'}>This Month</option>
          <option value="last_month" selected={periodKey === 'last_month'}>Last Month</option>
          <option value="last_30_days" selected={periodKey === 'last_30_days'}>Last 30 Days</option>
          <option value="this_year" selected={periodKey === 'this_year'}>This Year</option>
          <option value="all" selected={periodKey === 'all'}>All Time</option>
          <option value="custom" selected={periodKey === 'custom'}>Custom Range…</option>
        </select>
        <p class="text-xs text-gray-400 mt-1">📅 {label}</p>
      </form>

      {/* Custom range + export */}
      <div class="flex gap-2 mb-4 items-center">
        <form method="get" action="/budget/reports" class="flex gap-2 flex-1 min-w-0">
          <input type="hidden" name="p" value="custom" />
          <input type="date" name="from" value={fromParam}
            class="flex-1 min-w-0 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-2 py-2 text-xs sm:text-sm" />
          <input type="date" name="to" value={toParam}
            class="flex-1 min-w-0 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-2 py-2 text-xs sm:text-sm" />
          <button type="submit" class="px-3 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-medium whitespace-nowrap">Apply</button>
        </form>
        <a href={`/budget/reports/export?p=${periodKey}${periodKey === 'custom' ? `&from=${fromParam}&to=${toParam}` : ''}`}
          class="px-3 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold whitespace-nowrap">⬇ CSV</a>
      </div>

      {/* Summary */}
      <div class="grid grid-cols-3 gap-2 mb-4">
        <div class="bg-green-50 dark:bg-green-900/20 rounded-2xl p-3 text-center border border-green-100 dark:border-green-800">
          <p class="text-[10px] text-green-700 dark:text-green-400 font-semibold uppercase">Income</p>
          <p class="text-base sm:text-xl font-bold text-green-700 dark:text-green-400 truncate">{mga(income)}</p>
        </div>
        <div class="bg-red-50 dark:bg-red-900/20 rounded-2xl p-3 text-center border border-red-100 dark:border-red-800">
          <p class="text-[10px] text-red-700 dark:text-red-400 font-semibold uppercase">Expenses</p>
          <p class="text-base sm:text-xl font-bold text-red-700 dark:text-red-400 truncate">{mga(expense)}</p>
        </div>
        {/* Teal is the app's "net" colour (the main budget summary, the dashboard's
            Net Worth). Blue here meant "net" on this one screen only — the same
            fact in two colours, which is the thing the money palette exists to
            stop. Negative keeps orange ("we owe"), as everywhere. */}
        <div class={`rounded-2xl p-3 text-center border ${net >= 0 ? 'bg-teal-50 dark:bg-teal-900/20 border-teal-100 dark:border-teal-800' : 'bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-800'}`}>
          <p class={`text-[10px] font-semibold uppercase ${net >= 0 ? 'text-teal-700 dark:text-teal-400' : 'text-orange-700 dark:text-orange-400'}`}>Net</p>
          <p class={`text-base sm:text-xl font-bold truncate ${net >= 0 ? 'text-teal-700 dark:text-teal-400' : 'text-orange-700 dark:text-orange-400'}`}>{mga(net)}</p>
        </div>
      </div>

      {/* Trend chart */}
      <Card title="Income vs Expenses" icon="trend" className="mb-4">
        <div class="w-full">
          <canvas id="trendChart"></canvas>
        </div>
        {trend.length === 0 && <p class="text-sm text-gray-400 text-center py-4">No data for this period</p>}
      </Card>

      {/* Category / source doughnuts */}
      <div class="grid md:grid-cols-2 gap-4 mb-4">
        <Card title="Expenses by Category" icon="donut">
          <div class="w-full max-w-[240px] mx-auto">
            <canvas id="expenseChart"></canvas>
          </div>
          {expensesByGroup.results.length === 0 && <p class="text-sm text-gray-400 text-center py-4">No expenses</p>}
        </Card>
        <Card title="Income by Source" icon="arrow-in">
          <div class="w-full max-w-[240px] mx-auto">
            <canvas id="incomeChart"></canvas>
          </div>
          {incomeBySource.results.length === 0 && <p class="text-sm text-gray-400 text-center py-4">No income</p>}
        </Card>
      </div>

      {/* Per user */}
      <Card title="By User" icon="people" className="mb-4">
        <div class="grid grid-cols-2 gap-2">
          {perUser.results.map(u => (
            <div class="rounded-xl border border-gray-100 dark:border-gray-700 p-3">
              <p class="text-sm font-semibold flex items-center gap-1.5 mb-2">
                <span class={`w-2 h-2 rounded-full ${userAccentColor(u.display_name)}`} />
                {u.display_name}
              </p>
              <p class="text-xs text-green-600 dark:text-green-400">+ {mga(u.income)}</p>
              <p class="text-xs text-red-500">- {mga(u.expense)}</p>
              <p class={`text-xs font-semibold mt-1 ${u.income - u.expense >= 0 ? 'text-teal-600 dark:text-teal-400' : 'text-orange-500'}`}>
                Net {mga(u.income - u.expense)}
              </p>
            </div>
          ))}
          {perUser.results.length === 0 && <p class="text-sm text-gray-400 text-center py-4 col-span-2">No data</p>}
        </div>
      </Card>

      {/* Expenses table */}
      {expensesByGroup.results.length > 0 && (
        <Card title="Expense Breakdown" icon="receipt">
          <div class="divide-y divide-gray-100 dark:divide-gray-700">
            {expensesByGroup.results.map(g => {
              const pct = totalExp > 0 ? Math.round((g.total / totalExp) * 100) : 0
              return (
                <div class="flex items-center justify-between py-2">
                  <span class="text-sm text-gray-700 dark:text-gray-300">{g.name}</span>
                  <div class="flex items-center gap-3">
                    <span class="text-xs text-gray-400">{pct}%</span>
                    <span class="text-sm font-semibold text-gray-700 dark:text-gray-300">{mga(g.total)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Comparison */}
      <Card title="Comparison" icon="swap" className="mt-4">
        {/* Mode toggle */}
        <div class="flex gap-1 mb-3 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
          <a href={`/budget/reports?${reportBase}&cm=week`}
            class={`flex-1 text-center py-1.5 rounded-lg text-xs font-semibold ${cmpMode === 'week' ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>Weekly</a>
          <a href={`/budget/reports?${reportBase}&cm=month`}
            class={`flex-1 text-center py-1.5 rounded-lg text-xs font-semibold ${cmpMode === 'month' ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>Monthly</a>
        </div>

        {cmpMode === 'month' && (
          <form method="get" action="/budget/reports" class="flex gap-2 mb-3">
            <input type="hidden" name="p" value={periodKey} />
            {periodKey === 'custom' && <input type="hidden" name="from" value={fromParam} />}
            {periodKey === 'custom' && <input type="hidden" name="to" value={toParam} />}
            <input type="hidden" name="cm" value="month" />
            <input type="month" name="ca" value={caKey}
              class="flex-1 min-w-0 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-2 py-2 text-xs sm:text-sm" />
            <input type="month" name="cb" value={cbKey}
              class="flex-1 min-w-0 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-2 py-2 text-xs sm:text-sm" />
            <button type="submit" class="px-3 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 text-sm font-medium whitespace-nowrap">Go</button>
          </form>
        )}

        {/* Header */}
        <div class="grid grid-cols-[1fr_4.75rem_4.75rem_4rem] gap-1 items-center pb-2 border-b border-gray-100 dark:border-gray-700 text-[10px] uppercase text-gray-400 font-semibold">
          <span>Category</span>
          <span class="text-right">{cmpA.label}</span>
          <span class="text-right">{cmpB.label}</span>
          <span class="text-right">Status</span>
        </div>

        {/* Rows */}
        <div class="divide-y divide-gray-100 dark:divide-gray-700">
          {cmpRows.map(r => (
            <div class="grid grid-cols-[1fr_4.75rem_4.75rem_4rem] gap-1 items-center py-2 text-xs sm:text-sm">
              <span class="truncate text-gray-700 dark:text-gray-300">{r.name}</span>
              <span class="text-right font-medium text-gray-700 dark:text-gray-300">{r.a.toLocaleString('en-US')}</span>
              <span class="text-right text-gray-400">{r.b.toLocaleString('en-US')}</span>
              <span class={`text-right font-semibold whitespace-nowrap ${r.cls}`}>{r.icon}{r.text}</span>
            </div>
          ))}
        </div>
        <p class="text-[10px] text-gray-400 mt-3 leading-relaxed">
          Amounts in MGA. ⬆️ increase — <span class="text-blue-500">blue ≤10%</span> · <span class="text-orange-500">orange 10–30%</span> · <span class="text-yellow-500">yellow 30–50%</span> · <span class="text-red-500">red &gt;50%</span>. ⬇️ decrease in <span class="text-green-600 dark:text-green-400">green</span>. 🔄️ unchanged.
        </p>
      </Card>

      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script dangerouslySetInnerHTML={{ __html: `
        function rColor() { return document.documentElement.classList.contains('dark') ? '#d1d5db' : '#374151'; }
        const palette = ['#ef4444','#f97316','#f59e0b','#84cc16','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#d946ef','#f43f5e'];
        const trend = ${JSON.stringify(trend)};
        const expData = ${JSON.stringify(expensesByGroup.results)};
        const incData = ${JSON.stringify(incomeBySource.results)};
        const common = { responsive: true, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { color: rColor(), boxWidth: 12, padding: 8 } } } };

        if (trend.length) {
          new Chart(document.getElementById('trendChart'), {
            type: 'bar',
            data: {
              labels: trend.map(t => t.bucket),
              datasets: [
                { label: 'Income', data: trend.map(t => t.income), backgroundColor: '#22c55e', borderRadius: 4 },
                { label: 'Expense', data: trend.map(t => t.expense), backgroundColor: '#ef4444', borderRadius: 4 }
              ]
            },
            options: { responsive: true, scales: { x: { ticks: { color: rColor() }, grid: { display: false } }, y: { ticks: { color: rColor() } } }, plugins: { legend: { labels: { color: rColor() } } } }
          });
        }
        if (expData.length) {
          new Chart(document.getElementById('expenseChart'), {
            type: 'doughnut',
            data: { labels: expData.map(g => g.name), datasets: [{ data: expData.map(g => g.total), backgroundColor: palette, borderWidth: 0 }] },
            options: common
          });
        }
        if (incData.length) {
          new Chart(document.getElementById('incomeChart'), {
            type: 'doughnut',
            data: { labels: incData.map(i => i.name), datasets: [{ data: incData.map(i => i.total), backgroundColor: ['#22c55e','#06b6d4','#3b82f6','#8b5cf6','#f59e0b','#f43f5e'], borderWidth: 0 }] },
            options: common
          });
        }
      `}} />
    </Layout>
  )
})

// ─── GET /budget/reports/export ──────────────────────────────
budget.get('/reports/export', async (c) => {
  const periodKey = c.req.query('p') || 'this_week'
  const fromParam = c.req.query('from') || ''
  const toParam = c.req.query('to') || ''
  let start: string, end: string
  if (periodKey === 'custom') {
    start = fromParam
    end = toParam
  } else {
    const r = reportPeriod(periodKey)
    start = r.start
    end = r.end
  }

  const txns = await c.env.DB.prepare(
    `SELECT t.date, t.type, t.amount, t.description, c.name AS category,
            cg.name AS group_name, ia.name AS income_source, u.display_name AS added_by, t.notes
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     LEFT JOIN category_groups cg ON c.group_id = cg.id
     LEFT JOIN income_accounts ia ON t.income_account_id = ia.id
     LEFT JOIN users u ON t.added_by_user_id = u.id
     WHERE t.date BETWEEN ? AND ?
     ORDER BY t.date DESC`
  ).bind(start, end).all<any>()

  const header = 'Date,Type,Amount (MGA),Description,Category,Group,Income Source,Added By,Notes'
  const csv = [header, ...txns.results.map((r: any) =>
    [r.date, r.type, r.amount, r.description || '', r.category || '', r.group_name || '', r.income_source || '', r.added_by || '', (r.notes || '').replace(/\n/g, ' ')]
      .map((v: any) => `"${String(v).replace(/"/g, '""')}"`).join(',')
  )].join('\n')

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sompitra-report-${start}-${end}.csv"`
    }
  })
})

// ─── GET /budget/transactions (all transactions, paginated) ──
// The itemised form writes notes as one "name: Ar 1,200" line per item, so the
// History detail view can render them as a list. Returns null for free-form
// notes, and the caller falls back to plain text with line breaks kept.
function parseItemLines(notes: string | null): { name: string; amount: string }[] | null {
  const lines = (notes || '').split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return null
  const items: { name: string; amount: string }[] = []
  for (const line of lines) {
    const m = line.match(/^(.*?):\s*Ar\s*([\d,]+)$/)
    if (!m) return null
    items.push({ name: m[1].trim(), amount: m[2] })
  }
  return items
}

budget.get('/transactions', async (c) => {
  const user = c.get('user')
  const periodKey = c.req.query('p') || 'all'
  const fromParam = c.req.query('from') || ''
  const toParam = c.req.query('to') || ''
  const page = Math.max(1, parseInt(c.req.query('page') || '1') || 1)
  const perPage = 30

  let start: string, end: string, label: string
  if (periodKey === 'custom') {
    start = fromParam; end = toParam; label = start && end ? `${start} → ${end}` : 'Custom Range'
  } else {
    ({ start, end, label } = reportPeriod(periodKey))
  }

  const [txns, countRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.*, c.name AS category_name, cg.name AS group_name, ia.name AS income_account_name, u.display_name AS added_by_display_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN category_groups cg ON c.group_id = cg.id
       LEFT JOIN income_accounts ia ON t.income_account_id = ia.id
       LEFT JOIN users u ON t.added_by_user_id = u.id
       WHERE t.date BETWEEN ? AND ?
       ORDER BY t.date DESC, t.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(start, end, perPage, (page - 1) * perPage).all<Transaction>(),
    c.env.DB.prepare('SELECT COUNT(*) AS cnt FROM transactions WHERE date BETWEEN ? AND ?').bind(start, end).first<{ cnt: number }>(),
  ])

  const total = countRow?.cnt ?? 0
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  const baseQuery = 'p=' + periodKey + (periodKey === 'custom' ? '&from=' + fromParam + '&to=' + toParam : '')

  return c.html(
    <Layout title="Transaction History" user={user} activeTab="budget">

      {/* Sub-nav */}
      <div class="flex gap-1 mb-4 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
        <a href="/budget" class="flex-1 text-center py-2 rounded-lg text-sm font-medium text-gray-500 dark:text-gray-400">📋 Overview</a>
        <a href="/budget/reports" class="flex-1 text-center py-2 rounded-lg text-sm font-medium text-gray-500 dark:text-gray-400">📈 Reports</a>
        <a href="/budget/transactions" class="flex-1 text-center py-2 rounded-lg text-sm font-semibold bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white">📄 History</a>
      </div>

      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold">📄 Transaction History</h2>
      </div>

      {/* Filter */}
      <form method="get" action="/budget/transactions" class="mb-2">
        <select name="p" onchange="this.form.submit()"
          class="w-full rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-3 py-2.5 text-sm focus:outline-none focus:border-green-500">
          <option value="this_week" selected={periodKey === 'this_week'}>This Week (SAT–FRI)</option>
          <option value="last_week" selected={periodKey === 'last_week'}>Last Week (SAT–FRI)</option>
          <option value="last_7_days" selected={periodKey === 'last_7_days'}>Last 7 Days</option>
          <option value="this_month" selected={periodKey === 'this_month'}>This Month</option>
          <option value="last_month" selected={periodKey === 'last_month'}>Last Month</option>
          <option value="last_30_days" selected={periodKey === 'last_30_days'}>Last 30 Days</option>
          <option value="this_year" selected={periodKey === 'this_year'}>This Year</option>
          <option value="all" selected={periodKey === 'all'}>All Time</option>
          <option value="custom" selected={periodKey === 'custom'}>Custom Range…</option>
        </select>
        <p class="text-xs text-gray-400 mt-1">📅 {label} · {total} transaction(s)</p>
      </form>

      {/* Custom range */}
      <form method="get" action="/budget/transactions" class="flex gap-2 mb-4">
        <input type="hidden" name="p" value="custom" />
        <input type="date" name="from" value={fromParam}
          class="flex-1 min-w-0 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-2 py-2 text-xs sm:text-sm" />
        <input type="date" name="to" value={toParam}
          class="flex-1 min-w-0 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 px-2 py-2 text-xs sm:text-sm" />
        <button type="submit" class="px-3 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 text-sm font-medium whitespace-nowrap">Apply</button>
      </form>

      {/* List */}
      {txns.results.length === 0
        ? <p class="text-sm text-gray-400 text-center py-8">No transactions found.</p>
        : (
          <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700">
            {txns.results.map(t => {
              const items = parseItemLines(t.notes)
              return (
                <div>
                  <div class="flex items-start justify-between gap-2 py-3 px-4">
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class={`w-1 h-4 shrink-0 rounded-full ${userAccentColor(t.added_by_display_name)}`} />
                        <p class="text-sm font-semibold truncate">{t.description || t.category_name || t.income_account_name || '—'}</p>
                      </div>
                      <p class="text-xs text-gray-400 mt-0.5">
                        {t.group_name ? `${t.group_name} › ${t.category_name}` : (t.income_account_name || '')}
                        {' · '}{t.added_by_display_name} · {t.date}
                      </p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <span class={`text-sm font-bold ${t.type === 'income' ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                        {t.type === 'income' ? '+' : '-'}{mga(t.amount)}
                      </span>
                      {/* 👁️ details — at most one row stays expanded (see the script below) */}
                      <button type="button" data-tx-toggle={t.id} aria-expanded="false" title="Show details"
                        class="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600">👁️</button>
                      <a href={`/budget/edit/${t.id}`} class="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600">✏️</a>
                      <form method="post" action={`/budget/delete/${t.id}`} style="display:inline" onsubmit="return confirm('Delete this transaction?')">
                        <button type="submit" class="text-xs px-2 py-1 bg-red-50 dark:bg-red-900/20 text-red-500 rounded hover:bg-red-100">🗑</button>
                      </form>
                    </div>
                  </div>

                  {/* Details panel — hidden until 👁️ is pressed */}
                  <div data-tx-details={t.id} class="hidden px-4 pb-3">
                    {items && (
                      <div class="rounded-xl bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700 p-3">
                        <p class="text-[10px] font-semibold text-gray-400 mb-2">{items.length} item{items.length === 1 ? '' : 's'}</p>
                        <div class="space-y-1">
                          {items.map(it => (
                            <div class="flex items-baseline justify-between gap-3 text-xs">
                              <span class="text-gray-600 dark:text-gray-300 truncate">{it.name}</span>
                              <span class="text-gray-500 dark:text-gray-400 whitespace-nowrap">Ar {it.amount}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {!items && t.notes && (
                      <div class="rounded-xl bg-gray-50 dark:bg-gray-900/40 border border-gray-100 dark:border-gray-700 p-3">
                        <p class="text-[10px] font-semibold text-gray-400 mb-1">Notes</p>
                        <p class="text-xs text-gray-600 dark:text-gray-300 whitespace-pre-line">{t.notes}</p>
                      </div>
                    )}
                    <div class="mt-2 text-[11px] text-gray-400 space-y-0.5">
                      <p>
                        {t.type === 'income' ? 'Income' : 'Expense'}
                        {t.is_recurring === 1 ? ' · 🔄 Recurring' : ''}
                        {t.group_name ? ` · ${t.group_name} › ${t.category_name}` : ''}
                        {!t.group_name && t.income_account_name ? ` · ${t.income_account_name}` : ''}
                      </p>
                      <p>
                        Added by {t.added_by_display_name} · logged {String(t.created_at || '').slice(0, 10)}
                        {String(t.created_at || '').length > 10 ? ` at ${String(t.created_at).slice(11, 16)}` : ''}
                      </p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      }

      {/* 👁️ Row details — at most ONE row is expanded at a time, so opening a
          row retracts whichever was open before. The icon flips to 🙈 while a
          row is open, and aria-expanded carries the state for screen readers. */}
      <script dangerouslySetInnerHTML={{ __html: `
        (function () {
          function reset(panel, btn) {
            panel.classList.add('hidden');
            btn.textContent = '👁️';
            btn.setAttribute('aria-expanded', 'false');
            btn.setAttribute('title', 'Show details');
          }
          document.addEventListener('click', function (ev) {
            var btn = ev.target && ev.target.closest ? ev.target.closest('[data-tx-toggle]') : null;
            if (!btn) return;

            var id = btn.getAttribute('data-tx-toggle');
            var target = null;
            var panels = document.querySelectorAll('[data-tx-details]');
            var btns = document.querySelectorAll('[data-tx-toggle]');
            for (var i = 0; i < panels.length; i++) {
              if (panels[i].getAttribute('data-tx-details') === id && panels[i].classList.contains('hidden')) {
                target = panels[i];
              }
            }
            // Retract everything first: this is what keeps exactly one open.
            for (var j = 0; j < panels.length; j++) {
              var b = btns[j];
              if (b) reset(panels[j], b);
            }
            if (!target) return;   // the pressed row was already open -> just closed

            target.classList.remove('hidden');
            btn.textContent = '🙈';
            btn.setAttribute('aria-expanded', 'true');
            btn.setAttribute('title', 'Hide details');
          });
        })();
      `}} />

      {/* Pagination */}
      {totalPages > 1 && (
        <div class="flex items-center justify-between mt-4">
          <a href={page > 1 ? `/budget/transactions?${baseQuery}&page=${page - 1}` : '#'}
            class={`px-3 py-1.5 rounded-lg text-sm font-medium ${page > 1 ? 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700' : 'opacity-40 pointer-events-none bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700'}`}>◀ Prev</a>
          <span class="text-sm text-gray-500">Page {page} of {totalPages}</span>
          <a href={page < totalPages ? `/budget/transactions?${baseQuery}&page=${page + 1}` : '#'}
            class={`px-3 py-1.5 rounded-lg text-sm font-medium ${page < totalPages ? 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700' : 'opacity-40 pointer-events-none bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700'}`}>Next ▶</a>
        </div>
      )}
    </Layout>
  )
})

export default budget




