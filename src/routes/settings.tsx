/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { Layout, Card } from '../views/layout'
// The brand glyph set and the module colour table — the settings sections wear
// the same colour and mark as the tab they belong to.
import { HOME_TABS, Icon } from '../views/app-chrome'
import { requireAuth } from '../lib/middleware'
import { ntfyServer, pushNtfyTo } from '../lib/notify'
import { reloadWayNotifications } from '../way/worker'
import { inQuietHours } from '../way/lib/notify'
import {
  findHomeUserByName,
  listNtfyChannels,
  setNtfyTopic,
  clearNtfyTopic,
  setWayTopic,
  clearWayTopic,
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
    case 'no_channel': return 'You have no channel on that side yet — generate one first.'
    case 'bad_person': return 'That person no longer exists.'
    // Anything else is a message we wrote ourselves (a failed push explains
    // itself). It is already decoded by the time it arrives, so a literal '%' in
    // it must not be handed to decodeURIComponent — that throws, and a 500 on
    // the very page someone opened to find out what went wrong is the worst
    // possible answer.
    default: return code || 'Something went wrong.'
  }
}

/**
 * One person's quiet window, as W.A.Y holds it.
 *
 * Quiet hours live in way-db (`users.quiet_start` / `quiet_end`) and apply to
 * the TRACKING channel only — which is exactly why they have to be visible on
 * the card that owns that channel. Between those hours every non-chat event is
 * dropped in silence, so "nothing arrives at night" is expected-but-invisible
 * unless the number is on the screen.
 *
 * Best-effort: no way-db, or nobody by that name, simply shows nothing.
 */
async function quietWindow(env: Env, username: string): Promise<{ start: number; end: number; active: boolean } | null> {
  try {
    const row = await env.WAY_DB
      .prepare('SELECT quiet_start, quiet_end FROM users WHERE lower(username) = lower(?)')
      .bind(username)
      .first<{ quiet_start: number | null; quiet_end: number | null }>()
    if (!row) return null
    const start = row.quiet_start ?? 22
    const end = row.quiet_end ?? 6
    return { start, end, active: inQuietHours(start, end, Date.now()) }
  } catch {
    return null
  }
}

/** 22 → "22:00", in household time (Africa/Nairobi, UTC+3). */
function clockHour(hour: number): string {
  return `${String(((hour % 24) + 24) % 24).padStart(2, '0')}:00`
}

interface Following {
  /** How many cells of W.A.Y's grid name this person as the recipient. */
  events: number
  /** Whose activity those cells are about, lower-cased. */
  sources: string[]
  quiet: { start: number; end: number }
}

/**
 * What W.A.Y's subscription grid promises each person.
 *
 * This is the half of the routing that lives in another module, and it is the
 * half that fails SILENTLY: W.A.Y can be told "niri wants maxx's arrivals" and
 * still deliver nothing, because the events go to her TRACKING topic and she has
 * none. The grid says yes, no phone rings, and no screen anywhere admits it —
 * which is how a household ends up debugging a working pipeline. Read here so
 * the admin card can say it out loud.
 *
 * Best-effort: no way-db (fresh deploy) simply shows nothing.
 */
async function wayFollowing(env: Env): Promise<Map<string, Following>> {
  const out = new Map<string, Following>()
  try {
    const { results } = await env.WAY_DB
      .prepare(
        `SELECT lower(su.username) AS subscriber, lower(src.username) AS source,
                su.quiet_start, su.quiet_end
         FROM notification_subs s
         JOIN users su  ON su.id  = s.subscriber_id
         JOIN users src ON src.id = s.source_id`
      )
      .all<{ subscriber: string; source: string; quiet_start: number | null; quiet_end: number | null }>()
    for (const row of results ?? []) {
      const cur =
        out.get(row.subscriber) ??
        { events: 0, sources: [], quiet: { start: row.quiet_start ?? 22, end: row.quiet_end ?? 6 } }
      cur.events += 1
      if (!cur.sources.includes(row.source)) cur.sources.push(row.source)
      out.set(row.subscriber, cur)
    }
  } catch {
    // No way-db: the card just does not make the claim.
  }
  return out
}

/** A titled group of cards — the page is organised by WHO a setting belongs
    to (you / the household / a module), not by which app it came from.

    A module's own section can carry that module's colour and glyph, so the
    "Sompitra" heading looks like the Sompitra tab even from inside You. The
    colour arrives as `--accent`, the same variable the card headings read,
    which is what keeps the dark-mode lift working here too. */
const Section = ({ title, subtitle, icon, accent, children }: {
  title: string; subtitle?: string; icon?: string; accent?: string; children?: any
}) => (
  <section class="mb-7">
    <h3 class="flex items-center gap-2 section-title text-gray-400 dark:text-gray-500 mb-1"
      style={accent ? { '--accent': accent } : undefined}>
      {icon && <span class="accent-mark flex shrink-0"><Icon name={icon} className="w-[14px] h-[14px]" /></span>}
      {title}
    </h3>
    {subtitle && <p class="text-xs text-gray-400 dark:text-gray-500 mb-3">{subtitle}</p>}
    <div class={subtitle ? '' : 'mt-3'}>{children}</div>
  </section>
)

// The primary action wears the SCREEN's colour, not a hard-coded green: these
// buttons live on the You tab, whose accent is slate, and a green button there
// is the same "whose app is this?" tell as an off-brand heading. The filled
// variant (--accent-ink) exists because white text on the tint is under 4.5:1.
const Btn = ({ children, tone = 'plain' }: { children?: any; tone?: 'plain' | 'primary' | 'danger' }) => {
  const cls =
    tone === 'primary'
      ? 'text-white hover:opacity-90'
      : tone === 'danger'
        ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40'
        : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
  return (
    <button
      type="submit"
      style={tone === 'primary' ? { backgroundColor: 'var(--accent-ink)' } : undefined}
      class={`px-3 py-2 rounded-xl text-xs font-semibold transition-colors ${cls}`}
    >{children}</button>
  )
}

/**
 * One notification channel, complete: its topic, what lands in it, and every
 * action that changes it.
 *
 * Both channels render through this on purpose. They are the same kind of
 * thing — a topic on a phone — and the failure mode of two hand-written cards
 * is that one of them ends up rotatable but not switchable off, or impossible
 * to test. A person cannot tell which of the two they are looking at anyway
 * unless the wording says so, which is what the title and blurb are for.
 */
const ChannelCard = ({ channel, title, blurb, id, topic, icon, extra }: {
  channel: 'feed' | 'tracking'
  title: string
  blurb: string
  id: string
  topic: string | null
  icon?: string
  extra?: any
}) => (
  <Card title={title} icon={icon} className="mb-4">
    <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">{blurb}</p>
    {topic ? (
      <div class="flex gap-2 mb-3">
        <input
          type="text"
          readonly
          value={topic}
          id={id}
          class="flex-1 min-w-0 bg-gray-50 dark:bg-gray-900/40 border border-gray-200 dark:border-gray-600 rounded-xl px-3 py-2.5 text-xs font-mono"
        />
        <button
          type="button"
          onclick={`copyTopic('${id}')`}
          class="px-3 py-2.5 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-xs font-semibold"
        >
          Copy
        </button>
      </div>
    ) : (
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
        No {channel === 'feed' ? 'feed' : 'tracking'} topic yet. Generate one, then subscribe to it in the ntfy app
        on your phone.
      </p>
    )}

    <div class="flex flex-wrap gap-2">
      <form method="post" action="/settings/channel">
        <input type="hidden" name="channel" value={channel} />
        <input type="hidden" name="action" value="rotate" />
        <Btn tone="primary">{topic ? '🎲 New topic' : '🎲 Generate topic'}</Btn>
      </form>
      <form method="post" action="/settings/notifications/test">
        <input type="hidden" name="channel" value={channel} />
        <Btn>Send a test</Btn>
      </form>
      {topic && (
        <form method="post" action="/settings/channel">
          <input type="hidden" name="channel" value={channel} />
          <input type="hidden" name="action" value="off" />
          <Btn tone="danger">Turn off</Btn>
        </form>
      )}
    </div>
    {extra ? <div class="mt-3">{extra}</div> : null}
  </Card>
)

/** One person's channel in the admin list. Labelled, because "which of the two
 *  is this?" is the exact question the second channel exists to raise. */
const ChannelRow = (userId: string, channel: 'feed' | 'tracking', badge: string, topic: string | null) => (
  <div class="flex flex-wrap items-center gap-2 mt-1">
    <span class="text-[11px] w-4 text-center" title={channel === 'feed' ? 'money & chat' : 'W.A.Y tracking'}>{badge}</span>
    <span class="flex-1 min-w-0 font-mono text-[11px] text-gray-500 dark:text-gray-400 truncate">
      {topic || 'no topic'}
    </span>
    <form method="post" action={`/settings/channel/${userId}`}>
      <input type="hidden" name="channel" value={channel} />
      <input type="hidden" name="action" value="rotate" />
      <button type="submit" class="px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-[11px] font-semibold">
        🎲
      </button>
    </form>
    {topic && (
      <form method="post" action={`/settings/channel/${userId}`}>
        <input type="hidden" name="channel" value={channel} />
        <input type="hidden" name="action" value="off" />
        <button type="submit" class="px-2 py-1 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-[11px] font-semibold">
          ✕
        </button>
      </form>
    )}
  </div>
)

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
  const withFeed = channels.filter((ch) => (ch.ntfy_topic || '').trim()).length
  const withTracking = channels.filter((ch) => (ch.way_topic || '').trim()).length
  const legacyServer = (await getHomeSetting(c.env.HOME_DB, 'ntfy_server')) || ''
  const quiet = await quietWindow(c.env, user.username)
  const following = isAdmin ? await wayFollowing(c.env) : new Map<string, Following>()
  // People the grid has events for, but whose tracking channel is missing —
  // the exact shape of "she was subscribed and heard nothing".
  const unreachable = isAdmin
    ? channels.filter((ch) => following.has(ch.username.toLowerCase()) && !(ch.way_topic || '').trim())
    : []

  return c.html(
    <Layout title="Settings" user={user} activeTab="settings">
      <div class="max-w-lg mx-auto">
        <h2 class="flex items-center gap-2 text-xl font-bold mb-1">
          <span class="accent-mark flex"><Icon name="sliders" className="w-5 h-5" /></span>Settings
        </h2>
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
          <Card title="Name & password" icon="lock" className="mb-4">
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

          {/* ── Install to the home screen (PWA) ──
              Chrome/Brave on Android install it from the manifest; this card
              only makes it discoverable, and the button appears only when the
              browser actually says the app is installable
              (`beforeinstallprompt`), so it can never promise something the
              platform will refuse. */}
          <Card title="Install on your phone" icon="phone" className="mb-4">
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
              Add Home to your home screen and it opens full screen with its own icon —
              no browser bars, and the shell still loads on a weak connection.
            </p>
            <div id="install-app-card">
              <button id="install-app" class="px-4 py-2 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm font-semibold">
                Install Home
              </button>
            </div>
            <p id="install-manual" class="text-[11px] text-gray-400 dark:text-gray-500">
              Or use your browser menu: ⋮ → “Install app” / “Add to Home screen”.
            </p>
            <p id="install-ios" class="hidden text-[11px] text-gray-400 dark:text-gray-500">
              On iPhone / iPad: Share → “Add to Home Screen”.
            </p>
            <p id="install-done" class="hidden text-[11px] text-green-600 dark:text-green-400">
              ✓ Installed — open it from your home screen.
            </p>
          </Card>
        </Section>

        {/* ── NOTIFICATIONS (two channels: the feed, and tracking) ── */}
        <Section
          title="Notifications"
          subtitle="Two topics per person: one for what the household spends, one for where people are. Subscribe to both on your phone."
        >
          {ChannelCard({
            channel: 'feed',
            title: 'Money & chat feed',
            icon: 'receipt',
            blurb: 'Sompitra pushes here: expenses, income and Kiné, in exactly the wording the chat shows — including the ones you recorded yourself. Nothing filters this one.',
            id: 'my-topic',
            topic: mine?.ntfy_topic ?? null,
          })}

          {ChannelCard({
            channel: 'tracking',
            title: 'W.A.Y tracking',
            icon: 'pin',
            blurb: 'Arrivals, departures, movement and chat messages. W.A.Y alone decides which of those reach you: who you follow, and which activities, in its own notification grid. Nobody is notified about their own events, and quiet hours apply only here.',
            id: 'my-way-topic',
            topic: mine?.way_topic ?? null,
            extra: (
              <div>
                <a href="/way/" class="text-[11px] text-green-600 dark:text-green-400 font-semibold">
                  Open W.A.Y's notification grid →
                </a>
                {quiet && (
                  <p class={`text-[11px] mt-1 ${quiet.active ? 'text-orange-600 dark:text-orange-400 font-semibold' : 'text-gray-400 dark:text-gray-500'}`}>
                    Quiet hours {clockHour(quiet.start)}–{clockHour(quiet.end)} (household time).
                    {quiet.active
                      ? ' They are ON right now — only chat messages reach you until they end.'
                      : ' Inside them, only chat messages reach you.'}
                  </p>
                )}
              </div>
            ),
          })}

          <p class="text-[11px] text-gray-400 dark:text-gray-500 mb-4">
            Server: <span class="font-mono">{server || '— not set —'}</span> · making a new topic stops the old one
            immediately, so remember to update your phone.
          </p>

          <script
            dangerouslySetInnerHTML={{
              __html: `
                function copyTopic(id) {
                  var el = document.getElementById(id);
                  if (!el) return;
                  el.select();
                  try { navigator.clipboard.writeText(el.value); } catch (e) { document.execCommand('copy'); }
                }
              `,
            }}
          />

          {isAdmin ? (
            <Card title="Everyone in the household" icon="people" className="mb-4">
              <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
                {withFeed} of {channels.length} {channels.length === 1 ? 'person has' : 'people have'} a feed topic,{' '}
                {withTracking} a tracking one.
              </p>
              {unreachable.length > 0 && (
                <p class="mb-3 p-2.5 rounded-xl bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 text-[12px] text-orange-700 dark:text-orange-300">
                  ⚠ {unreachable.map((ch) => ch.display_name || ch.username).join(', ')}:{' '}
                  W.A.Y has activity to send them but no tracking topic, so none of it arrives.
                  Generate one below, then subscribe the phone to it.
                </p>
              )}
              <div class="space-y-2 mb-4">
                {channels.map((ch) => {
                  const follows = following.get(ch.username.toLowerCase())
                  const blind = !!follows && !(ch.way_topic || '').trim()
                  return (
                    <div class="p-2.5 rounded-xl bg-gray-50 dark:bg-gray-900/40">
                      <div class="text-sm font-semibold truncate mb-1.5">{ch.display_name || ch.username}</div>
                      {ChannelRow(ch.id, 'feed', '💬', ch.ntfy_topic)}
                      {ChannelRow(ch.id, 'tracking', '📍', ch.way_topic)}
                      {follows ? (
                        <p class="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">
                          W.A.Y has {follows.events} {follows.events === 1 ? 'event' : 'events'} for them about{' '}
                          {follows.sources.join(', ')} · quiet {clockHour(follows.quiet.start)}–{clockHour(follows.quiet.end)}
                          {blind && (
                            <span class="block text-orange-600 dark:text-orange-400 font-semibold">
                              ⚠ no tracking topic — none of those reach them.
                            </span>
                          )}
                        </p>
                      ) : null}
                    </div>
                  )
                })}
              </div>
              <form method="post" action="/settings/adopt-way" class="mb-2">
                <Btn>Adopt W.A.Y's tracking topics</Btn>
              </form>
              <p class="text-[11px] text-gray-400 dark:text-gray-500">
                Promotes the topics that already exist in W.A.Y into the tracking channel, so a phone that is
                already following one keeps working. It never overwrites a channel someone has already been given.
              </p>
            </Card>
          ) : null}

          {isAdmin ? (
            <Card title="ntfy server" icon="server" className="mb-4">
              <p class="text-xs text-gray-500 dark:text-gray-400 mb-3">
                Shared by every module and every person. Leave it empty and the deployment's own{' '}
                <span class="font-mono">NTFY_URL</span> is used instead; when that is empty too, push
                notifications are off entirely.
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
        <Section title="Sompitra" subtitle="Budget, Kiné, debts, credits and stock."
          icon="receipt" accent={HOME_TABS[1].color}>
          <Card title="Categories, accounts & access" icon="folder" className="mb-4">
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
            <Card title="People & Access" icon="people" className="mb-4">
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
        <Section title="W.A.Y" subtitle="Tracking, geofences, devices and the household chat."
          icon="pin" accent={HOME_TABS[4].color}>
          <Card title="Tracking settings" icon="pin" className="mb-4">
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
        <Section title="Laoka" subtitle="The weekly dinner planner and shopping list."
          icon="bowl" accent={HOME_TABS[3].color}>
          <Card title="Meal plan settings" icon="bowl" className="mb-4">
            <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
              Group icons, weeks and the shopping list are managed inside Laoka itself.
            </p>
            <a href="/laoka/" class="inline-block px-4 py-2 rounded-xl bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-semibold">
              Open Laoka →
            </a>
          </Card>
        </Section>
      </div>

      {/* The install card's behaviour. Kept as one small script here rather
          than in the shared chrome: only this page has the card, and the
          chrome must stay free of page-specific JS. */}
      <script dangerouslySetInnerHTML={{ __html: `
        (function () {
          var card = document.getElementById('install-app-card');
          var btn = document.getElementById('install-app');
          var manual = document.getElementById('install-manual');
          var ios = document.getElementById('install-ios');
          var done = document.getElementById('install-done');
          if (!card || !btn) return;

          var installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
          var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
          function show(el) { if (el) el.classList.remove('hidden'); }
          function hide(el) { if (el) el.classList.add('hidden'); }

          if (installed) { hide(manual); hide(ios); show(done); return; }
          if (isIOS) { hide(manual); show(ios); }

          var deferred = null;
          window.addEventListener('beforeinstallprompt', function (e) {
            e.preventDefault();
            deferred = e;
            hide(manual); hide(ios);
            card.classList.add('available');   // CSS: display:block
          });
          window.addEventListener('appinstalled', function () {
            deferred = null;
            card.classList.remove('available');
            hide(manual); hide(ios);
            show(done);
          });
          btn.addEventListener('click', function () {
            if (!deferred) return;
            var p = deferred;
            deferred = null;
            p.prompt();
            p.userChoice.then(function () { card.classList.remove('available'); });
          });
        })();
      `}} />
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
  const body = await c.req.parseBody()
  const channel = channelOf(body)
  const channels = await listNtfyChannels(c.env.HOME_DB)
  const mine = channels.find((ch) => ch.id === home.id)
  const topic = channel === 'tracking' ? mine?.way_topic : mine?.ntfy_topic
  if (!topic) return c.redirect('/settings?err=no_channel')
  const who = user.display_name || user.username
  // The test says WHICH channel answered. Two topics on one phone means "a test
  // arrived" is no longer enough information to diagnose anything.
  const result = channel === 'tracking'
    ? await pushNtfyTo(c.env, topic, 'Home test', `${who} · tracking channel`, 'blue')
    : await pushNtfyTo(c.env, topic, 'Home test', `${who} · money & chat feed`, 'green')
  // Report what the SERVER answered, not that we tried. "Sent" over a push the
  // server refused is the one answer this button must never give: it is the
  // difference between a wrong topic on the phone and an ntfy server that wants
  // a token, and only this field tells them apart.
  const where = channel === 'tracking' ? 'tracking topic' : 'feed topic'
  return c.redirect(result.ok
    ? `/settings?ok=${encodeURIComponent(`Test accepted for your ${where} — ${result.detail}`)}`
    : `/settings?err=${encodeURIComponent(`Test NOT sent — ${result.detail}`)}`)
})

/** Which of the two channels a form meant. Defaults to the feed, which is what
 *  every form sent before there were two. */
function channelOf(body: Record<string, unknown>): 'feed' | 'tracking' {
  return String(body.channel || 'feed') === 'tracking' ? 'tracking' : 'feed'
}

/**
 * Rotate/clear one channel for one person. Shared by the self-service route
 * and the admin one so the two can never disagree about what "off" means.
 *
 * Returns false when there is no such person, because the writes are plain
 * UPDATEs: without this, a POST naming an id that does not exist would answer
 * "updated" having changed nothing at all. The admin list happens to post
 * home-db ids (the buttons are rendered from those rows), so a mismatch here
 * means a stale page or a hand-made request — both worth reporting.
 */
async function applyChannelAction(
  env: Env,
  userId: string,
  channel: 'feed' | 'tracking',
  action: string
): Promise<boolean> {
  const exists = await env.HOME_DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first<{ id: string }>()
  if (!exists) return false
  if (channel === 'tracking') {
    if (action === 'off') await clearWayTopic(env, userId)
    else await setWayTopic(env, userId)
    return true
  }
  if (action === 'off') await clearNtfyTopic(env.HOME_DB, userId)
  else await setNtfyTopic(env.HOME_DB, userId)
  return true
}

// ─── POST /settings/channel (my own channel) ───────────────
settings.post('/channel', async (c) => {
  const user = c.get('user')
  const home = await findHomeUserByName(c.env.HOME_DB, user.username)
  if (!home) return c.redirect('/settings?err=bad_person')
  const body = await c.req.parseBody()
  const channel = channelOf(body)
  const changed = await applyChannelAction(c.env, home.id, channel, String(body.action || 'rotate'))
  if (!changed) return c.redirect('/settings?err=bad_person')
  // The FleetDO caches channels, so tell it to re-read them or a rotation
  // looks like it silently failed for W.A.Y activity (Sompitra reads live).
  await reloadWayNotifications(c.env)
  return c.redirect(`/settings?ok=${encodeURIComponent(channel === 'tracking' ? 'Tracking topic updated' : 'Feed topic updated')}`)
})

// ─── POST /settings/channel/:id (admin, anyone) ────────────
settings.post('/channel/:id', async (c) => {
  const user = c.get('user')
  if (user.is_admin !== 1) return c.redirect('/settings')
  const body = await c.req.parseBody()
  const channel = channelOf(body)
  const changed = await applyChannelAction(c.env, c.req.param('id'), channel, String(body.action || 'rotate'))
  if (!changed) return c.redirect('/settings?err=bad_person')
  await reloadWayNotifications(c.env)
  return c.redirect(`/settings?ok=${encodeURIComponent(channel === 'tracking' ? 'Tracking topic updated' : 'Feed topic updated')}`)
})

// ─── POST /settings/adopt-way (admin) ─────────────────────
settings.post('/adopt-way', async (c) => {
  const user = c.get('user')
  if (user.is_admin !== 1) return c.redirect('/settings')
  const adopted = await adoptWayTopics(c.env)
  await reloadWayNotifications(c.env)
  return c.redirect(`/settings?ok=${encodeURIComponent(adopted === 1 ? 'Adopted 1 tracking topic from W.A.Y' : `Adopted ${adopted} tracking topics from W.A.Y`)}`)
})

export default settings
