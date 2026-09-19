/** @jsxImportSource hono/jsx */
import { Hono } from 'hono'
import { setCookie, getCookie, deleteCookie } from 'hono/cookie'
import { PressFeedbackStyle, PressFeedbackScript } from '../views/feedback'
import { BrandFontLinks } from '../views/app-chrome'
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

// ─── GET /login ──────────────────────────────────────────────
auth.get('/login', (c) => {
  const err = c.req.query('err')
  return c.html(
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Login – Home</title>
        {/* The sign-in screen is the app's first impression; it loads the same
            brand typeface as everything behind it. */}
        <BrandFontLinks />
        <script src="https://cdn.tailwindcss.com" />
        <script dangerouslySetInnerHTML={{ __html: `
          if (localStorage.getItem('theme') === 'dark' ||
              (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            document.documentElement.classList.add('dark')
          }
        `}} />
        <PressFeedbackStyle />
      </head>
      <body class="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 flex items-center justify-center p-4">
        <div class="w-full max-w-sm">
          {/* Logo */}
          <div class="text-center mb-8">
            <img src="/logo-1024.png" alt="" class="w-20 h-20 mx-auto mb-3 rounded-2xl" />
            <h1 class="text-3xl font-bold text-white">Home</h1>
            <p class="text-gray-400 text-sm mt-1">One app for the whole household</p>
          </div>

          {/* Login card */}
          <div class="bg-gray-800 rounded-2xl shadow-xl p-6 border border-gray-700">
            <h2 class="text-lg font-semibold text-white mb-5 text-center">Sign in</h2>

            {err && (
              <div class="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-300 text-sm text-center">
                {err === 'bad_credentials' ? '❌ Wrong username or password.'
                  : err === 'locked' ? '⏳ Too many attempts. Wait a bit and try again.'
                  : err === 'inactive' ? '🚫 This account has been deactivated.'
                  : err === 'no_pepper' ? '⚠️ Server is not configured for sign-in yet.'
                  : '❌ Something went wrong.'}
              </div>
            )}

            <form method="post" action="/login" class="space-y-4">
              <div>
                <label class="block text-sm text-gray-400 mb-1">Username</label>
                <input
                  type="text"
                  name="username"
                  autocomplete="username"
                  autocapitalize="none"
                  spellcheck={false}
                  maxlength={24}
                  placeholder="e.g. maxx"
                  required
                  class="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-green-500"
                />
              </div>

              <div>
                <label class="block text-sm text-gray-400 mb-1">Password</label>
                <input
                  type="password"
                  name="password"
                  autocomplete="current-password"
                  placeholder="••••••••"
                  required
                  class="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-green-500"
                />
              </div>

              <button type="submit"
                class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl transition-colors">
                Login →
              </button>
            </form>
          </div>

          <p class="text-center text-xs text-gray-600 mt-4">Home v2.0 · Sompitra & W.A.Y & Laoka</p>
        </div>
        <PressFeedbackScript />
      </body>
    </html>
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
    <html lang="en" class="h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Claim Home</title>
        <BrandFontLinks />
        <script src="https://cdn.tailwindcss.com" />
        <PressFeedbackStyle />
      </head>
      <body class="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 flex items-center justify-center p-4">
        <div class="w-full max-w-sm">
          <div class="text-center mb-8">
            <img src="/logo-1024.png" alt="" class="w-20 h-20 mx-auto mb-3 rounded-2xl" />
            <h1 class="text-2xl font-bold text-white">Claim this Home</h1>
            <p class="text-gray-400 text-sm mt-1">Nobody has signed up yet — this account becomes the admin.</p>
          </div>
          <div class="bg-gray-800 rounded-2xl shadow-xl p-6 border border-gray-700">
            {err && <div class="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-300 text-sm text-center">
              {err === 'taken' ? '❌ Already claimed.' : err === 'bad_token' ? '❌ Wrong setup token.' : '❌ Something went wrong.'}
            </div>}
            <form method="post" action="/bootstrap" class="space-y-4">
              <div>
                <label class="block text-sm text-gray-400 mb-1">Username</label>
                <input type="text" name="username" required maxlength={24} autocapitalize="none" spellcheck={false} placeholder="e.g. maxx"
                  class="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-green-500" />
              </div>
              <div>
                <label class="block text-sm text-gray-400 mb-1">Display name</label>
                <input type="text" name="display_name" maxlength={40} placeholder="e.g. MaxX"
                  class="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-green-500" />
              </div>
              <div>
                <label class="block text-sm text-gray-400 mb-1">Password (min 8)</label>
                <input type="password" name="password" required minlength={8} autocomplete="new-password"
                  class="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-green-500" />
              </div>
              {setupTokenRequired && (
                <div>
                  <label class="block text-sm text-gray-400 mb-1">Setup token</label>
                  <input type="password" name="setup_token" required
                    class="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-green-500" />
                </div>
              )}
              <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl transition-colors">
                Claim Home →
              </button>
            </form>
          </div>
        </div>
        <PressFeedbackScript />
      </body>
    </html>
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
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Change Password – Home</title>
        <BrandFontLinks />
        <script src="https://cdn.tailwindcss.com" />
        <PressFeedbackStyle />
      </head>
      <body class="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 flex items-center justify-center p-4">
        <div class="w-full max-w-sm">
          <div class="text-center mb-8">
            <div class="text-5xl mb-2">🔐</div>
            <h1 class="text-2xl font-bold text-white">Change Password</h1>
            <p class="text-gray-400 text-sm mt-1">Applies to the whole Home app</p>
          </div>
          <div class="bg-gray-800 rounded-2xl shadow-xl p-6 border border-gray-700">
            {ok && <div class="mb-4 p-3 bg-green-900/50 border border-green-700 rounded-lg text-green-300 text-sm text-center">✅ Password changed.</div>}
            {err && <div class="mb-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-red-300 text-sm text-center">
              {err === 'bad_current' ? '❌ Current password is wrong.' : err === 'weak' ? '❌ New password must be at least 8 characters.' : '❌ Something went wrong.'}
            </div>}
            <form method="post" action="/change-password" class="space-y-4">
              <div>
                <label class="block text-sm text-gray-400 mb-1">Current password</label>
                <input type="password" name="current" autocomplete="current-password" required
                  class="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-green-500" />
              </div>
              <div>
                <label class="block text-sm text-gray-400 mb-1">New password (min 8)</label>
                <input type="password" name="next" autocomplete="new-password" minlength={8} required
                  class="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-green-500" />
              </div>
              <div>
                <label class="block text-sm text-gray-400 mb-1">Confirm new password</label>
                <input type="password" name="confirm" autocomplete="new-password" minlength={8} required
                  class="w-full bg-gray-700 border border-gray-600 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-green-500" />
              </div>
              <button type="submit"
                class="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl transition-colors">
                Save Password →
              </button>
            </form>
          </div>
          <p class="text-center mt-4"><a href="/" class="text-sm text-gray-400 hover:text-white">← Back to Home</a></p>
        </div>
        <script dangerouslySetInnerHTML={{ __html: `
          document.querySelector('form').addEventListener('submit', function(e) {
            if (this.next.value !== this.confirm.value) { e.preventDefault(); alert('New passwords do not match!'); }
          });
        `}} />
        <PressFeedbackScript />
      </body>
    </html>
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
