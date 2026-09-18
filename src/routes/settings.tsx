/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { Layout, Card } from '../views/layout'
import { requireAuth } from '../lib/middleware'
import { ntfyServer, pushNtfyTo } from '../lib/notify'
import { reloadWayNotifications } from '../way/worker'
import {
  findHomeUserByName,
  listNtfyChannels,
  setNtfyTopic,
  clearNtfyTopic,
  adoptWayTopics,
  getHomeSetting,
  setHomeSetting,
} from '../identity'
import type { Env, User } from '../db/schema'

const settings = new Hono<{ Bindings: Env; Variables: { user: User } }>()
settings.use('*', requireAuth)

function errMessage(code: string): string {
  switch (code) {
    case 'bad_server': return 'Server URL must start with http:// or https://'
    case 'no_channel': return 'You have no notification channel yet — generate one first.'
    case 'no_server': return 'Set the ntfy server URL first (an admin can do it below).'
    case 'bad_person': return 'That person no longer exists.'
    default: return code ? decodeURIComponent(code) : 'Something went wrong.'
  }
}

/** A titled group of cards — the page is organised by WHO a setting belongs
    to (you / the household / a module), not by which app it came from. */
const Section = ({ title, subtitle, children }: { title: string; subtitle?: string; children?: any }) => (
  <section class="mb-7">
    <h3 class="text-xs font-bold uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-1">{title}</h3>
    {subtitle && <p class="text-xs text-gray-400 dark:text-gray-500 mb-3">{subtitle}</p>}
    <div class={subtitle ? '' : 'mt-3'}>{children}</div>
  </section>
)

const Btn = ({ children, tone = 'plain' }: { children?: any; tone?: 'plain' | 'primary' | 'danger' }) => {
  const cls =
    tone === 'primary'
      ? 'bg-green-600 hover:bg-green-700 text-white'
      : tone === 'danger'
        ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40'
        : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
  return <button type="submit" class={`px-3 py-2 rounded-xl text-xs font-semibold transition-colors ${cls}`}>{children}</button>
}

// ─── GET /settings ─────────────────────────────────────────
settings.get('/', async (c) => {
  const user = c.get('user')
  const isAdmin = user.is_admin === 1
  const err = c.req.query('err')
  const ok = c.req.query('ok')

  const home = await findHomeUserByName(c.env.HOME_DB, user.username)
  const server = await ntfyServer(c.env)
  const channels = await listNtfyChannels(c.env.HOME_DB)
  const mine = channels.find((ch) => ch.id === home?.id) ?? null
  const withChannel = channels.filter((ch) => (ch.ntfy_topic || '').trim()).length
  const legacyServer = (await getHomeSetting(c.env.HOME_DB, 'ntfy_server')) || ''

  return c.html(
    <Layout title="Settings" user={user} activeTab="settings">
      <div class="max-w-lg mx-auto">
        <h2 class="text-xl font-bold mb-1">⚙️ Settings</h2>
        <p class="text-xs text-gray-400 dark:text-gray-500 mb-5">
          One place for the whole household — your account, your notifications and the module settings.
        </p>

        {ok && (
          <p class="mb-5 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl text-sm text-green-700 dark:text-green-400">
            ✅ {ok === '1' ? 'Saved' : decodeURIComponent(ok)}
          </p>
        )}
        {err && (
          <p class="mb-5 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">
            {errMessage(err)}
          </p>
        )}

        {/* ── YOU ───────────────────────────────────────────── */}
        <Section title="You" subtitle={`Signed in as ${user.display_name || user.username}.`}>
          <Card title="🔐 Name & password" className="mb-4">
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
              Your password signs you into the whole app — Sompitra, W.A.Y and Laoka.
            </p>
            <div class="flex flex-wrap gap-2">
              <a href="/change-password" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">
                Change my password →
              </a>
              <a href="/admin" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">
                My account details →
              </a>
            </div>
          </Card>
        </Section>

        {/* ── NOTIFICATIONS (the unified ntfy channel) ──────── */}
        <Section
          title="Notifications"
          subtitle="Every module pushes to YOUR channel, so one ntfy topic on your phone covers the whole app."
        >
          <Card title="🔔 Your channel" className="mb-4">
            {mine?.ntfy_topic ? (
              <>
                <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">
                  Subscribe to this topic in the ntfy app on your phone. It is yours alone.
                </p>
                <div class="flex gap-2 mb-3">
                  <input
                    type="text"
                    readonly
                    value={mine.ntfy_topic}
                    id="my-topic"
                    class="flex-1 min-w-0 bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-600 rounded-xl px-3 py-2.5 text-xs font-mono"
                  />
                  <button
                    type="button"
                    onclick="copyTopic()"
                    class="px-3 py-2.5 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-xs font-semibold"
                  >
                    Copy
                  </button>
                </div>
                <p class="text-[11px] text-gray-400 dark:text-gray-500 mb-3">
                  Server: <span class="font-mono">{server || '— not set —'}</span>
                </p>
              </>
            ) : (
              <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
                You have no channel yet. Generate one to start receiving notifications from every module.
              </p>
            )}

            <div class="flex flex-wrap gap-2">
              <form method="post" action="/settings/channel">
                <input type="hidden" name="action" value="rotate" />
                <Btn tone="primary">{mine?.ntfy_topic ? '🎲 New channel' : '🎲 Generate my channel'}</Btn>
              </form>
              <form method="post" action="/settings/notifications/test">
                <Btn>Send a test</Btn>
              </form>
              {mine?.ntfy_topic && (
                <form method="post" action="/settings/channel">
                  <input type="hidden" name="action" value="off" />
                  <Btn tone="danger">Turn off</Btn>
                </form>
              )}
            </div>
            <p class="text-[11px] text-gray-400 dark:text-gray-500 mt-3">
              Making a new channel stops the old one immediately — remember to update the topic on your phone.
            </p>
            <script
              dangerouslySetInnerHTML={{
                __html: `
                  function copyTopic() {
                    var el = document.getElementById('my-topic');
                    if (!el) return;
                    el.select();
                    try { navigator.clipboard.writeText(el.value); } catch (e) { document.execCommand('copy'); }
                  }
                `,
              }}
            />
          </Card>

          {isAdmin ? (
            <Card title="🏠 Everyone in the household" className="mb-4">
              <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
                {withChannel} of {channels.length} {channels.length === 1 ? 'person has' : 'people have'} a channel.
              </p>
              <div class="space-y-2 mb-4">
                {channels.map((ch) => (
                  <div class="flex flex-wrap items-center gap-2 p-2.5 rounded-xl bg-gray-50 dark:bg-gray-900/40">
                    <span class="flex-1 min-w-0 text-sm font-semibold truncate">{ch.display_name || ch.username}</span>
                    <span class="font-mono text-[11px] text-gray-500 dark:text-gray-400 truncate max-w-[45%]">
                      {ch.ntfy_topic || 'no channel'}
                    </span>
                    <form method="post" action={`/settings/channel/${ch.id}`} class="flex gap-1.5">
                      <input type="hidden" name="action" value="rotate" />
                      <button type="submit" class="px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-[11px] font-semibold">
                        🎲
                      </button>
                    </form>
                    {ch.ntfy_topic && (
                      <form method="post" action={`/settings/channel/${ch.id}`}>
                        <input type="hidden" name="action" value="off" />
                        <button type="submit" class="px-2 py-1 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-[11px] font-semibold">
                          ✕
                        </button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
              <form method="post" action="/settings/adopt-way" class="mb-2">
                <Btn>Adopt channels from W.A.Y</Btn>
              </form>
              <p class="text-[11px] text-gray-400 dark:text-gray-500">
                Copies the topics that already exist in W.A.Y, so a phone that is already following one keeps working.
              </p>
            </Card>
          ) : null}

          {isAdmin ? (
            <Card title="📡 ntfy server" className="mb-4">
              <p class="text-xs text-gray-500 dark:text-gray-400 mb-3">
                Shared by every module and every person. Leave empty to disable all push notifications.
              </p>
              <form method="post" action="/settings/notifications" class="space-y-3">
                <input
                  type="url"
                  name="ntfy_server"
                  value={legacyServer || server}
                  placeholder="https://ntfy.sh"
                  class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-green-500"
                />
                <Btn tone="primary">Save server</Btn>
              </form>
            </Card>
          ) : null}
        </Section>

        {/* ── SOMPITRA ──────────────────────────────────────── */}
        <Section title="Sompitra" subtitle="Budget, Kiné, debts, credits and stock.">
          <Card title="📂 Categories, accounts & access" className="mb-4">
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
              Add, rename or remove budget categories and their groups, and manage income sources.
            </p>
            <div class="flex flex-wrap gap-2 mb-3">
              <a href="/categories" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">
                Manage Categories →
              </a>
              <a href="/budget/accounts" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">
                Manage Income Accounts →
              </a>
            </div>
          </Card>
          {user.is_admin === 1 && (
            <Card title="👥 People & Access" className="mb-4">
              <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
                Add people, set their password and role. One account signs them into every module.
              </p>
              <a href="/admin" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">
                Manage people →
              </a>
            </Card>
          )}
        </Section>

        {/* ── W.A.Y ─────────────────────────────────────────── */}
        <Section title="W.A.Y" subtitle="Tracking, geofences, devices and the household chat.">
          <Card title="📍 Tracking settings" className="mb-4">
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
              Profile, map defaults, device controls, geofences, users &amp; topics, invite codes and history live
              in the W.A.Y tab&apos;s Settings &mdash; the maps and device pickers they act on are right there.
            </p>
            <a href="/way/" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">
              Open W.A.Y settings →
            </a>
          </Card>
        </Section>

        {/* ── LAOKA ─────────────────────────────────────────── */}
        <Section title="Laoka" subtitle="The weekly dinner planner and shopping list.">
          <Card title="🍲 Meal plan settings" className="mb-4">
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
              Group icons, weeks and the shopping list are managed inside Laoka itself.
            </p>
            <a href="/laoka/" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">
              Open Laoka →
            </a>
          </Card>
        </Section>
      </div>
    </Layout>
  )
})

// ─── POST /settings/notifications (household server) ───────
settings.post('/notifications', async (c) => {
  const user = c.get('user')
  if (user.is_admin !== 1) return c.redirect('/settings')
  const body = await c.req.parseBody()
  const server = String(body.ntfy_server || '').trim()
  if (server && !/^https?:\/\//i.test(server)) return c.redirect('/settings?err=bad_server')
  await setHomeSetting(c.env.HOME_DB, 'ntfy_server', server)
  // Keep the legacy Sompitra copy in step so a rollback still notifies, and
  // drop the FleetDO's cached server URL (it resolves one at cache-load time).
  const { setSetting } = await import('../lib/notify')
  await setSetting(c.env.DB, 'ntfy_server', server)
  await reloadWayNotifications(c.env)
  return c.redirect('/settings?ok=Server saved')
})

// ─── POST /settings/notifications/test (my own channel) ────
settings.post('/notifications/test', async (c) => {
  const user = c.get('user')
  const home = await findHomeUserByName(c.env.HOME_DB, user.username)
  if (!home) return c.redirect('/settings?err=bad_person')
  const channels = await listNtfyChannels(c.env.HOME_DB)
  const mine = channels.find((ch) => ch.id === home.id)
  if (!mine?.ntfy_topic) return c.redirect('/settings?err=no_channel')
  const sent = await pushNtfyTo(c.env, mine.ntfy_topic, 'Home test', `${user.display_name || user.username} · test notification`, 'green')
  return c.redirect(sent ? '/settings?ok=Test sent to your channel' : '/settings?err=no_server')
})

// ─── POST /settings/channel (my own channel) ───────────────
settings.post('/channel', async (c) => {
  const user = c.get('user')
  const home = await findHomeUserByName(c.env.HOME_DB, user.username)
  if (!home) return c.redirect('/settings?err=bad_person')
  const body = await c.req.parseBody()
  const action = String(body.action || 'rotate')
  if (action === 'off') await clearNtfyTopic(c.env.HOME_DB, home.id)
  else await setNtfyTopic(c.env.HOME_DB, home.id)
  // The FleetDO caches channels, so tell it to re-read them or a rotation
  // looks like it silently failed for W.A.Y activity (Sompitra reads live).
  await reloadWayNotifications(c.env)
  return c.redirect('/settings?ok=Notification channel updated')
})

// ─── POST /settings/channel/:id (admin, anyone) ────────────
settings.post('/channel/:id', async (c) => {
  const user = c.get('user')
  if (user.is_admin !== 1) return c.redirect('/settings')
  const body = await c.req.parseBody()
  const action = String(body.action || 'rotate')
  if (action === 'off') await clearNtfyTopic(c.env.HOME_DB, c.req.param('id'))
  else await setNtfyTopic(c.env.HOME_DB, c.req.param('id'))
  await reloadWayNotifications(c.env)
  return c.redirect('/settings?ok=Channel updated')
})

// ─── POST /settings/adopt-way (admin) ─────────────────────
settings.post('/adopt-way', async (c) => {
  const user = c.get('user')
  if (user.is_admin !== 1) return c.redirect('/settings')
  const adopted = await adoptWayTopics(c.env)
  await reloadWayNotifications(c.env)
  return c.redirect(`/settings?ok=${encodeURIComponent(adopted === 1 ? 'Adopted 1 channel from W.A.Y' : `Adopted ${adopted} channels from W.A.Y`)}`)
})

export default settings
