/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { PressFeedbackStyle, PressFeedbackScript } from '../views/feedback'
import { BrandFontLinks, CHROME_CSS, Icon } from '../views/app-chrome'
import type { FC } from 'hono/jsx'
import {
  HOME_COOKIE, SOMPITRA_COOKIE, WAY_COOKIE, LAOKA_COOKIE,
  HOME_SESSION_DAYS,
  findHomeUserByName, verifyPassword, createHomeSession, destroyHomeSession,
  getHomeUserFromCookie, setHomePassword, createHomeUser,
  mintModuleCookies, pepperConfigured, tooManyAttempts, noteAttempt, clearAttempts,
  isSecureRequest, clearCookieValue, sha256Hex, validPassword,
} from '../identity'
import type { Env } from '../env'

const auth = new Hono<{ Bindings: Env }>()

const MAX_AGE_HOME = HOME_SESSION_DAYS * 24 * 60 * 60

// ─── The front door ──────────────────────────────────────────
// Sign-in, first-run claim and change-password are the only screens a person
// sees BEFORE they are inside the app, and they used to be a different app:
// a permanent dark gradient card in the system typeface (the one page that
// never loaded the brand `body` rule), with ❌/⏳/🚫/🔐 glued to every message.
//
// One shell now, wearing the app's own tokens (see CHROME_CSS): the same
// paper, the same sheets, the same type scale, and the module marks along the
// bottom so the door says what is behind it. It follows the theme like every
// other screen instead of forcing dark.
const ROOMS = [
  { icon: 'receipt', label: 'Sompitra', color: '#0d9488' },
  { icon: 'pin',     label: 'WAY',      color: '#0284c7' },
  { icon: 'bowl',    label: 'Laoka',    color: '#ea580c' },
  { icon: 'chat',    label: 'Chat',     color: '#7c3aed' },
]

/** One message per failure, in the app's own voice: what happened, then what
    to do about it. Matches the `?err=` values the POST handlers redirect with. */
function authMessage(err: string): string {
  if (err === 'bad_credentials') return 'That username and password do not match. Check the spelling, then try again.'
  if (err === 'locked') return 'Too many tries from this device. Wait a minute, then try again.'
  if (err === 'inactive') return 'That account is switched off. An admin can turn it back on.'
  if (err === 'no_pepper') return 'This server cannot check passwords yet: the sign-in pepper is not set.'
  if (err === 'taken') return 'This Home already has an owner.'
  if (err === 'bad_token') return 'That setup token is not the one this server expects.'
  if (err === 'bad_current') return 'That is not your current password.'
  if (err === 'weak') return 'Use at least 8 characters.'
  return 'Something went wrong. Try again.'
}

const AuthAlert: FC<{ tone: 'bad' | 'good'; message: string }> = ({ tone, message }) => (
  <div
    role="status"
    class={`mb-4 rounded-xl border px-3.5 py-2.5 text-[13px] leading-snug ${tone === 'good'
      ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/25 dark:text-green-300'
      : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/25 dark:text-red-300'}`}
  >{message}</div>
)

/** The label + input pair, in the app's tokens rather than the dark-mode greys
    the old page hard-coded. Every field on all three screens is one of these. */
const Field: FC<{ label: string; name: string; type?: string; placeholder?: string; autocomplete?: string
  required?: boolean, minlength?: number, maxlength?: number
  autocapitalize?: 'none' | 'off' | 'on' | 'sentences' | 'words' | 'characters' }> = ({
  label, name, type = 'text', placeholder, autocomplete, required, minlength, maxlength, autocapitalize,
}) => (
  <div>
    <label for={name} class="t-label block mb-1.5">{label}</label>
    <input
      id={name}
      type={type}
      name={name}
      placeholder={placeholder}
      autocomplete={autocomplete}
      autocapitalize={autocapitalize}
      spellcheck={false}
      required={required}
      minlength={minlength}
      maxlength={maxlength}
      class="w-full rounded-xl border px-3.5 py-3 text-[15px]"
      style={{ backgroundColor: 'var(--paper)', borderColor: 'var(--rule)', color: 'var(--ink)' }}
    />
  </div>
)

const AuthShell: FC<{ title: string; heading: string; blurb: string; children?: any }> = ({ title, heading, blurb, children }) => (
  <html lang="en" class="h-full">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
      <title>{title} – Home</title>
      {/* The sign-in screen is the app's first impression: same brand typeface,
          same tokens, same dark-mode switch as everything behind it. */}
      <BrandFontLinks />
      <script src="https://cdn.tailwindcss.com" />
      <script dangerouslySetInnerHTML={{ __html: `
        if (localStorage.getItem('theme') === 'dark' ||
            (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
          document.documentElement.classList.add('dark')
        }
      `}} />
      <PressFeedbackStyle />
      {/* CHROME_CSS carries the tokens, the type scale and the brand font's
          body rule — the front door has to land on the same table as the app. */}
      <style dangerouslySetInnerHTML={{ __html: CHROME_CSS }} />
    </head>
    <body style={{ '--accent': '#16a34a', '--accent-ink': '#166534' }}
      class="min-h-screen flex flex-col items-center justify-center p-4">
      <main class="w-full max-w-[21rem] sm:max-w-sm">
        <div class="flex flex-col items-center text-center mb-6">
          {/* 192px mark, not the 982KB logo-1024.png the old page shipped for
              an 80px avatar — the first screen of the app was its slowest. */}
          <img src="/icons/icon-192.png" alt="" width={88} height={88}
            class="w-[88px] h-[88px] rounded-[22px] ring-1 ring-black/5 dark:ring-white/10" />
          <h1 class="mt-3 text-[30px] font-extrabold tracking-[-.04em] text-green-600 dark:text-green-400">{heading}</h1>
          <p class="t-micro mt-1 max-w-[18rem]">{blurb}</p>
        </div>

        <div class="card card-lg rise p-5">{children}</div>

        {/* What is behind this door, in the modules' own colours. */}
        <div class="mt-6 flex items-center justify-center gap-4 flex-wrap">
          {ROOMS.map(room => (
            <span key={room.label} class="flex items-center gap-1.5" style={{ color: room.color }}>
              <Icon name={room.icon} className="w-[15px] h-[15px]" />
              <span class="text-[11.5px] font-semibold">{room.label}</span>
            </span>
          ))}
        </div>
        <p class="t-micro text-center mt-3">Home v2.0</p>
      </main>
      <PressFeedbackScript />
    </body>
  </html>
)

/** The one filled control on the door: the app's own green, and it says what
    happens when you press it (“Login →” named the mechanism, not the outcome). */
const AuthButton: FC<{ children?: any }> = ({ children }) => (
  <button type="submit"
    class="w-full py-3 rounded-xl text-[15px] font-semibold text-white transition-colors"
    style={{ backgroundColor: 'var(--accent-ink)' }}>
    {children}
  </button>
)

// ─── GET /login ──────────────────────────────────────────────
auth.get('/login', (c) => {
  const err = c.req.query('err')
  return c.html(
    <AuthShell title="Sign in" heading="Home"
      blurb="One sign-in for the whole household: the money, the map, the meals and the family room.">
      <form method="post" action="/login" class="space-y-4">
        {err && <AuthAlert tone="bad" message={authMessage(err)} />}
        <Field label="Username" name="username" autocomplete="username" autocapitalize="none"
          maxlength={24} placeholder="e.g. maxx" required />
        <Field label="Password" name="password" type="password" autocomplete="current-password" required />
        <AuthButton>Sign in</AuthButton>
      </form>
    </AuthShell>
  )
})

// ─── POST /login ─────────────────────────────────────────────
// ONE credential check against the central home-db. On success the person
// is provisioned into every module database they don't exist in yet and
// every module's native session cookie is minted — one login, all apps.
auth.post('/login', async (c) => {
  const body = await c.req.parseBody()
  const username = String(body.username || '').trim()
  const password = String(body.password || '')

  // Throttle guessing per client IP.
  const ip = c.req.header('cf-connecting-ip') || (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'
  const gateKey = 'login:' + ip
  try {
    if (await tooManyAttempts(c.env.HOME_DB, gateKey)) return c.redirect('/login?err=locked')
  } catch { /* rate-limit table hiccup must not block login */ }

  if (!pepperConfigured(c.env)) return c.redirect('/login?err=no_pepper')

  const user = await findHomeUserByName(c.env.HOME_DB, username).catch(() => null)
  const okCreds = user && user.is_active === 1 && (await verifyPassword(c.env, password, user))

  if (!okCreds || !user) {
    try { await noteAttempt(c.env.HOME_DB, gateKey) } catch { /* ignore */ }
    return c.redirect('/login?err=bad_credentials')
  }

  try { await clearAttempts(c.env.HOME_DB, gateKey) } catch { /* ignore */ }

  // Central session.
  const token = await createHomeSession(c.env.HOME_DB, user.id)
  await c.env.HOME_DB.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?').bind(user.id).run()

  const secure = isSecureRequest(c.req.url)
  setCookie(c, HOME_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'Lax', secure,
    maxAge: MAX_AGE_HOME,
  })

  // Provision + mint every module session (best-effort, never blocks login).
  try {
    const cookies = await mintModuleCookies(c.env, user, secure, password)
    for (const cookie of cookies) c.header('Set-Cookie', cookie.value, { append: true })
  } catch { /* modules repair themselves on first 401 anyway */ }

  return c.redirect('/')
})

// ─── GET /bootstrap — one-time first-admin claim ────────────
// There is no signup: an admin creates every account. This route exists
// exactly once — when home-db has NO users. The first person to open it
// becomes the admin, then it disappears forever (Laoka's "claim the app"
// pattern). If SETUP_TOKEN is configured, it must be supplied.
auth.get('/bootstrap', async (c) => {
  const count = await c.env.HOME_DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  if ((count?.n ?? 0) > 0) return c.redirect('/login')

  const setupTokenRequired = String(c.env.SETUP_TOKEN || '').length > 0
  const err = c.req.query('err')
  return c.html(
    <AuthShell title="Claim Home" heading="Claim this Home"
      blurb="Nobody has signed up yet. The account you create now becomes the admin.">
      <form method="post" action="/bootstrap" class="space-y-4">
        {err && <AuthAlert tone="bad" message={authMessage(err)} />}
        <Field label="Username" name="username" autocapitalize="none" maxlength={24} placeholder="e.g. maxx" required />
        <Field label="Display name" name="display_name" maxlength={40} placeholder="e.g. MaxX" />
        <Field label="Password (min 8)" name="password" type="password" autocomplete="new-password" minlength={8} required />
        {setupTokenRequired && <Field label="Setup token" name="setup_token" type="password" required />}
        <AuthButton>Claim Home</AuthButton>
      </form>
    </AuthShell>
  )
})

// ─── POST /bootstrap ─────────────────────────────────────────
auth.post('/bootstrap', async (c) => {
  const count = await c.env.HOME_DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  if ((count?.n ?? 0) > 0) return c.redirect('/login?err=taken')

  const required = String(c.env.SETUP_TOKEN || '').length > 0
  if (required && String((await c.req.parseBody()).setup_token || '') !== String(c.env.SETUP_TOKEN)) {
    return c.redirect('/bootstrap?err=bad_token')
  }

  const body = await c.req.parseBody()
  const res = await createHomeUser(c.env, {
    username: String(body.username || '').trim(),
    password: String(body.password || ''),
    displayName: String(body.display_name || '').trim() || undefined,
    role: 'admin',
  })
  if (!res.ok) return c.redirect('/bootstrap?err=taken')

  // Log the new admin straight in (module cookies are minted on first visit
  // by the repair paths — the password is not in hand on this code path).
  const token = await createHomeSession(c.env.HOME_DB, res.user.id)
  const secure = isSecureRequest(c.req.url)
  setCookie(c, HOME_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'Lax', secure, maxAge: MAX_AGE_HOME })
  return c.redirect('/')
})

// ─── GET /logout ─────────────────────────────────────────────
// Ends the central session AND every module session that can be reached.
auth.get('/logout', async (c) => {
  const secure = isSecureRequest(c.req.url)

  const homeToken = getCookie(c, HOME_COOKIE)
  await destroyHomeSession(c.env.HOME_DB, homeToken).catch(() => {})

  // Best-effort: also kill the D1-backed module sessions.
  const sompitraToken = getCookie(c, SOMPITRA_COOKIE)
  if (sompitraToken) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(sompitraToken).run().catch(() => {})
  }
  const laokaToken = getCookie(c, LAOKA_COOKIE)
  if (laokaToken) {
    const hash = await sha256Hex(laokaToken).catch(() => null)
    if (hash) await c.env.LAOKA_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run().catch(() => {})
  }
  // W.A.Y's token is stateless — expiring the cookie is all there is.

  deleteCookie(c, HOME_COOKIE, { path: '/' })
  c.header('Set-Cookie', clearCookieValue(SOMPITRA_COOKIE, secure), { append: true })
  c.header('Set-Cookie', clearCookieValue(WAY_COOKIE, secure), { append: true })
  c.header('Set-Cookie', clearCookieValue(LAOKA_COOKIE, secure), { append: true })

  return c.redirect('/login')
})

// ─── GET /change-password ────────────────────────────────────
auth.get('/change-password', (c) => {
  const err = c.req.query('err')
  const ok = c.req.query('ok')
  return c.html(
    <AuthShell title="Change password" heading="Change password"
      blurb="Applies to the whole Home app: every module signs in with it.">
      {/* The mismatch guard rides on the form's own submit handler instead of a
          script that hunts for `document.querySelector('form')` — the tap
          feedback in feedback.tsx runs in the bubble phase, i.e. AFTER this, so
          a cancelled submit still leaves no pending state behind it. */}
      <form method="post" action="/change-password" class="space-y-4"
        onsubmit="if (this.next.value !== this.confirm.value) { alert('The two new passwords do not match.'); return false } return true">
        {ok && <AuthAlert tone="good" message="Password changed." />}
        {err && <AuthAlert tone="bad" message={authMessage(err)} />}
        <Field label="Current password" name="current" type="password" autocomplete="current-password" required />
        <Field label="New password (min 8)" name="next" type="password" autocomplete="new-password" minlength={8} required />
        <Field label="Confirm new password" name="confirm" type="password" autocomplete="new-password" minlength={8} required />
        <AuthButton>Save password</AuthButton>
      </form>
      <p class="mt-4 text-center">
        <a href="/" class="t-micro underline decoration-dotted">Back to Home</a>
      </p>
    </AuthShell>
  )
})

// ─── POST /change-password ───────────────────────────────────
auth.post('/change-password', async (c) => {
  const body = await c.req.parseBody()
  const current = String(body.current || '')
  const next = String(body.next || '')

  const homeToken = getCookie(c, HOME_COOKIE)
  const user = await getHomeUserFromCookie(c.env.HOME_DB, homeToken)
  if (!user) return c.redirect('/login')

  const full = await findHomeUserByName(c.env.HOME_DB, user.username)
  if (!full || !(await verifyPassword(c.env, current, full))) return c.redirect('/change-password?err=bad_current')
  if (!validPassword(next)) return c.redirect('/change-password?err=weak')

  const res = await setHomePassword(c.env, user.id, next)
  if (!res.ok) return c.redirect('/change-password?err=weak')

  return c.redirect('/change-password?ok=1')
})

export default auth
