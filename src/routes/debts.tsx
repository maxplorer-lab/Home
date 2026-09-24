/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { Layout, Card } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import { mga, generateId } from '../lib/utils'
import { notifyTransaction } from '../lib/notify'
import type { Env, User, DebtCreditAccount, IncomeAccount } from '../db/schema'

const debts = new Hono<{ Bindings: Env; Variables: { user: User } }>()
debts.use('*', requireAuth)

type DebtRow = DebtCreditAccount & { income_account_name?: string; category_name?: string }

// ─── GET /debts ───────────────────────────────────────────────
debts.get('/', async (c) => {
  const user = c.get('user')

  const [openDebts, openCredits, closedAll] = await Promise.all([
    c.env.DB.prepare(
      `SELECT dca.*, ia.name AS income_account_name, c.name AS category_name
       FROM debt_credit_accounts dca
       LEFT JOIN income_accounts ia ON dca.income_account_id = ia.id
       LEFT JOIN categories c ON dca.category_id = c.id
       WHERE dca.type='debt' AND dca.current_balance > 0 ORDER BY dca.created_at DESC`
    ).all<DebtRow>(),
    c.env.DB.prepare(
      `SELECT dca.*, ia.name AS income_account_name, c.name AS category_name
       FROM debt_credit_accounts dca
       LEFT JOIN income_accounts ia ON dca.income_account_id = ia.id
       LEFT JOIN categories c ON dca.category_id = c.id
       WHERE dca.type='credit' AND dca.current_balance > 0 ORDER BY dca.created_at DESC`
    ).all<DebtRow>(),
    c.env.DB.prepare(
      `SELECT * FROM debt_credit_accounts WHERE current_balance <= 0 ORDER BY created_at DESC LIMIT 10`
    ).all<DebtCreditAccount>(),
  ])

  const totalDebt   = openDebts.results.reduce((s, d) => s + d.current_balance, 0)
  const totalCredit = openCredits.results.reduce((s, d) => s + d.current_balance, 0)

  return c.html(
    <Layout title="Debts & Credits" user={user} activeTab="debts">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-xl font-bold">🤝 Debts & Credits</h2>
        <a href="/debts/new" class="px-4 py-2 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-semibold">+ New Entry</a>
      </div>

      {/* Summary */}
      <div class="grid grid-cols-2 gap-3 mb-5">
        <div class="bg-orange-50 dark:bg-orange-900/20 rounded-2xl p-4 border border-orange-100 dark:border-orange-800">
          <p class="text-[12px] text-orange-700 dark:text-orange-400 font-semibold">We Owe (Debt)</p>
          <p class="text-2xl font-bold text-orange-700 dark:text-orange-400">{mga(totalDebt)}</p>
          <p class="text-xs text-orange-600 dark:text-orange-500">{openDebts.results.length} open</p>
        </div>
        {/* Purple IS "owed to us" everywhere else in the app (the dashboard's
            Uncollected Dues tile), so credit wears it here too. It was blue,
            which made the same money a different colour on this page. */}
        <div class="bg-purple-50 dark:bg-purple-900/20 rounded-2xl p-4 border border-purple-100 dark:border-purple-800">
          <p class="text-[12px] text-purple-700 dark:text-purple-400 font-semibold">Owed to Us (Credit)</p>
          <p class="text-2xl font-bold text-purple-700 dark:text-purple-400">{mga(totalCredit)}</p>
          <p class="text-xs text-purple-600 dark:text-purple-500">{openCredits.results.length} open</p>
        </div>
      </div>

      {/* Open Debts */}
      {openDebts.results.length > 0 && (
        <Card title="🔴 We Owe (Debts)" className="mb-4">
          <div class="divide-y divide-gray-100 dark:divide-gray-700">
            {openDebts.results.map(d => {
              const pct = Math.round(((d.initial_amount - d.current_balance) / d.initial_amount) * 100)
              return (
                <div class="py-3">
                  <div class="flex items-start justify-between mb-2">
                    <div>
                      <p class="font-semibold">{d.person_name}</p>
                      <p class="text-xs text-gray-400">Borrowed {mga(d.initial_amount)} · remaining {mga(d.current_balance)}</p>
                      <p class="text-xs text-gray-400">
                        {d.income_account_name ? `Borrowed → ${d.income_account_name}` : 'Not synced to budget'} · Repayments → Liability
                      </p>
                      {d.notes && <p class="text-xs text-gray-400 mt-0.5">{d.notes}</p>}
                    </div>
                    <p class="text-base font-bold text-orange-600">{mga(d.current_balance)}</p>
                  </div>
                  <div class="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-2">
                    <div class="h-full bg-orange-400 rounded-full" style={`width:${pct}%`} />
                  </div>
                  <p class="text-xs text-gray-400 mb-2">{pct}% repaid</p>
                  <div class="flex items-center gap-2">
                    <a href={`/debts/${d.id}/pay`}
                      class="text-xs px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white rounded-lg font-semibold">
                      Log Repayment
                    </a>
                    <a href={`/debts/${d.id}/delete`} class="text-xs px-2 py-1.5 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 text-red-500 rounded-lg" title="Delete debt">🗑</a>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Open Credits */}
      {openCredits.results.length > 0 && (
        <Card title="🔵 Owed to Us (Credits)" className="mb-4">
          <div class="divide-y divide-gray-100 dark:divide-gray-700">
            {openCredits.results.map(d => {
              const pct = Math.round(((d.initial_amount - d.current_balance) / d.initial_amount) * 100)
              return (
                <div class="py-3">
                  <div class="flex items-start justify-between mb-2">
                    <div>
                      <p class="font-semibold">{d.person_name}</p>
                      <p class="text-xs text-gray-400">Lent {mga(d.initial_amount)} · remaining {mga(d.current_balance)}</p>
                      <p class="text-xs text-gray-400">Lent → Liability · Collections → Liability</p>
                      {d.notes && <p class="text-xs text-gray-400 mt-0.5">{d.notes}</p>}
                    </div>
                    <p class="text-base font-bold text-purple-600 dark:text-purple-400">{mga(d.current_balance)}</p>
                  </div>
                  <div class="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-2">
                    <div class="h-full bg-purple-400 rounded-full" style={`width:${pct}%`} />
                  </div>
                  <p class="text-xs text-gray-400 mb-2">{pct}% collected</p>
                  <div class="flex items-center gap-2">
                    <a href={`/debts/${d.id}/collect`}
                      class="text-xs px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold">
                      Log Collection
                    </a>
                    <a href={`/debts/${d.id}/delete`} class="text-xs px-2 py-1.5 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 text-red-500 rounded-lg" title="Delete credit">🗑</a>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Settled */}
      {closedAll.results.length > 0 && (
        <Card title="✅ Settled (recent 10)">
          <div class="space-y-1">
            {closedAll.results.map(d => (
              <div class="flex items-center justify-between py-1.5 text-sm text-gray-400">
                <span>{d.person_name} <span class="text-xs">({d.type})</span></span>
                <div class="flex items-center gap-2">
                  <span class="text-green-600 dark:text-green-400 text-xs">✓ Settled</span>
                  <a href={`/debts/${d.id}/delete`} class="text-xs text-red-400 hover:text-red-600" title="Delete">🗑</a>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </Layout>
  )
})

// ─── GET /debts/new ───────────────────────────────────────────
debts.get('/new', async (c) => {
  const user = c.get('user')

  return c.html(
    <Layout title="New Debt/Credit" user={user} activeTab="debts">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">🤝 New Debt / Credit</h2>
        <form method="post" action="/debts/new" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Person Name *</label>
            <input type="text" name="person_name" required placeholder="e.g. David"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Type *</label>
            <div class="grid grid-cols-2 gap-3">
              <label class="cursor-pointer">
                <input type="radio" name="type" value="debt" required class="sr-only peer" />
                <div class="peer-checked:border-orange-500 peer-checked:bg-orange-50 dark:peer-checked:bg-orange-900/20 border-2 border-gray-200 dark:border-gray-600 rounded-xl p-4 text-center transition-all">
                  <div class="text-2xl mb-1">💸</div>
                  <p class="text-sm font-semibold">Debt</p>
                  <p class="text-xs text-gray-400">We borrowed money</p>
                </div>
              </label>
              <label class="cursor-pointer">
                <input type="radio" name="type" value="credit" class="sr-only peer" />
                <div class="peer-checked:border-purple-500 peer-checked:bg-purple-50 dark:peer-checked:bg-purple-900/20 border-2 border-gray-200 dark:border-gray-600 rounded-xl p-4 text-center transition-all">
                  <div class="text-2xl mb-1">🤲</div>
                  <p class="text-sm font-semibold">Credit</p>
                  <p class="text-xs text-gray-400">We lent money</p>
                </div>
              </label>
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (MGA) *</label>
            <input type="number" name="amount" min="1" step="1" required placeholder="100000"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
            <input type="date" name="date" value={new Date().toISOString().slice(0, 10)}
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>

          <p class="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
            💡 Debt money is automatically recorded as income under the <strong>Debt</strong> account.
            Repayments & collections are automatically tracked under the <strong>Liability</strong> category.
          </p>

          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
            <textarea name="notes" rows={2} placeholder="Reason, agreement details…"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500 resize-none" />
          </div>
          <button type="submit"
            class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl">
            Save
          </button>
        </form>
      </div>
    </Layout>
  )
})

// ─── POST /debts/new ──────────────────────────────────────────
debts.post('/new', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const personName = String(body.person_name || '').trim()
  const type       = String(body.type) as 'debt' | 'credit'
  const amount     = parseFloat(String(body.amount || '0'))
  const date       = String(body.date)
  const notes      = String(body.notes || '').trim() || null

  if (!personName || !amount) return c.redirect('/debts/new')

  // Debt income auto-goes to the neutral "Debt" account.
  let debtAccountId: string | null = null
  if (type === 'debt') {
    const acct = await c.env.DB.prepare(
      "SELECT id FROM income_accounts WHERE name = 'Debt' AND is_protected = 1 LIMIT 1"
    ).first<{ id: string }>()
    debtAccountId = acct?.id || null
  }

  // Initial budget transaction (capture its id to link to the debt/credit)
  let initialTxnId: string | null = null
  if (type === 'debt' && debtAccountId) {
    initialTxnId = generateId()
    await c.env.DB.prepare(
      `INSERT INTO transactions (id, date, amount, type, income_account_id, description, notes, added_by_user_id)
       VALUES (?, ?, ?, 'income', ?, ?, ?, ?)`
    ).bind(initialTxnId, date, amount, debtAccountId, `${personName} - Debt Borrowed`, notes, user.id).run()
  } else if (type === 'credit') {
    initialTxnId = generateId()
    await c.env.DB.prepare(
      `INSERT INTO transactions (id, date, amount, type, category_id, description, notes, added_by_user_id)
       VALUES (?, ?, ?, 'expense', ?, ?, ?, ?)`
    ).bind(initialTxnId, date, amount, 'cat_liability', `${personName} - Debt Lent`, notes, user.id).run()
  }

  const id = generateId()
  await c.env.DB.prepare(
    `INSERT INTO debt_credit_accounts (id, person_name, type, initial_amount, current_balance, notes, income_account_id, synced_transaction_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, personName, type, amount, amount, notes, debtAccountId, initialTxnId).run()

  await notifyTransaction(c.env, initialTxnId)
  return c.redirect('/debts')
})

// ─── GET /debts/:id/pay ───────────────────────────────────────
debts.get('/:id/pay', async (c) => {
  const user = c.get('user')
  const debt = await c.env.DB.prepare('SELECT * FROM debt_credit_accounts WHERE id = ?').bind(c.req.param('id')).first<DebtCreditAccount>()
  if (!debt) return c.redirect('/debts')
  return debtPayForm(c, user, debt, 'pay')
})

// ─── GET /debts/:id/collect ───────────────────────────────────
debts.get('/:id/collect', async (c) => {
  const user = c.get('user')
  const debt = await c.env.DB.prepare('SELECT * FROM debt_credit_accounts WHERE id = ?').bind(c.req.param('id')).first<DebtCreditAccount>()
  if (!debt) return c.redirect('/debts')
  return debtPayForm(c, user, debt, 'collect')
})

async function debtPayForm(c: Context<{ Bindings: Env; Variables: { user: User } }>, user: User, account: DebtCreditAccount, mode: 'pay' | 'collect') {
  const isPay = mode === 'pay'
  const linkHint = isPay
    ? 'Will be logged as an expense under "Liability"'
    : 'Will be logged as income under "Liability"'

  return c.html(
    <Layout title={isPay ? 'Log Repayment' : 'Log Collection'} user={user} activeTab="debts">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-1">{isPay ? '💸 Repayment' : '💰 Collection'}</h2>
        <p class="text-sm text-gray-500 mb-1">
          {isPay ? 'Paying back to' : 'Collecting from'} <strong>{account.person_name}</strong> · Balance: <strong>{mga(account.current_balance)}</strong>
        </p>
        <p class="text-xs text-gray-400 mb-5">{linkHint}</p>
        <form method="post" action={`/debts/${account.id}/${isPay ? 'pay' : 'collect'}`} class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (MGA)</label>
            <input type="number" name="amount" min="1" step="1" value={Math.round(account.current_balance)} required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
            <input type="date" name="date" value={new Date().toISOString().slice(0, 10)} required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
            <input type="text" name="notes"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <button type="submit"
            class={`w-full text-white font-semibold py-3 rounded-xl ${isPay ? 'bg-orange-600 hover:bg-orange-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
            Save {isPay ? 'Repayment' : 'Collection'}
          </button>
        </form>
      </div>
    </Layout>
  )
}

// ─── POST /debts/:id/pay ──────────────────────────────────────
debts.post('/:id/pay', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const amount = parseFloat(String(body.amount || '0'))
  const date   = String(body.date)
  const notes  = String(body.notes || '').trim() || null
  const acctId = c.req.param('id')

  const account = await c.env.DB.prepare('SELECT * FROM debt_credit_accounts WHERE id=?').bind(acctId).first<DebtCreditAccount>()
  if (!account) return c.redirect('/debts')

  // Expense transaction (repayment) — auto-assigned to Liability
  const syncedTxnId = generateId()
  await c.env.DB.prepare(
    `INSERT INTO transactions (id, date, amount, type, category_id, description, notes, added_by_user_id)
     VALUES (?, ?, ?, 'expense', ?, ?, ?, ?)`
  ).bind(syncedTxnId, date, amount, 'cat_liability', `${account.person_name} - Debt Repayment`, notes, user.id).run()

  const payId = generateId()
  await c.env.DB.prepare(
    `INSERT INTO debt_credit_payments (id, account_id, amount, payment_date, synced_transaction_id, notes) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(payId, acctId, amount, date, syncedTxnId, notes).run()

  const newBalance = Math.max(0, account.current_balance - amount)
  await c.env.DB.prepare(
    'UPDATE debt_credit_accounts SET current_balance = ? WHERE id = ?'
  ).bind(newBalance, acctId).run()

  await notifyTransaction(c.env, syncedTxnId)
  return c.redirect('/debts')
})

// ─── POST /debts/:id/collect ──────────────────────────────────
debts.post('/:id/collect', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const amount = parseFloat(String(body.amount || '0'))
  const date   = String(body.date)
  const notes  = String(body.notes || '').trim() || null
  const acctId = c.req.param('id')

  const account = await c.env.DB.prepare('SELECT * FROM debt_credit_accounts WHERE id=?').bind(acctId).first<DebtCreditAccount>()
  if (!account) return c.redirect('/debts')

  // Income transaction (collection) — auto-assigned to Liability
  const syncedTxnId = generateId()
  await c.env.DB.prepare(
    `INSERT INTO transactions (id, date, amount, type, category_id, description, notes, added_by_user_id)
     VALUES (?, ?, ?, 'income', ?, ?, ?, ?)`
  ).bind(syncedTxnId, date, amount, 'cat_liability', `${account.person_name} - Debt Collection`, notes, user.id).run()

  const payId = generateId()
  await c.env.DB.prepare(
    `INSERT INTO debt_credit_payments (id, account_id, amount, payment_date, synced_transaction_id, notes) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(payId, acctId, amount, date, syncedTxnId, notes).run()

  const newBalance = Math.max(0, account.current_balance - amount)
  await c.env.DB.prepare(
    'UPDATE debt_credit_accounts SET current_balance = ? WHERE id = ?'
  ).bind(newBalance, acctId).run()

  await notifyTransaction(c.env, syncedTxnId)
  return c.redirect('/debts')
})

// ─── GET /debts/:id/delete ──────────────────────────────────
debts.get('/:id/delete', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const account = await c.env.DB.prepare('SELECT * FROM debt_credit_accounts WHERE id = ?').bind(id).first<DebtCreditAccount>()
  if (!account) return c.redirect('/debts')

  const linked = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM debt_credit_payments WHERE account_id = ? AND synced_transaction_id IS NOT NULL`
  ).bind(id).first<{ cnt: number }>()
  const totalLinked = (account.synced_transaction_id ? 1 : 0) + (linked?.cnt ?? 0)

  return c.html(
    <Layout title="Delete Debt/Credit" user={user} activeTab="debts">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">🗑 Delete {account.type === 'debt' ? 'Debt' : 'Credit'}</h2>
        <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">
          You are about to delete the {account.type === 'debt' ? 'debt' : 'credit'} with
          <strong> {account.person_name}</strong> ({mga(account.current_balance)} remaining).
          This will also delete all linked budget transactions ({totalLinked}).
        </p>
        <form method="post" action={`/debts/${id}/delete`} class="space-y-4">
          <button type="submit" class="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl">Delete</button>
          <a href="/debts" class="block text-center text-sm text-gray-500 hover:underline">Cancel</a>
        </form>
      </div>
    </Layout>
  )
})

// ─── POST /debts/:id/delete ─────────────────────────────────
debts.post('/:id/delete', async (c) => {
  const id = c.req.param('id')
  const account = await c.env.DB.prepare('SELECT * FROM debt_credit_accounts WHERE id = ?').bind(id).first<DebtCreditAccount>()
  if (!account) return c.redirect('/debts')

  // Collect every transaction linked to this debt/credit
  const txns: string[] = []
  if (account.synced_transaction_id) txns.push(account.synced_transaction_id)
  const payments = await c.env.DB.prepare(
    'SELECT synced_transaction_id FROM debt_credit_payments WHERE account_id = ? AND synced_transaction_id IS NOT NULL'
  ).bind(id).all<{ synced_transaction_id: string }>()
  for (const p of payments.results) txns.push(p.synced_transaction_id)

  // Delete linked transactions
  for (const t of txns) {
    await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(t).run()
  }

  // Delete the account (payments cascade via FK)
  await c.env.DB.prepare('DELETE FROM debt_credit_accounts WHERE id = ?').bind(id).run()

  return c.redirect('/debts')
})

export default debts
