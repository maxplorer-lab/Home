// ─── Home — the family super app ─────────────────────────────────
// One Worker, three modules, ONE login, four databases:
//
//   /            Sompitra — finance suite (Hono JSX, DB = sompitra-db)
//   /way/*       W.A.Y    — GPS tracking (WAY_DB + FLEET_DO)
//   /laoka/*     Laoka    — meal planner (LAOKA_DB + LOBBY)
//   /ws          W.A.Y live feed + chat WebSocket (app-global)
//   /laoka-ws    Laoka realtime fan-out (app-global)
//   /ulogger*    W.A.Y GPS ingest from the μlogger Android app
//
// ONE LOGIN: POST /login checks username + password against the central
// home-db, provisions the person into each module's database (first time
// only) and mints every module's native session cookie — see
// src/identity.ts. Two repair paths keep every module reachable:
//   • module APIs → on a 401 with a live home_session, the module cookie
//     is minted and the request retried once (covers stale cookies and
//     accounts created after this login).
//   • Sompitra pages → its requireAuth middleware does the same
//     (src/lib/middleware.ts).
//
// Logout (GET /logout) destroys the central session and every module
// session that can be reached server-side.
//
// ⚠ ORDERING: the module mounts are registered BEFORE Sompitra's routes —
// Sompitra's sub-apps use `use('*', requireAuth)` catch-all middleware that
// would otherwise swallow /way/* and /laoka/* requests. Registered first,
// the module routes win; Sompitra's specific paths (/login, /budget, …)
// are unaffected.

import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import type { Env } from './env'
import { getHomeUserFromCookie, promoteSession, isSecureRequest, HOME_COOKIE } from './identity'
import type { HomeUser } from './identity'
import { requireAuth } from './lib/middleware'
import { pruneDiag } from './lib/diagnostics'
import { ModuleShell } from './views/shell'

import auth     from './routes/auth'
import admin    from './routes/admin'
import dashboard from './routes/dashboard'
import budget   from './routes/budget'
import kine     from './routes/kine'
import debts    from './routes/debts'
import sales    from './routes/sales'
import categories from './routes/categories'
import settings from './routes/settings'

import { handleWay, handleWayWebSocket, handleWayIngest, flushFleet } from './way/worker'
import { handleLaoka } from './laoka/worker'
import {
  resolveSharePin, readLiveView, pinRateLimited, notePinFailure, noteShareRefusal,
  touchShare, clearPinFailures, validPinShape,
} from './lib/share'

// Hono's c.executionCtx type and workers-types' ExecutionContext disagree
// about `tracing`; only waitUntil is ever used, so cast once here.
const execCtx = (c: { executionCtx: unknown }) => c.executionCtx as { waitUntil(p: Promise<unknown>): void }

export { FleetDO } from './way/worker'
export { Lobby } from './laoka/durable/lobby.js'

const app = new Hono<{ Bindings: Env }>()

// ══ App-global endpoints (registered FIRST) ══════════════════════

// μlogger phones append their own suffixes to the base URL — match the
// whole subtree. Served before static assets via run_worker_first.
app.all('/ulogger', (c) => handleWayIngest(c.req.raw, c.env))
app.all('/ulogger/*', (c) => handleWayIngest(c.req.raw, c.env))

// W.A.Y dashboard WebSocket + chat: gated by WAY's own cookie.
app.all('/ws', (c) => handleWayWebSocket(c.req.raw, c.env))

// Laoka realtime fan-out: routed through Laoka's own entry so its
// cookie auth still guards the DO upgrade (see src/laoka/worker.js).
app.all('/laoka-ws', (c) => handleLaoka(c.req.raw, c.env, execCtx(c)))

// ── shared repair helper: 401 → mint module cookie → retry ──────

async function withRepair(
  request: Request,
  env: Env,
  target: 'sompitra' | 'way' | 'laoka',
  dispatch: (req: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url)
  const res = await dispatch(request)
  if (res.status !== 401) return res

  // 401 with a possible central session → mint the module cookie, retry.
  const homeToken = getCookieFrom(request, 'home_session')
  const homeUser = await getHomeUserFromCookie(env.HOME_DB, homeToken)
  if (!homeUser) return res

  const setCookie = await promoteSession(env, target, homeUser, isSecureRequest(url.origin))
  if (!setCookie) return res

  // Re-send with the fresh module cookie. Cookie headers must be joined
  // with "; " — Headers.append would join with ", ", which cookie parsers
  // cannot read, so the retry would still look signed-out.
  const pair = setCookie.split(';')[0]!
  const prior = request.headers.get('Cookie')
  const retryReq = new Request(url, request)
  retryReq.headers.set('Cookie', prior ? prior + '; ' + pair : pair)
  const retry = await dispatch(retryReq)
  const out = new Response(retry.body, retry) // fresh Response → mutable headers
  // Drop any 401-era clearing cookie, then hand the browser the fresh one.
  out.headers.delete('Set-Cookie')
  out.headers.append('Set-Cookie', setCookie)
  return out
}

// ══ The Chat tab ═══════════════════════════════════════════════
// The family chat is its OWN document under /chat/ — it is not a view of
// W.A.Y any more. The code is W.A.Y's original chat engine (same /ws socket,
// same FleetDO, same reply/reaction rendering), moved out of WAY's dashboard
// so the only chat in the product lives in one place.
app.get('/chat', async (c) => {
  const user = await getHomeUserFromCookie(c.env.HOME_DB, getCookieFrom(c.req.raw, HOME_COOKIE))
  if (!user) return c.redirect('/login')
  return c.html(<ModuleShell kind="chat" displayName={user.display_name || user.username} />)
})
// The chat document itself. run_worker_first sends it through the Worker so
// it is only ever served to a live Home session (like WAY's and Laoka's).
for (const p of ['/chat/', '/chat/index.html']) {
  app.get(p, async (c) => {
    const user = await getHomeUserFromCookie(c.env.HOME_DB, getCookieFrom(c.req.raw, HOME_COOKIE))
    if (!user) return c.redirect('/login')
    return c.env.ASSETS.fetch(new Request(new URL('/chat/index.html', c.req.url), { headers: c.req.raw.headers }))
  })
}

// ══ The public live view (/live) ════════════════════════════════
// The ONE page in this app that an OUTSIDER can open: an admin mints a PIN for
// one device, it lives until the next 00:00 UTC, and whoever holds it watches
// that device drive — no account, no app, nothing to install.
//
// It is the exception to "everything is behind one login", so it is written as
// though every request is hostile:
//   • the document is served with `X-Robots-Tag: noindex` and is linked from
//     nowhere in the product (it exists to be sent to one person);
//   • the viewer gets NO cookie and no session — nothing is minted here, so a
//     viewer can never be mistaken for a household member;
//   • the only data it can reach is ONE device's live state, chosen by the
//     grant's subject, never by anything the viewer sends (src/lib/share.ts);
//   • `no-store` on the state, because a cached location is a location the
//     household cannot un-share by revoking the pin;
//   • every refusal is counted: a wrong pin is rate-limited per caller and the
//     first failure leaves a receipt in the diagnostics ledger, so "somebody is
//     guessing pins" is something the household can find afterwards rather than
//     a line in a log nobody is tailing.
//
// It is served through the Worker (run_worker_first) for the header and for the
// same reason the other module documents are: the edge must never hand out a
// document the Worker has not decided about.
for (const p of ['/live', '/live/', '/live/index.html']) {
  app.get(p, async (c) => {
    const res = await c.env.ASSETS.fetch(
      new Request(new URL('/live/index.html', c.req.url), { headers: c.req.raw.headers })
    )
    const out = new Response(res.body, res) // fresh Response → mutable headers
    out.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet')
    out.headers.set('Referrer-Policy', 'no-referrer')
    return out
  })
}

app.get('/live/api/state', async (c) => {
  const noStore = {
    'Cache-Control': 'no-store, max-age=0',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  } as const
  const ip =
    c.req.header('CF-Connecting-IP') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  const pin = String(c.req.query('pin') || '')

  const fail = (code: string, status: ContentfulStatusCode) => c.json({ ok: false, code }, status, noStore)

  if (await pinRateLimited(c.env, ip)) return fail('rate_limited', 429)

  const resolved = await resolveSharePin(c.env, pin)
  if (!resolved.ok) {
    // A pin that matches a real grant but is past its life is not an attack:
    // it is a relative holding yesterday's link, and it gets its own sentence.
    if (resolved.code === 'bad_pin') await notePinFailure(c.env, ip, pinFailureReason(pin))
    else await noteShareRefusal(c.env, resolved.code, null, ip)
    return resolved.code === 'bad_pin' ? fail('bad_pin', 400) : fail(resolved.code, 410)
  }

  const share = resolved.share
  if (share.kind !== 'way-live') return fail('bad_pin', 400)

  const state = await readLiveView(c.env, share)
  if (!state.ok) return fail('unavailable', 503)
  await touchShare(c.env, share.id)
  // Resolving a pin clears this caller's failures: someone who mistypes twice
  // and then gets it right must not be two steps closer to a lockout tomorrow
  // (an attacker never resolves anything).
  await clearPinFailures(c.env, ip)
  return c.json(state, 200, noStore)
})

// `notePinFailure` writes a slightly different sentence for a value that never
// even looked like a pin; this keeps that distinction at the call site, where
// the raw string is still visible. The shape rule is imported rather than
// restated, so the receipt cannot describe something the resolver did not
// actually reject.
function pinFailureReason(pin: string): 'shape' | 'mismatch' {
  return validPinShape(pin) ? 'mismatch' : 'shape'
}

// ══ W.A.Y under /way ═════════════════════════════════════════════

async function wayApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  // W.A.Y's internal routes are /api/*: strip the /way prefix.
  const innerUrl = new URL(url.pathname.replace(/^\/way/, '') + url.search, url.origin)
  return withRepair(request, env, 'way', (req) => handleWay(new Request(innerUrl, req), env))
}

app.all('/way/api/*', (c) => wayApi(c.req.raw, c.env))

// THE WAY tab: an authenticated shell page that embeds W.A.Y's dashboard
// chromeless — same engine, same chrome, no separate app look.
app.get('/way', (c) => c.redirect('/way/'))
app.get('/way/', async (c) => {
  const user = await getHomeUserFromCookie(c.env.HOME_DB, getCookieFrom(c.req.raw, HOME_COOKIE))
  if (!user) return c.redirect('/login')
  return c.html(<ModuleShell kind="way" displayName={user.display_name || user.username} />)
})
// The chromeless module document, fetched by the shell page. run_worker_first
// sends this path through the Worker so it only ever leaves the server with
// a live Home session — the standalone UI never renders signed-out.
app.get('/way/index.html', async (c) => {
  const user = await getHomeUserFromCookie(c.env.HOME_DB, getCookieFrom(c.req.raw, HOME_COOKIE))
  if (!user) return c.redirect('/login')
  return c.env.ASSETS.fetch(new Request(new URL('/way/index.html', c.req.url), { headers: c.req.raw.headers }))
})
// Its static files (app js/css, sw, manifest) go straight to the edge.
app.get('/way/*', (c) => {
  const rel = c.req.path.replace(/^\/way\//, '') || 'index.html'
  return c.env.ASSETS.fetch(new Request(new URL('/way/' + rel, c.req.url), { headers: c.req.raw.headers }))
})

// ══ Laoka under /laoka ═══════════════════════════════════════════

async function laokaApi(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url)
  // Laoka's internal routes are /api/*: strip the /laoka prefix, then let
  // its own router authenticate, provision-guard and dispatch.
  const innerUrl = new URL(url.pathname.replace(/^\/laoka/, '') + url.search, url.origin)
  const res = await withRepair(request, env, 'laoka', (req) => handleLaoka(new Request(innerUrl, req), env, ctx))
  // Laoka reports "no session" as 200 {user:null} on its public /auth/me;
  // catch that too so a stale laoka cookie still gets repaired.
  if (res.status === 200) {
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json') && url.pathname.endsWith('/api/auth/me')) {
      try {
        // Peek via a clone: the original body must stay consumable when the
        // response passes through untouched.
        const data = (await res.clone().json()) as { user?: unknown }
        if (!data.user) return repairLaoka(request, env, ctx)
      } catch { /* fall through */ }
    }
  }
  return res
}

async function repairLaoka(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url)
  const innerUrl = new URL(url.pathname.replace(/^\/laoka/, '') + url.search, url.origin)
  const homeToken = getCookieFrom(request, 'home_session')
  const homeUser = await getHomeUserFromCookie(env.HOME_DB, homeToken)
  if (!homeUser) return new Response(JSON.stringify({ ok: false, user: null }), { status: 200, headers: { 'content-type': 'application/json' } })

  const setCookie = await promoteSession(env, 'laoka', homeUser, isSecureRequest(url.origin))
  if (!setCookie) return new Response(JSON.stringify({ ok: false, user: null }), { status: 200, headers: { 'content-type': 'application/json' } })

  const pair = setCookie.split(';')[0]!
  const prior = request.headers.get('Cookie')
  const retryReq = new Request(innerUrl, request)
  retryReq.headers.set('Cookie', prior ? prior + '; ' + pair : pair)
  const retry = await handleLaoka(new Request(innerUrl, retryReq), env, ctx)
  const out = new Response(retry.body, retry)
  out.headers.delete('Set-Cookie')
  out.headers.append('Set-Cookie', setCookie)
  return out
}

app.all('/laoka/api/*', (c) => laokaApi(c.req.raw, c.env, execCtx(c)))

// THE LAOKA tab: authenticated shell page embedding the Laoka SPA chromeless.
app.get('/laoka', (c) => c.redirect('/laoka/'))
app.get('/laoka/', async (c) => {
  const user = await getHomeUserFromCookie(c.env.HOME_DB, getCookieFrom(c.req.raw, HOME_COOKIE))
  if (!user) return c.redirect('/login')
  // `?tab=` is carried into the module's own document (Laoka reads it at boot),
  // which is what lets a link land on the Pantry rather than the week plan.
  return c.html(<ModuleShell kind="laoka" displayName={user.display_name || user.username} tab={c.req.query('tab')} />)
})
// Chromeless module document for the shell's fetch (edge-side otherwise;
// gated here so the signed-out UI never renders).
app.get('/laoka/index.html', async (c) => {
  const user = await getHomeUserFromCookie(c.env.HOME_DB, getCookieFrom(c.req.raw, HOME_COOKIE))
  if (!user) return c.redirect('/login')
  return c.env.ASSETS.fetch(new Request(new URL('/laoka/index.html', c.req.url), { headers: c.req.raw.headers }))
})
// Stray /laoka/* deep links: the SPA shell in embed mode (not part of the
// tab UI, but kept working so old links never 404).
app.get('/laoka/*', (c) =>
  c.env.ASSETS.fetch(new Request(new URL('/laoka/index.html', c.req.url), { headers: c.req.raw.headers })),
)

// ══ Sompitra (the Home shell) at / — registered LAST ══════════════

app.route('/admin', admin)
app.route('/', auth)
app.route('/', dashboard)
app.route('/budget',   budget)
app.route('/kine',     kine)
app.route('/debts',    debts)
app.route('/sales',    sales)
app.route('/categories', categories)
app.route('/settings', settings)

// ══ Fallback + daily cron ═════════════════════════════════════════

app.notFound((c) => c.text('Not found', 404))

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx)
  },

  // Daily flush of W.A.Y's Durable Object buffers into way-db.
  // 21:00 UTC == 00:00 UTC+3 (Antananarivo midnight) — this IS the "today"
  // boundary for W.A.Y's dashboard; never move it to UTC midnight.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await flushFleet(env, ctx)
    // Retention without a human in the loop, on the same principle as the flush
    // above: the diagnostics ledger only has to be long enough to answer "did
    // this notification go out last month?", and a table that shrinks only when
    // someone remembers is a table that only grows. Best-effort and awaited on
    // purpose -- a failed prune must not take the nightly flush down with it
    // (pruneDiag never throws).
    const dropped = await pruneDiag(env)
    if (dropped > 0) console.log(`Diagnostics: pruned ${dropped} ledger entries older than 90 days`)
  },
} satisfies ExportedHandler<Env>

// ── tiny cookie helper (raw header level) ────────────────────────

function getCookieFrom(request: Request, name: string): string | undefined {
  const header = request.headers.get('Cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return undefined
}
