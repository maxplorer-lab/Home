/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { Layout, Card } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import { mga, generateId } from '../lib/utils'
import { notifyTransaction } from '../lib/notify'
import type { Env, User, InventoryItem, SaleRecord } from '../db/schema'

const sales = new Hono<{ Bindings: Env; Variables: { user: User } }>()
sales.use('*', requireAuth)

// ─── GET /sales ───────────────────────────────────────────────
sales.get('/', async (c) => {
  const user = c.get('user')

  const [items, recentSales] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM inventory_items ORDER BY name').all<InventoryItem>(),
    c.env.DB.prepare(
      `SELECT sr.*, ii.name AS item_name FROM sales_records sr
       JOIN inventory_items ii ON sr.item_id = ii.id
       ORDER BY sr.sale_date DESC, sr.created_at DESC LIMIT 20`
    ).all<SaleRecord & { item_name: string }>(),
  ])

  const totalRevenue = recentSales.results.reduce((s, r) => s + r.total_sale, 0)
  const totalCost    = recentSales.results.reduce((s, r) => s + r.total_cost, 0)
  const totalProfit  = totalRevenue - totalCost

  return c.html(
    <Layout title="Sales & Stock" user={user} activeTab="sales">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xl font-bold">🛒 Sales & Stock</h2>
        <div class="flex gap-2">
          <a href="/sales/items/new" class="px-3 py-1.5 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 text-sm font-semibold">+ Item</a>
          <a href="/sales/record/new" class="px-4 py-1.5 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-semibold">+ Sale</a>
        </div>
      </div>

      {/* Stats */}
      <div class="grid grid-cols-3 gap-3 mb-5">
        <div class="bg-green-50 dark:bg-green-900/20 rounded-2xl p-4 border border-green-100 dark:border-green-800 text-center">
          <p class="text-xs text-green-700 dark:text-green-400 font-semibold uppercase">Revenue</p>
          <p class="text-lg font-bold text-green-700 dark:text-green-400">{mga(totalRevenue)}</p>
        </div>
        <div class="bg-red-50 dark:bg-red-900/20 rounded-2xl p-4 border border-red-100 dark:border-red-800 text-center">
          <p class="text-xs text-red-700 dark:text-red-400 font-semibold uppercase">Cost</p>
          <p class="text-lg font-bold text-red-700 dark:text-red-400">{mga(totalCost)}</p>
        </div>
        <div class={`rounded-2xl p-4 border text-center ${totalProfit >= 0 ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-100 dark:border-blue-800' : 'bg-orange-50 dark:bg-orange-900/20 border-orange-100 dark:border-orange-800'}`}>
          <p class={`text-xs font-semibold uppercase ${totalProfit >= 0 ? 'text-blue-700 dark:text-blue-400' : 'text-orange-700 dark:text-orange-400'}`}>Profit</p>
          <p class={`text-lg font-bold ${totalProfit >= 0 ? 'text-blue-700 dark:text-blue-400' : 'text-orange-700 dark:text-orange-400'}`}>{mga(totalProfit)}</p>
        </div>
      </div>

      <div class="grid md:grid-cols-2 gap-4">
        {/* Inventory */}
        <Card title="📦 Inventory">
          {items.results.length === 0
            ? <p class="text-sm text-gray-400 text-center py-4">No items yet</p>
            : (
              <div class="divide-y divide-gray-100 dark:divide-gray-700">
                {items.results.map(item => (
                  <div class="py-2.5 flex items-center justify-between gap-2">
                    <div>
                      <p class="text-sm font-semibold">{item.name}</p>
                      <p class="text-xs text-gray-400">Cost: {mga(item.cost_price)}</p>
                    </div>
                    <div class="flex items-center gap-2">
                      <span class={`text-sm font-bold ${item.stock_qty < 3 ? 'text-red-500' : 'text-gray-700 dark:text-gray-300'}`}>
                        {item.stock_qty} units
                      </span>
                      <a href={`/sales/items/${item.id}/delete`} class="text-xs px-2 py-1 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 text-red-500 rounded" title="Delete item">🗑</a>
                    </div>
                  </div>
                ))}
              </div>
            )
          }
        </Card>

        {/* Recent Sales */}
        <Card title="🧾 Recent Sales">
          {recentSales.results.length === 0
            ? <p class="text-sm text-gray-400 text-center py-4">No sales yet</p>
            : (
              <div class="divide-y divide-gray-100 dark:divide-gray-700">
                {recentSales.results.map(s => (
                  <div class="py-2.5 flex items-center justify-between gap-2">
                    <div>
                      <p class="text-sm font-semibold">{s.item_name}</p>
                      <p class="text-xs text-gray-400">{s.qty} × {s.sale_date}
                        {!s.synced_income_txn_id && <span class="text-orange-400"> · Not synced</span>}
                        {s.synced_income_txn_id && <span class="text-green-500"> · ✓ Synced</span>}
                      </p>
                      {s.notes && <p class="text-xs text-gray-400">{s.notes}</p>}
                    </div>
                    <div class="text-right">
                      <p class="text-sm font-bold text-green-600 dark:text-green-400">{mga(s.total_sale)}</p>
                      <div class="flex items-center justify-end gap-1">
                        {!s.synced_income_txn_id && (
                          <form method="post" action={`/sales/record/${s.id}/sync`}>
                            <button type="submit" class="text-xs text-orange-500 hover:underline">Sync</button>
                          </form>
                        )}
                        <a href={`/sales/record/${s.id}/delete`} class="text-xs text-red-400 hover:text-red-600" title="Delete sale">🗑</a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          }
        </Card>
      </div>
    </Layout>
  )
})

// ─── GET /sales/items/new ─────────────────────────────────────
sales.get('/items/new', async (c) => {
  const user = c.get('user')
  return c.html(
    <Layout title="Add Item" user={user} activeTab="sales">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">📦 Add Inventory Item</h2>
        <form method="post" action="/sales/items/new" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Item Name *</label>
            <input type="text" name="name" required placeholder="e.g. Widget A"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cost Price (MGA) *</label>
            <input type="number" name="cost_price" min="0" step="1" required placeholder="e.g. 5000"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
            <p class="text-xs text-gray-400 mt-1">Purchase/restock cost. The selling price is set per sale.</p>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Initial Stock Qty</label>
            <input type="number" name="stock_qty" min="0" step="1" value="0"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
            <textarea name="notes" rows={2}
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500 resize-none" />
          </div>
          <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl">Add Item</button>
        </form>
      </div>
    </Layout>
  )
})

sales.post('/items/new', async (c) => {
  const body = await c.req.parseBody()
  const name = String(body.name).trim()
  const cost = parseFloat(String(body.cost_price || '0'))
  const qty  = parseInt(String(body.stock_qty || '0'))
  const notes = String(body.notes || '').trim() || null
  if (!name) return c.redirect('/sales/items/new')
  const id = generateId()
  await c.env.DB.prepare('INSERT INTO inventory_items (id, name, cost_price, sale_price, stock_qty, notes) VALUES (?, ?, ?, 0, ?, ?)').bind(id, name, cost, qty, notes).run()
  return c.redirect('/sales')
})

// ─── GET /sales/record/new ────────────────────────────────────
sales.get('/record/new', async (c) => {
  const user = c.get('user')
  const items = await c.env.DB.prepare('SELECT * FROM inventory_items ORDER BY name').all<InventoryItem>()

  return c.html(
    <Layout title="Record Sale" user={user} activeTab="sales">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">🧾 Record Sale</h2>
        <form method="post" action="/sales/record/new" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Item *</label>
            <select name="item_id" required id="item-select"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500">
              <option value="">Select item…</option>
              {items.results.map(i => (
                <option value={i.id} data-cost={i.cost_price} data-stock={i.stock_qty}>
                  {i.name} (stock: {i.stock_qty})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Quantity *</label>
            <input type="number" name="qty" id="qty-input" min="1" step="1" value="1" required
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500"
              oninput="calcSale()" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Sale Price per Unit (MGA) *</label>
            <input type="number" name="unit_price" id="unit-price" min="0" step="1" required placeholder="e.g. 5800"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500"
              oninput="calcSale()" />
            <p class="text-xs text-gray-400 mt-1">Actual selling price for this sale only.</p>
          </div>
          <div class="bg-gray-50 dark:bg-gray-700 rounded-xl p-4 text-sm space-y-1">
            <div class="flex justify-between"><span class="text-gray-500">Total Revenue</span><span id="total-sale" class="font-bold text-green-600">—</span></div>
            <div class="flex justify-between"><span class="text-gray-500">Total Cost</span><span id="total-cost" class="text-red-500">—</span></div>
          </div>
          <input type="hidden" name="total_sale" id="total-sale-input" />
          <input type="hidden" name="total_cost" id="total-cost-input" />
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Date</label>
            <input type="date" name="date" value={new Date().toISOString().slice(0, 10)}
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes (optional)</label>
            <input type="text" name="notes"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
          </div>
          <label class="flex items-start gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-600 cursor-pointer">
            <input type="checkbox" name="sync_to_budget" value="1" class="mt-0.5 w-4 h-4 accent-green-600" />
            <div>
              <p class="text-sm font-semibold">Sync to Budget</p>
              <p class="text-xs text-gray-400">Manually creates income (sale) + expense (cost) transactions in budget</p>
            </div>
          </label>
          <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl">Record Sale</button>
        </form>
      </div>
      <script dangerouslySetInnerHTML={{ __html: `
        function calcSale() {
          const sel = document.getElementById('item-select');
          const opt = sel.options[sel.selectedIndex];
          const qty = parseInt(document.getElementById('qty-input').value) || 0;
          const cost = parseFloat(opt.dataset.cost || 0);
          const unit = parseFloat(document.getElementById('unit-price').value) || 0;
          const totalSale = qty * unit;
          const totalCost = qty * cost;
          document.getElementById('total-sale').textContent = 'Ar ' + totalSale.toLocaleString();
          document.getElementById('total-cost').textContent = 'Ar ' + totalCost.toLocaleString();
          document.getElementById('total-sale-input').value = totalSale;
          document.getElementById('total-cost-input').value = totalCost;
        }
        document.getElementById('item-select').addEventListener('change', calcSale);
        document.getElementById('unit-price').addEventListener('input', calcSale);
      `}} />
    </Layout>
  )
})

sales.post('/record/new', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const itemId    = String(body.item_id)
  const qty       = parseInt(String(body.qty || '1'))
  const totalSale = parseFloat(String(body.total_sale || '0'))
  const totalCost = parseFloat(String(body.total_cost || '0'))
  const date      = String(body.date)
  const notes     = String(body.notes || '').trim() || null
  const sync      = body.sync_to_budget === '1'

  const item = await c.env.DB.prepare('SELECT * FROM inventory_items WHERE id=?').bind(itemId).first<InventoryItem>()
  if (!item) return c.redirect('/sales')

  let incomeId: string | null = null
  let expenseId: string | null = null

  if (sync) {
    incomeId = generateId()
    expenseId = generateId()
    await c.env.DB.prepare(
      `INSERT INTO transactions (id, date, amount, type, description, added_by_user_id) VALUES (?, ?, ?, 'income', ?, ?)`
    ).bind(incomeId, date, totalSale, `Sales – ${item.name} ×${qty}`, user.id).run()
    await c.env.DB.prepare(
      `INSERT INTO transactions (id, date, amount, type, description, added_by_user_id) VALUES (?, ?, ?, 'expense', ?, ?)`
    ).bind(expenseId, date, totalCost, `Stock Cost – ${item.name} ×${qty}`, user.id).run()
    await notifyTransaction(c.env, incomeId)
    await notifyTransaction(c.env, expenseId)
  }

  const saleId = generateId()
  await c.env.DB.prepare(
    `INSERT INTO sales_records (id, item_id, qty, total_sale, total_cost, sale_date, synced_income_txn_id, synced_expense_txn_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(saleId, itemId, qty, totalSale, totalCost, date, incomeId, expenseId, notes).run()

  // Deduct stock
  await c.env.DB.prepare('UPDATE inventory_items SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?').bind(qty, itemId).run()

  return c.redirect('/sales')
})

// ─── POST /sales/record/:id/sync ─────────────────────────────
sales.post('/record/:id/sync', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const record = await c.env.DB.prepare(
    `SELECT sr.*, ii.name AS item_name FROM sales_records sr JOIN inventory_items ii ON sr.item_id=ii.id WHERE sr.id=?`
  ).bind(id).first<SaleRecord & { item_name: string }>()
  if (!record) return c.redirect('/sales')

  const incomeId  = generateId()
  const expenseId = generateId()
  await c.env.DB.prepare(
    `INSERT INTO transactions (id, date, amount, type, description, added_by_user_id) VALUES (?, ?, ?, 'income', ?, ?)`
  ).bind(incomeId, record.sale_date, record.total_sale, `Sales – ${record.item_name} ×${record.qty}`, user.id).run()
  await c.env.DB.prepare(
    `INSERT INTO transactions (id, date, amount, type, description, added_by_user_id) VALUES (?, ?, ?, 'expense', ?, ?)`
  ).bind(expenseId, record.sale_date, record.total_cost, `Stock Cost – ${record.item_name} ×${record.qty}`, user.id).run()

  await c.env.DB.prepare(
    'UPDATE sales_records SET synced_income_txn_id=?, synced_expense_txn_id=? WHERE id=?'
  ).bind(incomeId, expenseId, id).run()

  await notifyTransaction(c.env, incomeId)
  await notifyTransaction(c.env, expenseId)
  return c.redirect('/sales')
})

// ─── GET /sales/record/:id/delete ────────────────────────────
sales.get('/record/:id/delete', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const record = await c.env.DB.prepare(
    `SELECT sr.*, ii.name AS item_name FROM sales_records sr JOIN inventory_items ii ON sr.item_id = ii.id WHERE sr.id = ?`
  ).bind(id).first<SaleRecord & { item_name: string }>()
  if (!record) return c.redirect('/sales')

  const linked = (record.synced_income_txn_id ? 1 : 0) + (record.synced_expense_txn_id ? 1 : 0)
  const unit = record.qty > 0 ? record.total_sale / record.qty : 0

  return c.html(
    <Layout title="Delete Sale" user={user} activeTab="sales">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">🗑 Delete Sale</h2>
        <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">
          You are about to delete a sale of <strong>{record.item_name}</strong> ({record.qty} × {mga(unit)} = {mga(record.total_sale)}). Stock will be restored.
        </p>
        <form method="post" action={`/sales/record/${id}/delete`} class="space-y-4">
          <label class="flex items-start gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-600 cursor-pointer">
            <input type="checkbox" name="delete_transactions" value="1" checked class="mt-0.5 w-4 h-4 accent-red-600" />
            <div>
              <p class="text-sm font-semibold">Also delete linked budget transactions</p>
              <p class="text-xs text-gray-400">Removes {linked} income/expense transaction(s) synced from this sale.</p>
            </div>
          </label>
          <button type="submit" class="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl">Delete Sale</button>
          <a href="/sales" class="block text-center text-sm text-gray-500 hover:underline">Cancel</a>
        </form>
      </div>
    </Layout>
  )
})

// ─── POST /sales/record/:id/delete ───────────────────────────
sales.post('/record/:id/delete', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.parseBody()
  const deleteTxns = body.delete_transactions === '1'

  const record = await c.env.DB.prepare('SELECT * FROM sales_records WHERE id = ?').bind(id).first<SaleRecord>()
  if (!record) return c.redirect('/sales')

  if (deleteTxns) {
    if (record.synced_income_txn_id) await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(record.synced_income_txn_id).run()
    if (record.synced_expense_txn_id) await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(record.synced_expense_txn_id).run()
  }

  // Restore stock
  await c.env.DB.prepare('UPDATE inventory_items SET stock_qty = stock_qty + ? WHERE id = ?').bind(record.qty, record.item_id).run()

  await c.env.DB.prepare('DELETE FROM sales_records WHERE id = ?').bind(id).run()
  return c.redirect('/sales')
})

// ─── GET /sales/items/:id/delete ─────────────────────────────
sales.get('/items/:id/delete', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const item = await c.env.DB.prepare('SELECT * FROM inventory_items WHERE id = ?').bind(id).first<InventoryItem>()
  if (!item) return c.redirect('/sales')

  const linked = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN synced_income_txn_id IS NOT NULL THEN 1 ELSE 0 END),0) +
            COALESCE(SUM(CASE WHEN synced_expense_txn_id IS NOT NULL THEN 1 ELSE 0 END),0) AS cnt
     FROM sales_records WHERE item_id = ?`
  ).bind(id).first<{ cnt: number }>()

  return c.html(
    <Layout title="Delete Item" user={user} activeTab="sales">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">🗑 Delete Item</h2>
        <p class="text-sm text-gray-600 dark:text-gray-300 mb-4">
          You are about to delete <strong>{item.name}</strong> and all of its sales history.
        </p>
        <form method="post" action={`/sales/items/${id}/delete`} class="space-y-4">
          <label class="flex items-start gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-600 cursor-pointer">
            <input type="checkbox" name="delete_transactions" value="1" checked class="mt-0.5 w-4 h-4 accent-red-600" />
            <div>
              <p class="text-sm font-semibold">Also delete linked budget transactions</p>
              <p class="text-xs text-gray-400">Removes {linked?.cnt ?? 0} income/expense transaction(s) synced from this item's sales.</p>
            </div>
          </label>
          <button type="submit" class="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl">Delete Item</button>
          <a href="/sales" class="block text-center text-sm text-gray-500 hover:underline">Cancel</a>
        </form>
      </div>
    </Layout>
  )
})

// ─── POST /sales/items/:id/delete ────────────────────────────
sales.post('/items/:id/delete', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.parseBody()
  const deleteTxns = body.delete_transactions === '1'

  if (deleteTxns) {
    const recs = await c.env.DB.prepare(
      'SELECT synced_income_txn_id, synced_expense_txn_id FROM sales_records WHERE item_id = ?'
    ).bind(id).all<{ synced_income_txn_id: string | null; synced_expense_txn_id: string | null }>()
    for (const r of recs.results) {
      if (r.synced_income_txn_id) await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(r.synced_income_txn_id).run()
      if (r.synced_expense_txn_id) await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(r.synced_expense_txn_id).run()
    }
  }

  // Delete item (sales_records cascade via FK)
  await c.env.DB.prepare('DELETE FROM inventory_items WHERE id = ?').bind(id).run()
  return c.redirect('/sales')
})

export default sales

