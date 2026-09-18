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
        <h2 class="text-xl font-bold mb-5">👥 People & Access</h2>

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

export default admin
