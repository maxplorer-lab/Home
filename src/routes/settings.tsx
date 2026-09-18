/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { Layout, Card } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import { getSetting, setSetting, pushNtfy } from '../lib/notify'
import type { Env, User } from '../db/schema'

const settings = new Hono<{ Bindings: Env; Variables: { user: User } }>()
settings.use('*', requireAuth)

function errMessage(code: string): string {
  switch (code) {
    case 'only_admins': return 'Only admins can manage people and access.'
    case 'bad_target': return 'Target user not found.'
    case 'bad_server': return 'Server URL must start with http:// or https://'
    default: return 'Something went wrong.'
  }
}

// ─── GET /settings ─────────────────────────────────────────
settings.get('/', async (c) => {
  const user = c.get('user')
  const err = c.req.query('err')
  const ok = c.req.query('ok')

  const ntfyServer = (await getSetting(c.env.DB, 'ntfy_server')) || ''
  const ntfyTopic = (await getSetting(c.env.DB, 'ntfy_topic')) || ''

  return c.html(
    <Layout title="Settings" user={user} activeTab="settings">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-5">⚙️ Settings</h2>

        {ok && (
          <p class="mb-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl text-sm text-green-700 dark:text-green-400">✅ Saved</p>
        )}
        {err && (
          <p class="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">{errMessage(err)}</p>
        )}

        {/* Categories */}
        <Card title="📂 Categories & Groups" className="mb-4">
          <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">Add, rename or remove budget categories and their groups.</p>
          <a href="/categories" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">Manage Categories →</a>
        </Card>

        {/* Income accounts */}
        <Card title="💵 Income Accounts" className="mb-4">
          <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">Add or remove income sources for MaxX and Niri.</p>
          <a href="/budget/accounts" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">Manage Income Accounts →</a>
        </Card>

        {/* Password (one login for the whole super app) */}
        <Card title="🔐 Password" className="mb-4">
          <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
            Your password signs you into the whole app — Sompitra, W.A.Y and Laoka.
          </p>
          <a href="/change-password" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">Change my password →</a>
        </Card>

        {/* Admin: ntfy notifications */}
        {user.is_admin === 1 && (
          <Card title="🔔 Notifications (ntfy)" className="mb-4">
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
              Every logged transaction is pushed to your ntfy server, using the same wording as the
              Home activity feed. Leave the topic empty to turn notifications off.
            </p>
            <form method="post" action="/settings/notifications" class="space-y-3">
              <div>
                <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">ntfy server URL</label>
                <input type="url" name="ntfy_server" id="ntfy-server" value={ntfyServer} placeholder="https://ntfy.sh"
                  class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
              </div>
              <div>
                <label class="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Topic</label>
                <div class="flex gap-2">
                  <input type="text" name="ntfy_topic" id="ntfy-topic" value={ntfyTopic} placeholder="e.g. sompitra-a1b2c3d4"
                    class="flex-1 min-w-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500" />
                  <button type="button" onclick="genTopic()"
                    class="px-3 py-2.5 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-medium whitespace-nowrap">🎲 Generate</button>
                </div>
              </div>
              <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2.5 rounded-xl">Save notifications</button>
            </form>
            <form method="post" action="/settings/notifications/test" class="mt-2">
              <button type="submit" class="w-full bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-medium py-2 rounded-xl">Send test notification</button>
            </form>
            <script dangerouslySetInnerHTML={{ __html: `
              function genTopic() {
                var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
                var t = 'sompitra-';
                for (var i = 0; i < 12; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
                document.getElementById('ntfy-topic').value = t;
              }
            `}} />
          </Card>
        )}

        {/* Admin: people & access (the one account per person) */}
        {user.is_admin === 1 && (
          <Card title="👥 People & Access (Admin)" className="mb-4">
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
              Add people, set their password and role. One account signs them into
              every module — accounts are provisioned into Sompitra, W.A.Y and Laoka
              automatically.
            </p>
            <a href="/admin" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">Manage people →</a>
          </Card>
        )}
      </div>
    </Layout>
  )
})

// ─── POST /settings/notifications ──────────────────────────
settings.post('/notifications', async (c) => {
  const user = c.get('user')
  if (user.is_admin !== 1) return c.redirect('/settings')

  const body = await c.req.parseBody()
  const server = String(body.ntfy_server || '').trim()
  const topic = String(body.ntfy_topic || '').trim()

  if (server && !/^https?:\/\//i.test(server)) return c.redirect('/settings?err=bad_server')

  await setSetting(c.env.DB, 'ntfy_server', server)
  await setSetting(c.env.DB, 'ntfy_topic', topic)
  return c.redirect('/settings?ok=1')
})

// ─── POST /settings/notifications/test ─────────────────────
settings.post('/notifications/test', async (c) => {
  const user = c.get('user')
  if (user.is_admin !== 1) return c.redirect('/settings')

  await pushNtfy(c.env.DB, 'Sompitra test', `${user.display_name} · test notification`, 'green')
  return c.redirect('/settings?ok=1')
})

export default settings
