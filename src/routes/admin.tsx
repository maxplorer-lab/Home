/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { Layout, Card } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import {
  listHomeUsers, createHomeUser, setHomePassword,
  ensureModuleAccountsWithPassword, getHomeUserFromCookie,
} from '../identity'
import type { Env, User } from '../db/schema'
import type { HomeUser } from '../identity'
import { readDiag } from '../lib/diagnostics'

const admin = new Hono<{ Bindings: Env; Variables: { user: User } }>()
admin.use('*', requireAuth)

/** Gate: only people whose CENTRAL account is an admin get in. The central
 * role is the source of truth — module rows are just provisions. */
async function requireCentralAdmin(c: Context<any>): Promise<HomeUser | null> {
  const homeUser = await getHomeUserFromCookie(c.env.HOME_DB, getCookie(c, 'home_session'))
  return homeUser && homeUser.role === 'admin' ? homeUser : null
}

function errMessage(code: string): string {
  switch (code) {
    case 'bad_username': return 'Usernames are 3 to 24 characters: letters, numbers, dot, dash or underscore.'
    case 'bad_password': return 'Passwords must be at least 8 characters.'
    case 'taken': return 'That username is already taken.'
    case 'no_pepper': return 'AUTH_PEPPER is not configured on this Worker.'
    case 'bad_target': return 'User not found.'
    default: return 'Something went wrong.'
  }
}

// ─── GET /admin ─────────────────────────────────────────────
admin.get('/', async (c) => {
  const gate = await requireCentralAdmin(c)
  if (!gate) return c.redirect('/settings?err=only_admins')

  const user = c.get('user')
  const users = await listHomeUsers(c.env.HOME_DB)

  // Per-module account status, so the admin can see provisioning at a glance.
  const rows = await Promise.all(users.map(async (u) => {
    const [sompitra, way, laoka] = await Promise.all([
      c.env.DB.prepare('SELECT id FROM users WHERE lower(username) = lower(?1)').bind(u.username).first().catch(() => null),
      c.env.WAY_DB.prepare('SELECT id FROM users WHERE lower(username) = lower(?1)').bind(u.username).first().catch(() => null),
      c.env.LAOKA_DB.prepare('SELECT id FROM users WHERE lower(username) = lower(?1)').bind(u.username).first().catch(() => null),
    ])
    return { u, sompitra: !!sompitra, way: !!way, laoka: !!laoka }
  }))

  const err = c.req.query('err')
  const ok = c.req.query('ok')

  return c.html(
    <Layout title="Admin" user={user}>
      <div class="max-w-lg mx-auto">
        <div class="flex items-baseline justify-between mb-5">
          <h2 class="text-xl font-bold">👥 People & Access</h2>
          <a href="/admin/diagnostics" class="text-sm text-blue-600 dark:text-blue-400 hover:underline">🩺 Diagnostics</a>
        </div>

        {ok && <p class="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl text-sm text-green-700 dark:text-green-400">✅ Saved</p>}
        {err && <p class="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">{errMessage(err)}</p>}

        {/* Add a person */}
        <Card title="➕ Add a person" className="mb-4">
          <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
            Creates the ONE account: username + password. The account is provisioned
            into Sompitra, W.A.Y and Laoka immediately — share the credentials and
            the person can log in.
          </p>
          <form method="post" action="/admin/users" class="space-y-3">
            <div class="grid grid-cols-2 gap-2">
              <input type="text" name="username" required maxlength={24} placeholder="username (e.g. maxx)" autocapitalize="none" spellcheck={false}
                class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
              <input type="text" name="display_name" maxlength={40} placeholder="Display name (e.g. MaxX)"
                class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
            </div>
            <input type="password" name="password" required minlength={8} placeholder="Password (min 8 characters)" autocomplete="new-password"
              class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
            <select name="role" class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2.5 rounded-xl">Create account</button>
          </form>
        </Card>

        {/* People list */}
        <Card title="👥 Accounts" className="mb-4">
          <div class="space-y-3">
            {rows.map(({ u, sompitra, way, laoka }) => (
              <details class="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl overflow-hidden">
                <summary class="cursor-pointer px-3 py-2.5 flex items-center justify-between gap-2 select-none">
                  <span class="flex items-center gap-2 min-w-0">
                    <span class="text-lg">{u.role === 'admin' ? '👑' : '👤'}</span>
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold truncate">{u.display_name || u.username}</span>
                      <span class="block text-[11px] text-gray-400 truncate">{u.username}</span>
                    </span>
                  </span>
                  <span class="flex items-center gap-1 shrink-0">
                    <span title={`Sompitra ${sompitra ? '✓' : '—'}`} class={`text-[10px] px-1.5 py-0.5 rounded font-bold ${sompitra ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-gray-100 text-gray-400 dark:bg-gray-700'}`}>💰</span>
                    <span title={`W.A.Y ${way ? '✓' : '—'}`} class={`text-[10px] px-1.5 py-0.5 rounded font-bold ${way ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' : 'bg-gray-100 text-gray-400 dark:bg-gray-700'}`}>📍</span>
                    <span title={`Laoka ${laoka ? '✓' : '—'}`} class={`text-[10px] px-1.5 py-0.5 rounded font-bold ${laoka ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' : 'bg-gray-100 text-gray-400 dark:bg-gray-700'}`}>🍲</span>
                    {u.is_active !== 1 && <span class="text-[10px] px-1.5 py-0.5 rounded font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">off</span>}
                  </span>
                </summary>
                <div class="px-3 pb-3 border-t border-gray-100 dark:border-gray-700 space-y-3 pt-3">
                  {/* Reset password */}
                  <form method="post" action={`/admin/users/${u.id}/password`} class="flex gap-2">
                    <input type="password" name="password" required minlength={8} placeholder="New password (min 8)" autocomplete="new-password"
                      class="flex-1 min-w-0 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-green-500" />
                    <button type="submit" class="px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold whitespace-nowrap">Reset</button>
                  </form>
                  {/* Activate / deactivate */}
                  <form method="post" action={`/admin/users/${u.id}/toggle`}>
                    <button type="submit" class={`w-full text-sm font-semibold py-2 rounded-xl ${u.is_active === 1
                      ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40'
                      : 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/40'}`}>
                      {u.is_active === 1 ? '🚫 Deactivate (blocks sign-in everywhere)' : '✅ Reactivate'}
                    </button>
                  </form>
                </div>
              </details>
            ))}
          </div>
        </Card>

        <p class="text-[11px] text-gray-400 text-center">
          Deactivating blocks the central login; module accounts are kept for their data.
          Resetting a password does NOT end existing sessions — sign them out by changing the password
          and having devices log in again.
        </p>
      </div>
    </Layout>
  )
})

// ─── POST /admin/users (create) ─────────────────────────────
admin.post('/users', async (c) => {
  const gate = await requireCentralAdmin(c)
  if (!gate) return c.redirect('/settings?err=only_admins')

  const body = await c.req.parseBody()
  const username = String(body.username || '').trim()
  const displayName = String(body.display_name || '').trim()
  const password = String(body.password || '')
  const role = String(body.role || 'member') === 'admin' ? 'admin' as const : 'member' as const

  const res = await createHomeUser(c.env, { username, password, displayName, role })
  if (!res.ok) {
    const code = /3 to 24/.test(res.error) ? 'bad_username' : /8 characters/.test(res.error) ? 'bad_password' : /taken/.test(res.error) ? 'taken' : 'no_pepper'
    return c.redirect(`/admin?err=${code}`)
  }

  // Provision into every module right away (best-effort) so the person's
  // accounts exist before their first login.
  try { await ensureModuleAccountsWithPassword(c.env, res.user, password) } catch { /* repair path covers it */ }

  return c.redirect('/admin?ok=1')
})

// ─── POST /admin/users/:id/password (reset) ─────────────────
admin.post('/users/:id/password', async (c) => {
  const gate = await requireCentralAdmin(c)
  if (!gate) return c.redirect('/settings?err=only_admins')

  const body = await c.req.parseBody()
  const password = String(body.password || '')
  if (!/^\S{8,200}$/.test(password)) return c.redirect('/admin?err=bad_password')

  const res = await setHomePassword(c.env, c.req.param('id'), password)
  if (!res.ok) return c.redirect('/admin?err=bad_password')
  return c.redirect('/admin?ok=1')
})

// ─── POST /admin/users/:id/toggle (activate / deactivate) ───
admin.post('/users/:id/toggle', async (c) => {
  const gate = await requireCentralAdmin(c)
  if (!gate) return c.redirect('/settings?err=only_admins')

  const id = c.req.param('id')
  const row = await c.env.HOME_DB.prepare('SELECT is_active FROM users WHERE id = ?1').bind(id).first<{ is_active: number }>()
  if (!row) return c.redirect('/admin?err=bad_target')

  await c.env.HOME_DB.prepare('UPDATE users SET is_active = ?1 WHERE id = ?2')
    .bind(row.is_active === 1 ? 0 : 1, id).run()
  return c.redirect('/admin?ok=1')
})

// ─── Diagnostics ─────────────────────────────────────────────
// GET /admin/diagnostics       → the page
// GET /admin/diagnostics.json  → the same facts, machine-readable
//
// WHY this exists (the long version is in src/lib/diagnostics.ts and in
// FleetDO.countGate): every module is built to fail SILENTLY wherever failing
// loudly would land on a person. µlogger must never see an upload error, and a
// push must never break the action that triggered it. Both are right, and the
// price is that "silently fine" and "silently broken" look identical from
// outside — which is exactly what made a real-world test of the tracking rules
// impossible to read, and it is the one class of fact no module was storing.
//
// This surface is deliberately HOME-wide, not a W.A.Y back door. It reads the
// same ledger every module writes to: money and Kiné notifications refuse or
// skip into home-db's diag_events, tracking gates count themselves in the
// FleetDO's own SQLite (they are far too frequent for D1), and module health
// probes all four databases.

interface ModuleHealth { name: string; ok: boolean; detail: string; ms: number }

async function probe(db: D1Database | undefined, name: string, sql: string): Promise<ModuleHealth> {
  const t0 = Date.now()
  if (!db) return { name, ok: false, detail: 'binding is missing', ms: 0 }
  try {
    const row = await db.prepare(sql).first<Record<string, unknown>>()
    const detail = row
      ? Object.entries(row).map(([k, v]) => `${k}=${v ?? '—'}`).join('  ')
      : 'answered, but with no rows'
    return { name, ok: true, detail, ms: Date.now() - t0 }
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 }
  }
}

interface IngestGate { gate: string; n: number; firstAt: string; lastAt: string }
interface IngestDrop { at: string; deviceId: string | null; gate: string; detail: string }

/**
 * The gates in the order a ping meets them, INCLUDING the ones that never
 * fired. The DO only stores gates it has counted, so a fresh reading would
 * otherwise omit `drawn` entirely — and "0 drawn" is the single most important
 * number to see after a parked-phone test (it is the difference between "the
 * phone was collapsed on purpose" and "nothing is being stored"). A missing row
 * reads as "this gate does not exist".
 */
const GATE_ORDER = [
  'received', 'accuracy', 'report-unbelievable', 'glitch', 'accepted',
  'drawn', 'collapsed', 'unwitnessed', 'paused',
] as const

/** Ask the FleetDO for its gate ledger. Returns null when the DO cannot be
 *  reached, so the page can say so instead of showing zeroes that would read as
 *  "nothing was ever dropped". */
async function readIngest(env: Env): Promise<{
  build: string | null; gates: IngestGate[]; drops: IngestDrop[]; error?: string
} | null> {
  if (!env.FLEET_DO) return null
  try {
    const id = env.FLEET_DO.idFromName('fleet')
    const res = await env.FLEET_DO.get(id).fetch('https://fleet-do/debug-notify', { method: 'GET' })
    if (res.status === 404) {
      return { build: null, gates: [], drops: [], error: 'the running instance is running PRE-ledger code (no /debug-notify route)' }
    }
    const data = (await res.json()) as { build?: string; ingest?: { gates?: IngestGate[]; drops?: IngestDrop[] } }
    return { build: data.build ?? null, gates: data.ingest?.gates ?? [], drops: data.ingest?.drops ?? [] }
  } catch (e) {
    return { build: null, gates: [], drops: [], error: e instanceof Error ? e.message : String(e) }
  }
}

async function buildDiagnostics(c: Context<any>) {
  const env = c.env as Env

  // Module health: one cheap query each. The index probe is deliberately here
  // rather than in a doc -- an unindexed gps_pings is the one schema fact that
  // turns into a same-day outage as real data accumulates, so it belongs where
  // somebody will actually see it.
  const [home, sompitra, way, laoka, indexes] = await Promise.all([
    probe(env.HOME_DB, 'home-db', 'SELECT (SELECT COUNT(*) FROM users) AS people, (SELECT COUNT(*) FROM diag_events) AS ledger'),
    probe(env.DB, 'sompitra-db', 'SELECT COUNT(*) AS transactions FROM transactions'),
    probe(env.WAY_DB, 'way-db', 'SELECT COUNT(*) AS pings FROM gps_pings'),
    probe(env.LAOKA_DB, 'laoka', 'SELECT COUNT(*) AS weeks FROM weeks'),
    probe(env.WAY_DB, 'way-db indexes', "SELECT COUNT(*) AS on_pings FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('gps_pings', 'messages')"),
  ])

  const ingest = await readIngest(env)
  const ledger = await readDiag(env, 40)

  // The arithmetic that makes the ledger readable: a ping that arrived either
  // died at a gate or reached the state machine, and one that reached it was
  // either drawn, collapsed, unwitnessed or paused. A sum that does not hold
  // means a gate exists that nobody is counting.
  const rawGates = ingest?.gates ?? []
  const gates: IngestGate[] = GATE_ORDER.map((name) => {
    const hit = rawGates.find((g) => g.gate === name)
    return hit ?? { gate: name, n: 0, firstAt: '', lastAt: '' }
  }).concat(rawGates.filter((g) => !(GATE_ORDER as readonly string[]).includes(g.gate)))
  const n = (name: string) => gates.find((g) => g.gate === name)?.n ?? 0
  const sumIn = n('accuracy') + n('glitch') + n('accepted')
  const sumOut = n('drawn') + n('collapsed') + n('unwitnessed') + n('paused')

  return {
    at: new Date().toISOString(),
    modules: [home, sompitra, way, laoka, indexes],
    ingest: ingest ? { ...ingest, gates, checks: { received: n('received'), sumIn, sumInHolds: n('received') === sumIn, accepted: n('accepted'), sumOut, sumOutHolds: n('accepted') === sumOut } } : null,
    ledger,
    indexWarning: indexes.ok && /on_pings=0\b/.test(indexes.detail)
      ? 'way-db has NO index on gps_pings or messages: every history load scans the whole table, which is the one schema fact that becomes a same-day outage as real data accumulates. See DB-REDESIGN.md §1a.'
      : null,
  }
}

// Zero the gate ledger so the next reading starts clean — the normal thing to
// do before watching a real device for a while. See FleetDO's /reset-gates.
admin.post('/diagnostics/reset', async (c) => {
  const gate = await requireCentralAdmin(c)
  if (!gate) return c.redirect('/settings?err=only_admins')
  try {
    const id = c.env.FLEET_DO.idFromName('fleet')
    const res = await c.env.FLEET_DO.get(id).fetch('https://fleet-do/reset-gates', { method: 'POST' })
    if (res.status === 404) return c.redirect('/admin/diagnostics?err=stale_do')
  } catch (e) {
    return c.redirect('/admin/diagnostics?err=reset_failed')
  }
  return c.redirect('/admin/diagnostics?ok=reset')
})

admin.get('/diagnostics.json', async (c) => {
  const gate = await requireCentralAdmin(c)
  if (!gate) return c.json({ error: 'Admin only' }, 403)
  return c.json(await buildDiagnostics(c))
})

admin.get('/diagnostics', async (c) => {
  const gate = await requireCentralAdmin(c)
  if (!gate) return c.redirect('/settings?err=only_admins')

  const user = c.get('user')
  const report = await buildDiagnostics(c)
  const { ingest, ledger, modules } = report

  const outcomeTone: Record<string, string> = {
    refused: 'text-red-600 dark:text-red-400',
    skipped: 'text-amber-600 dark:text-amber-400',
    dropped: 'text-blue-600 dark:text-blue-400',
    failed: 'text-red-600 dark:text-red-400',
  }

  return c.html(
    <Layout title="Diagnostics" user={user}>
      <div class="max-w-3xl mx-auto">
        <div class="flex items-baseline justify-between mb-5">
          <h2 class="text-xl font-bold">🩺 Diagnostics</h2>
          <a href="/admin/diagnostics.json" class="text-xs font-mono text-blue-600 dark:text-blue-400 hover:underline">.json</a>
        </div>

        {c.req.query('ok') === 'reset' && (
          <p class="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl text-sm text-green-700 dark:text-green-400">
            ✅ Gate counters cleared — the next reading starts from zero.
          </p>
        )}
        {c.req.query('err') && (
          <p class="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">
            {c.req.query('err') === 'stale_do'
              ? 'The running Durable Object is running pre-ledger code, so there is nothing to clear.'
              : 'The reset failed — the Durable Object could not be reached.'}
          </p>
        )}

        <p class="text-sm text-gray-500 dark:text-gray-400 mb-5">
          Everything every module was built to fail silently at — the tracking gates and
          every notification that did not reach a phone. Read the sum lines first: they say
          whether the numbers below can be trusted.
        </p>

        <Card title="Databases" icon="🗄️" className="mb-4">
          <div class="space-y-2">
            {modules.map((m) => (
              <div class="flex items-start gap-3 text-sm">
                <span class={m.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                  {m.ok ? '●' : '✕'}
                </span>
                <span class="font-semibold w-32 shrink-0">{m.name}</span>
                <span class="text-gray-600 dark:text-gray-400 font-mono text-xs break-all flex-1">{m.detail}</span>
                <span class="text-gray-400 text-xs">{m.ms}ms</span>
              </div>
            ))}
          </div>
          {report.indexWarning && (
            <p class="mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl text-xs text-amber-700 dark:text-amber-400">
              ⚠️ {report.indexWarning}
            </p>
          )}
        </Card>

        <Card title="Tracking intake (W.A.Y)" icon="📡" className="mb-4">
          {!ingest
            ? <p class="text-sm text-gray-500">The FleetDO binding is not available.</p>
            : ingest.error
              ? <p class="text-sm text-amber-600 dark:text-amber-400">{ingest.error}</p>
              : (
                <div class="space-y-3">
                  <div class="flex items-baseline justify-between">
                    <p class="text-xs text-gray-500 dark:text-gray-400">
                      Durable Object build: <span class="font-mono">{ingest.build ?? 'unknown'}</span>
                    </p>
                    <form method="post" action="/admin/diagnostics/reset">
                      <button type="submit" class="text-xs px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 font-semibold">
                        Reset counters
                      </button>
                    </form>
                  </div>

                  <div class="grid grid-cols-2 gap-2 text-sm">
                    {ingest.gates.map((g) => (
                      <div class={`flex justify-between px-3 py-2 rounded-lg ${g.n === 0 ? 'bg-gray-50/50 dark:bg-gray-700/20' : 'bg-gray-50 dark:bg-gray-700/40'}`}>
                        <span class={`font-mono text-xs ${g.n === 0 ? 'text-gray-400 dark:text-gray-500' : 'text-gray-600 dark:text-gray-300'}`}>{g.gate}</span>
                        <span class={g.n === 0 ? 'font-bold text-gray-400 dark:text-gray-500' : 'font-bold'}>{g.n}</span>
                      </div>
                    ))}
                  </div>

                  <div class="text-xs space-y-1 border-t border-gray-100 dark:border-gray-700 pt-3">
                    <p class={ingest.checks.sumInHolds ? 'text-gray-500 dark:text-gray-400' : 'text-red-600 dark:text-red-400'}>
                      {ingest.checks.sumInHolds ? '✅' : '⚠️'} received {ingest.checks.received} = accuracy + glitch + accepted ({ingest.checks.sumIn})
                    </p>
                    <p class={ingest.checks.sumOutHolds ? 'text-gray-500 dark:text-gray-400' : 'text-red-600 dark:text-red-400'}>
                      {ingest.checks.sumOutHolds ? '✅' : '⚠️'} accepted {ingest.checks.accepted} = drawn + collapsed + unwitnessed + paused ({ingest.checks.sumOut})
                    </p>
                    <p class="text-gray-400">
                      Counters are durable (they survive an eviction) but scoped to the build that
                      wrote them — a deploy that changes the Durable Object's code clears them, and
                      “Reset counters” starts a clean reading on purpose.
                    </p>
                  </div>

                  <div>
                    <p class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">Last drops</p>
                    {ingest.drops.length === 0
                      ? <p class="text-xs text-gray-400">Nothing has been dropped since this build started counting.</p>
                      : <div class="space-y-1">
                        {ingest.drops.slice(0, 12).map((d) => (
                          <div class="text-xs flex gap-2">
                            {/* Date AND time, like the ledger rows below: a bare HH:MM:SS
                                reads as "today" for a drop that arrived yesterday. Both are UTC. */}
                            <span class="font-mono text-gray-400 shrink-0">{d.at.slice(5, 19).replace('T', ' ')}</span>
                            <span class="font-mono text-blue-600 dark:text-blue-400 shrink-0 w-32 truncate">{d.gate}</span>
                            <span class="text-gray-600 dark:text-gray-400 break-all">{d.detail}</span>
                          </div>
                        ))}
                      </div>}
                  </div>
                </div>
              )}
        </Card>

        <Card title="Notification ledger (all modules)" icon="🔔" className="mb-4">
          {!ledger || ledger.error
            ? <p class="text-sm text-amber-600 dark:text-amber-400">{ledger?.error ?? 'the ledger could not be read'}</p>
            : ledger.total === 0
              ? <p class="text-sm text-gray-500 dark:text-gray-400">
                  Nothing has been recorded yet — which also means every push has been reaching its channel.
                </p>
              : (
                <div class="space-y-3">
                  <div class="text-xs text-gray-500 dark:text-gray-400">
                    {ledger.total} entries, {ledger.first_at?.slice(0, 10)} → {ledger.last_at?.slice(0, 10)}
                  </div>
                  <div class="space-y-1">
                    {ledger.counts.map((k) => (
                      <div class="flex justify-between text-sm px-3 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-700/40">
                        <span class="text-xs">
                          <span class="font-semibold">{k.module}</span>
                          <span class="text-gray-400"> · </span>
                          <span class="font-mono">{k.kind}</span>
                          <span class={outcomeTone[k.outcome] || ''}> · {k.outcome}</span>
                        </span>
                        <span class="font-bold">{k.n}</span>
                      </div>
                    ))}
                  </div>
                  <div class="border-t border-gray-100 dark:border-gray-700 pt-3">
                    <p class="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">Most recent</p>
                    <div class="space-y-1">
                      {ledger.events.slice(0, 15).map((e) => (
                        <div class="text-xs flex gap-2">
                          <span class="font-mono text-gray-400 shrink-0">{e.at.slice(5, 16).replace('T', ' ')}</span>
                          <span class="font-mono text-gray-500 dark:text-gray-400 shrink-0">{e.module}</span>
                          <span class="text-gray-600 dark:text-gray-400 break-all">{e.detail}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
        </Card>

        <p class="text-xs text-gray-400 text-center mt-6">
          Built {report.at.slice(0, 19).replace('T', ' ')} UTC · <a href="/admin" class="hover:underline">back to admin</a>
        </p>
      </div>
    </Layout>
  )
})

export default admin
