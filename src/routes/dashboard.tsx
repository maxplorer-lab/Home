/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { Layout, Card, KineClientStats, TintStat } from '../views/layout'
// The module colours come from the SAME table the tab bar renders, so the
// doorways below can never drift from the tabs they open.
import { HOME_TABS, Icon } from '../views/app-chrome'
import { requireAuth } from '../lib/middleware'
import { mga, currentWeekBounds, currentMonthBounds, formatDate, userAccentColor, currentGradedTone } from '../lib/utils'
import { classifyTransaction } from '../lib/notify'
// The pantry's OWN queries. Home shows a summary of the shelves, and it has to
// be the same arithmetic the Pantry screen draws from -- see `pantrySummary`.
import { pantrySummary } from '../laoka/data/queries.js'
import type { Env, User, Transaction, DebtCreditAccount } from '../db/schema'

const dashboard = new Hono<{ Bindings: Env; Variables: { user: User } }>()
dashboard.use('*', requireAuth)

dashboard.get('/', async (c) => {
  const user = c.get('user')
  // Home is STATIC: current calendar month for money flow, current SAT–FRI week for Kiné.
  const month = currentMonthBounds()
  const week = currentWeekBounds(0)

  // ── Aggregate queries ──────────────────────────────────────
  const [incomeRow, expenseRow, allIncomeRow, allExpenseRow, debtRow, creditRow, recentTxns, debts, kineClients, kineWeekDelivered, kineWeekPaid, todayTxns] = await Promise.all([
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='income' AND date BETWEEN ? AND ?`).bind(month.start, month.end).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='expense' AND date BETWEEN ? AND ?`).bind(month.start, month.end).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='income'`).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='expense'`).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(current_balance),0) AS total FROM debt_credit_accounts WHERE type='debt' AND current_balance > 0`).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(current_balance),0) AS total FROM debt_credit_accounts WHERE type='credit' AND current_balance > 0`).first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT t.*, c.name AS category_name, cg.name AS group_name, ia.name AS income_account_name, u.display_name AS added_by_display_name
       FROM transactions t LEFT JOIN categories c ON t.category_id = c.id LEFT JOIN category_groups cg ON c.group_id = cg.id
       LEFT JOIN income_accounts ia ON t.income_account_id = ia.id LEFT JOIN users u ON t.added_by_user_id = u.id
       ORDER BY t.date DESC, t.created_at DESC LIMIT 5`
    ).all<Transaction>(),
    c.env.DB.prepare(`SELECT * FROM debt_credit_accounts WHERE current_balance > 0 ORDER BY created_at DESC LIMIT 3`).all<DebtCreditAccount>(),
    c.env.DB.prepare(
      `SELECT
         cu.id          AS customer_id,
         cu.name        AS customer_name,
         cu.default_rate AS default_rate,
         sc.session_rate AS session_rate,
         COALESCE((SELECT COUNT(*) FROM attendance_ticks at WHERE at.contract_id = sc.id AND at.is_delivered = 1), 0) AS delivered,
         COALESCE((SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.contract_id = sc.id), 0) AS paid
       FROM customers cu
       JOIN service_contracts sc ON sc.customer_id = cu.id AND sc.status = 'active'
       ORDER BY cu.created_at DESC`
    ).all<{ customer_id: string; customer_name: string; default_rate: number; session_rate: number | null; delivered: number; paid: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM attendance_ticks WHERE is_delivered = 1 AND tick_date BETWEEN ? AND ?`).bind(week.start, week.end).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM client_payments WHERE payment_date BETWEEN ? AND ?`).bind(week.start, week.end).first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT t.*, c.name AS category_name, cg.name AS group_name, ia.name AS income_account_name, u.display_name AS added_by_display_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN category_groups cg ON c.group_id = cg.id
       LEFT JOIN income_accounts ia ON t.income_account_id = ia.id
       LEFT JOIN users u ON t.added_by_user_id = u.id
       WHERE date(t.created_at) = date('now')
       ORDER BY t.created_at DESC
       LIMIT 8`
    ).all<Transaction>()
  ])

  const totalIncome   = incomeRow?.total  ?? 0     // this month
  const totalExpenses = expenseRow?.total ?? 0     // this month
  const allIncome     = allIncomeRow?.total  ?? 0
  const allExpense    = allExpenseRow?.total ?? 0
  const currentCash   = allIncome - allExpense     // Current = cash in hand (all-time)
  const totalDebt     = debtRow?.total    ?? 0
  const totalCredit   = creditRow?.total  ?? 0

  const dueRow = await c.env.DB.prepare(`
    SELECT COALESCE(SUM((
      SELECT COUNT(*) FROM attendance_ticks at WHERE at.contract_id = sc.id AND at.is_delivered = 1
    ) * sc.session_rate - COALESCE((
      SELECT SUM(cp.amount) FROM client_payments cp WHERE cp.contract_id = sc.id
    ),0)), 0) AS due FROM service_contracts sc WHERE sc.status = 'active'
  `).first<{ due: number }>()
  // Uncollected Dues = money owed TO us: unpaid Kiné sessions + outstanding credits (money lent out)
  const kineDues = dueRow?.due ?? 0
  const uncollectedDues = kineDues + totalCredit
  const netWorth = currentCash + uncollectedDues - totalDebt

  const sankeyIncomes = await c.env.DB.prepare(
    `SELECT ia.name, u.display_name, COALESCE(SUM(t.amount),0) AS total
     FROM transactions t JOIN income_accounts ia ON t.income_account_id = ia.id JOIN users u ON ia.user_id = u.id
     WHERE t.type='income' AND t.date BETWEEN ? AND ? GROUP BY ia.id`
  ).bind(month.start, month.end).all<{ name: string; display_name: string; total: number }>()

  const sankeyExpenses = await c.env.DB.prepare(
    `SELECT cg.name AS group_name, COALESCE(SUM(t.amount),0) AS total
     FROM transactions t JOIN categories c ON t.category_id = c.id JOIN category_groups cg ON c.group_id = cg.id
     WHERE t.type='expense' AND t.date BETWEEN ? AND ? GROUP BY cg.id`
  ).bind(month.start, month.end).all<{ group_name: string; total: number }>()

  const weekLabel = `${formatDate(week.start)} – ${formatDate(week.end)}`

  // ── Today's activity (derived, state-free: vanishes each day) ──
  // Same classifier that drives the ntfy push, so wording never diverges.
  const notifs = todayTxns.results.map(classifyTransaction)

  const accents: Record<string, { border: string; text: string }> = {
    orange: { border: 'border-orange-500', text: 'text-orange-500' },
    blue:   { border: 'border-blue-500',   text: 'text-blue-500' },
    red:    { border: 'border-red-500',    text: 'text-red-500' },
    green:  { border: 'border-green-500',  text: 'text-green-600 dark:text-green-400' },
  }

  // The three modules that are not a money section, each wearing its own tab
  // colour. Hard-coding hues here is what made this card the odd one out: Chat
  // was sky blue on the dashboard and violet in the tab bar two centimetres
  // below it, and WAY was indigo in one place and sky in the other. Reading
  // HOME_TABS means the doorway and the tab are literally the same value.
  const doorways = (['way', 'laoka', 'chat'] as const).map(key => {
    const tab = HOME_TABS.find(t => t.tab === key)!
    return {
      href: tab.href,
      color: tab.color,
      label: tab.label,
      // Each tab carries an image mark OR an inline glyph, never both.
      img: 'img' in tab ? tab.img : undefined,
      svg: 'svg' in tab ? tab.svg : undefined,
      blurb: key === 'way' ? 'the family map' : key === 'laoka' ? 'meals for the week' : 'the family room',
    }
  })

  // ── The pantry, for the card at the foot of this page ──
  // It lives in Laoka's own database, and its queries ask for `env.DB` (the
  // binding name Laoka uses) while knowing nothing about which worker calls
  // them — so they are handed a DB-scoped env rather than the whole one.
  // A Laoka binding that is missing or unreadable must not take Home down with
  // it: the card says it cannot read the shelves instead of showing zeros, which
  // would claim an empty pantry.
  let pantry: { items: number; categories: number; toBuy: number } | null = null
  try {
    pantry = await pantrySummary({ DB: c.env.LAOKA_DB })
  } catch {
    pantry = null
  }
  // Laoka's own colour, from the same table the tab bar renders. Read with a
  // fallback rather than asserted: the card is decoration, and a tab table that
  // ever loses its Laoka entry must not 500 the page the household lands on.
  const laokaTab = HOME_TABS.find(t => t.tab === 'laoka')
  const laokaColor = laokaTab ? laokaTab.color : '#ea580c'
  const laokaInk = laokaTab ? laokaTab.ink : '#c2410c'

  return c.html(
    <Layout title="Dashboard" user={user} activeTab="dashboard">
      {/* The rest of the super app — one tap each, same shell, same session.
          WAY and Laoka open as tabs of this app (chromeless embeds); Chat is
          the family room (WAY's own chat engine). */}
      <Card title="Around the house" icon="house" className="mb-4">
        <div class="grid grid-cols-3 gap-2">
          {doorways.map(item => (
            <a
              href={item.href}
              style={{
                '--tab': item.color,
                // A whisper of the module's own colour as the card's surface:
                // 8% fill / 20% edge. Derived from the tab colour rather than
                // hand-picked pastels, so the three cards read as one family
                // with the tab bar instead of three different apps.
                backgroundColor: item.color + '14',
                borderColor: item.color + '33',
              }}
              class="tab-tint flex flex-col sm:flex-row items-center sm:items-center gap-1.5 sm:gap-2.5 rounded-2xl px-2 py-2.5 sm:px-3 sm:py-3 border transition-transform active:scale-95"
            >
              {item.img
                ? <img src={item.img} alt="" class="w-7 h-7 sm:w-8 sm:h-8 rounded-lg shrink-0" />
                : <span class="shrink-0"><Icon name={item.svg ?? ''} className="w-7 h-7 sm:w-8 sm:h-8" /></span>}
              <span class="min-w-0 text-center sm:text-left">
                <span class="block text-[13px] sm:text-sm font-bold">{item.label}</span>
                <span class="block text-[10px] text-gray-400 truncate">{item.blurb}</span>
              </span>
            </a>
          ))}
        </div>
      </Card>

      {/* Static period header — Home has no prev/next (that lives under Budget) */}
      <div class="flex items-center justify-center gap-1.5 mb-4 text-gray-500 dark:text-gray-400">
        <Icon name="calendar" className="w-[15px] h-[15px]" />
        <span class="text-sm font-semibold text-gray-600 dark:text-gray-300">{month.label}</span>
      </div>

      <div class="grid grid-cols-2 gap-2 mb-4 sm:grid-cols-3">
        <TintStat label="Current" value={mga(currentCash)} tone={currentGradedTone(currentCash)} sub="cash on hand" />
        <TintStat label="Expenses" value={mga(totalExpenses)} tone="bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-100 dark:border-red-800" sub="this month" />
        {/* Income is GREEN here, not blue: the transaction rows below print an
            income as +green and the Budget page's Add Income button is green,
            so a blue Income tile was the same fact in two colours on one screen.
            The palette now means something: green = money in, red = money out,
            amber = cash on hand, purple = owed to us, orange = we owe, teal =
            net (Sompitra's own colour). */}
        <TintStat label="Income" value={mga(totalIncome)} tone="bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-100 dark:border-green-800" sub="this month" />
        <TintStat label="Uncollected Dues" value={mga(uncollectedDues)} tone="bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400 border-purple-100 dark:border-purple-800" sub="Kiné + credits" />
        <TintStat label="Dues" value={mga(totalDebt)} tone="bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 border-orange-100 dark:border-orange-800" />
        <TintStat label="Net Worth" value={mga(netWorth)} tone={netWorth >= 0 ? 'bg-teal-50 dark:bg-teal-900/20 text-teal-700 dark:text-teal-400 border-teal-100 dark:border-teal-800' : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-100 dark:border-red-800'} sub="cash + owed − dues" />
      </div>

      {notifs.length > 0 && (
        <Card title="Today's Activity" icon="bell" noUppercase className="mb-4">
          <div class="space-y-1">
            {notifs.map(n => (
              <a href={n.href} class={`block py-2 px-2.5 rounded-lg border-l-2 ${accents[n.accent].border} hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors`}>
                <p class={`text-xs font-bold ${accents[n.accent].text}`}>{n.line1}</p>
                {n.line2 && <p class="text-[10px] text-gray-400 mt-0.5">{n.line2}</p>}
              </a>
            ))}
          </div>
        </Card>
      )}

      <Card title="Kiné Summary" icon="pulse" className="mb-4">
        {/* Weekly totals (current SAT–FRI week) */}
        <p class="flex items-center gap-1 text-[10px] text-gray-400 mb-2">
          <Icon name="calendar" className="w-[13px] h-[13px]" />{weekLabel}
        </p>
        <div class="grid grid-cols-2 gap-2 mb-4">
          <div class="rounded-xl bg-blue-50 dark:bg-blue-900/20 p-3 text-center">
            <p class="text-[10px] font-semibold uppercase text-blue-600 dark:text-blue-400">Sessions This Week</p>
            <p class="text-xl font-bold text-blue-600 dark:text-blue-400">{kineWeekDelivered?.total || 0}</p>
          </div>
          <div class="rounded-xl bg-orange-50 dark:bg-orange-900/20 p-3 text-center">
            <p class="text-[10px] font-semibold uppercase text-orange-600 dark:text-orange-400">Paid This Week</p>
            <p class="text-xl font-bold text-orange-600 dark:text-orange-400">{mga(kineWeekPaid?.total || 0)}</p>
          </div>
        </div>

        {/* Per-client active summary */}
        {kineClients.results.length === 0
          ? <p class="text-sm text-gray-400 text-center py-2">No active clients yet</p>
          : (
            <div class="space-y-4">
              {kineClients.results.map(client => {
                const delivered = client.delivered ?? 0
                const paid      = client.paid ?? 0
                const rate      = client.session_rate ?? client.default_rate ?? 0
                return (
                  <div>
                    <p class="text-sm font-semibold mb-1.5">{client.customer_name}</p>
                    <KineClientStats delivered={delivered} paid={paid} rate={rate} />
                  </div>
                )
              })}
            </div>
          )
        }
        <p class="text-[10px] text-gray-400 mt-3 text-center">🟢 balanced · 🟡 prepaid (we owe sessions) · 🔴 owes sessions</p>
      </Card>

      <Card title="Cash Flow" icon="trend" className="mb-4">
        <div id="sankey-container" style="height:240px" class="w-full">
          <canvas id="sankeyCanvas" class="w-full h-full" />
        </div>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            const incomes  = ${JSON.stringify(sankeyIncomes.results)};
            const expenses = ${JSON.stringify(sankeyExpenses.results)};
            const totalIn  = ${totalIncome};
            const totalExp = ${totalExpenses};
            const net = totalIn - totalExp;
            const canvas = document.getElementById('sankeyCanvas');
            const container = document.getElementById('sankey-container');
            const dpr = window.devicePixelRatio || 1;

            // Subtle color-wheel shades: fixed hue, small lightness steps.
            function greenShades(count) {
              const out = [];
              for (let i = 0; i < count; i++) out.push('hsl(155, 55%, ' + (26 + i * 3) + '%)');
              return out;
            }
            function orangeShades(count) {
              const out = [];
              for (let i = 0; i < count; i++) out.push('hsl(22, 70%, ' + (38 + i * 3) + '%)');
              return out;
            }

            // Current balance grading (matches the Current card)
            function currentFill(v) {
              if (v < 0) return '#ef4444';
              if (v < 200000) return '#eab308';
              if (v < 500000) return '#3b82f6';
              return '#16a34a';
            }

            function resize() {
              canvas.width  = container.clientWidth  * dpr;
              canvas.height = container.clientHeight * dpr;
              canvas.style.width  = container.clientWidth  + 'px';
              canvas.style.height = container.clientHeight + 'px';
              drawSankey();
            }

            function layoutColumn(nodes, pad, gap, H) {
              const avail = H - pad * 2;
              const gapsTotal = Math.max(0, nodes.length - 1) * gap;
              const heightsTotal = Math.max(0, avail - gapsTotal);
              const n = nodes.length;
              const total = nodes.reduce(function(s, node) { return s + node.value; }, 0);
              const maxH = heightsTotal * 0.4;

              let heights = nodes.map(function(node) {
                return total > 0 ? (node.value / total) * heightsTotal : (heightsTotal / Math.max(1, n));
              });

              // Cap any branch at 40% and redistribute the remainder among the rest.
              for (let iter = 0; iter < 12; iter++) {
                const cappedIdx = [];
                const uncappedIdx = [];
                heights.forEach(function(h, i) {
                  if (h >= maxH - 0.5) cappedIdx.push(i); else uncappedIdx.push(i);
                });
                if (cappedIdx.length === 0) break;
                if (uncappedIdx.length === 0) {
                  heights = nodes.map(function() { return heightsTotal / Math.max(1, n); });
                  break;
                }
                const cappedSum = cappedIdx.reduce(function(s, i) { return s + maxH; }, 0);
                const remaining = Math.max(0, heightsTotal - cappedSum);
                const uncappedValue = uncappedIdx.reduce(function(s, i) { return s + nodes[i].value; }, 0);
                if (uncappedValue <= 0) break;
                const next = heights.slice();
                cappedIdx.forEach(function(i) { next[i] = maxH; });
                uncappedIdx.forEach(function(i) { next[i] = (nodes[i].value / uncappedValue) * remaining; });
                const anyOver = uncappedIdx.some(function(i) { return next[i] >= maxH - 0.5; });
                heights = next;
                if (!anyOver) break;
              }

              let y = pad;
              return nodes.map(function(node, i) {
                const item = { label: node.label, value: node.value, color: node.color, y: y, h: heights[i] };
                y += heights[i] + gap;
                return item;
              });
            }

            function drawSankey() {
              const W = canvas.width, H = canvas.height;
              const ctx = canvas.getContext('2d');
              ctx.clearRect(0, 0, W, H);
              const pad = 8 * dpr, nodeW = 96 * dpr, gap = 6 * dpr;

              const greens  = greenShades(incomes.length > 0 ? incomes.length : 1);
              const oranges = orangeShades(expenses.length > 0 ? expenses.length : 1);

              const incomeNodes = incomes.length > 0
                ? incomes.map(function(i, idx) { return { label: i.name, value: i.total, color: greens[idx] }; })
                : [{ label: 'No income', value: 0, color: '#6b7280' }];

              const expNodes = expenses.map(function(e, idx) { return { label: e.group_name, value: e.total, color: oranges[idx] }; });

              const left  = layoutColumn(incomeNodes, pad, gap, H);
              const right = layoutColumn(expNodes, pad, gap, H);

              const centerH = Math.min(80 * dpr, H - pad * 2);
              const centerX = W / 2 - nodeW / 2;
              const centerY = H / 2 - centerH / 2;

              function drawNode(x, y, w, h, label, color) {
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.roundRect(x, y, w, h, 6 * dpr);
                ctx.fill();
                if (h >= 14 * dpr) {
                  ctx.fillStyle = '#fff';
                  ctx.font = 'bold ' + (9 * dpr) + 'px sans-serif';
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'middle';
                  const text = label.length > 16 ? label.slice(0, 15) + '…' : label;
                  ctx.fillText(text, x + w / 2, y + h / 2);
                }
              }

              function drawFlow(x1, y1, x2, y2, color, h) {
                ctx.globalAlpha = 0.55;
                ctx.strokeStyle = color;
                ctx.lineWidth = Math.max(2 * dpr, Math.min(h * 0.4, 16 * dpr));
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
                ctx.stroke();
                ctx.globalAlpha = 1;
              }

              left.forEach(function(n) {
                drawNode(pad, n.y, nodeW, n.h, n.label, n.color);
                drawFlow(pad + nodeW, n.y + n.h / 2, centerX, centerY + centerH / 2, n.color, n.h);
              });

              // Center pool — solid colour graded by the Current balance
              ctx.fillStyle = currentFill(net);
              ctx.beginPath();
              ctx.roundRect(centerX, centerY, nodeW, centerH, 8 * dpr);
              ctx.fill();
              ctx.fillStyle = '#fff';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.font = 'bold ' + (10 * dpr) + 'px sans-serif';
              ctx.fillText('Current', centerX + nodeW / 2, centerY + centerH / 2 - 9 * dpr);
              ctx.font = 'bold ' + (9 * dpr) + 'px sans-serif';
              ctx.fillText('Ar ' + net.toLocaleString('en-US'), centerX + nodeW / 2, centerY + centerH / 2 + 9 * dpr);

              right.forEach(function(n) {
                drawNode(W - pad - nodeW, n.y, nodeW, n.h, n.label, n.color);
                drawFlow(centerX + nodeW, centerY + centerH / 2, W - pad - nodeW, n.y + n.h / 2, n.color, n.h);
              });
            }

            window.addEventListener('resize', resize);
            resize();
          })();
        `}} />
      </Card>

      {/* `min-w-0` on both cards, and it is load-bearing: these are grid items,
          and a grid item's automatic minimum size is its MIN-CONTENT width. A
          transaction description is rendered with `truncate`, which means
          `white-space: nowrap` — so one long description (a Laoka import reads
          "Laoka shopping 2026-09-12 – 2026-09-18") makes its min-content ~415px
          and the whole PAGE gains a horizontal scrollbar on a 422px phone,
          even though the row above it already had min-w-0. The floor has to be
          removed on the item that IS the grid item, not only inside it. */}
      <div class="grid md:grid-cols-2 gap-4">
        <Card title="Recent Transactions" icon="list" className="min-w-0">
          {recentTxns.results.length === 0 ? <p class="text-sm text-gray-400 text-center py-4">No transactions yet</p> : (
            <div class="space-y-3">
              {recentTxns.results.map(t => (
                <div class="flex items-start justify-between gap-2 pb-2 border-b border-gray-100 dark:border-gray-700 last:border-0 last:pb-0">
                  <div class="min-w-0 flex gap-2">
                    <span class={`mt-1 w-1 h-4 shrink-0 rounded-full ${userAccentColor(t.added_by_display_name)}`} />
                    <div class="min-w-0">
                      <p class="text-sm font-medium truncate">{t.description || t.category_name || t.income_account_name || '—'}</p>
                      <p class="text-[11px] text-gray-400">{t.group_name ? `${t.group_name} · ` : ''}{t.added_by_display_name}</p>
                    </div>
                  </div>
                  <div class="text-right">
                    <span class={`block text-sm font-bold whitespace-nowrap ${t.type === 'income' ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                      {t.type === 'income' ? '+' : '-'}{mga(t.amount)}
                    </span>
                    <a href={`/budget/edit/${t.id}`} class="text-[11px] text-blue-500 hover:underline">Edit</a>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div class="mt-4 flex gap-2">
            <a href="/budget/add-expense" class="flex-1 text-center text-sm py-2 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 font-medium">+ Expense</a>
            <a href="/budget/add-income" class="flex-1 text-center text-sm py-2 rounded-xl bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/40 font-medium">+ Income</a>
          </div>
        </Card>

        <Card title="Debts & Credits" icon="swap" className="min-w-0">
          {debts.results.length === 0 ? <p class="text-sm text-gray-400 text-center py-4">No open debts</p> : (
            <div class="space-y-3">
              {debts.results.map(d => (
                <div class="flex items-center justify-between gap-2 pb-2 border-b border-gray-100 dark:border-gray-700 last:border-0 last:pb-0">
                  <div>
                    <p class="text-sm font-medium">{d.person_name}</p>
                    {/* Orange = we owe, purple = owed to us — the same pair the
                        Debts page and the Uncollected Dues tile use. */}
                    <span class={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${d.type === 'debt' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'}`}>
                      {d.type === 'debt' ? 'We owe' : 'They owe us'}
                    </span>
                  </div>
                  {/* The amount used to be orange whatever the direction, so a
                      credit we are owed printed in the "we owe" colour. */}
                  <span class={`text-sm font-bold ${d.type === 'debt' ? 'text-orange-600 dark:text-orange-400' : 'text-purple-600 dark:text-purple-400'}`}>{mga(d.current_balance)}</span>
                </div>
              ))}
            </div>
          )}
          <div class="mt-4">
            <a href="/debts" class="block text-center text-sm py-2 rounded-xl bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 font-medium">View All →</a>
          </div>
        </Card>
      </div>

      {/* The pantry in one line, and one tap away. It answers "is anything
          needed?" without opening Laoka, and every number comes from the Pantry
          screen's OWN queries (`pantrySummary` → `getPantryTree` +
          `listPantryToBuy`), so a summary cannot disagree with the list it
          summarises. The link carries the tab, so it lands ON the pantry. */}
      <Card title="Pantry" icon="bowl" className="mt-4">
        <a href="/laoka/?tab=pantry" class="flex items-center gap-2 -mb-0.5 active:scale-[0.99] transition-transform">
          <span class="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
            {pantry ? (
              <>
                <span class="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                  {pantry.items} {pantry.items === 1 ? 'item' : 'items'}
                </span>
                <span class="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                  {pantry.categories} {pantry.categories === 1 ? 'category' : 'categories'}
                </span>
                {pantry.toBuy > 0 ? (
                  // Orange is Laoka's own colour, so "to buy" reads as the same
                  // fact the Pantry tab highlights.
                  <span
                    class="text-[11px] px-2 py-0.5 rounded-full font-bold"
                    style={{ backgroundColor: `${laokaColor}1f`, color: laokaInk }}
                  >
                    {pantry.toBuy} to buy
                  </span>
                ) : (
                  <span class="text-[11px] px-2 py-0.5 rounded-full bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400">
                    nothing to buy
                  </span>
                )}
              </>
            ) : (
              <span class="text-[11px] text-gray-400">the shelves could not be read just now</span>
            )}
          </span>
          <Icon name="chev-right" className="w-4 h-4 text-gray-300 shrink-0" />
        </a>
      </Card>
    </Layout>
  )
})

export default dashboard