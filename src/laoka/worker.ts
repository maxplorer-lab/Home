// Adapter: runs Laoka's standalone Worker inside the Home super app.
//
// Laoka's own router (src/laoka/index.js) handles exactly four kinds of
// traffic, all rooted at "/" in its standalone deployment:
//   /ws          → its Lobby Durable Object (realtime fan-out)
//   /api/...     → its JSON API (auth, catalog, weeks, shopping, admin)
//   static files → its frontend (styles.css, app.js, icon.svg, manifest)
//   anything else → index.html (it is a single page app)
//
// Inside Home:
//   • The browser prefix /laoka is stripped before dispatch, so Laoka's
//     router sees the paths it expects ("/api/bootstrap" etc.).
//   • env.DB → LAOKA_DB (Laoka keeps its own database untouched).
//   • env.ASSETS → a fetcher that serves from Home's public/laoka/ directory.
//   • /laoka-ws (Home's namespace for Laoka's realtime socket) is forwarded
//     to the Lobby DO. Home's /ws belongs to W.A.Y's FleetDO.
//
// Auth stays Laoka's own mechanism (cookie `laoka_session`, D1-backed):
// the unified Home login mints that cookie, and if it ever goes missing
// the main Worker re-mints it on a 401 — see src/index.tsx.

import laokaWorker from './index.js'
import { fail } from './lib/http.js'
import type { Env } from '../env'

// Minimal execution context: only waitUntil is used by Laoka's routes.
interface ExecCtx {
  waitUntil(promise: Promise<unknown>): void
}

// Home's static-asset binding, scoped to the /laoka section of public/.
// Laoka's router asks for "/styles.css", "/app.js", "/index.html" — this
// fetcher maps them onto "/laoka/styles.css" and so on.
function laokaScopedAssets(env: Env): Fetcher {
  return {
    fetch: (request: Request) => {
      const url = new URL(request.url)
      const scoped = new URL('/laoka' + (url.pathname === '/' ? '/' : url.pathname), url.origin)
      return env.ASSETS.fetch(new Request(scoped, request))
    },
  } as unknown as Fetcher
}

export async function handleLaoka(request: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  const url = new URL(request.url)

  // Home owns identity: block Laoka's own credential endpoints so nobody can
  // sign in / change passwords around the central login (which also enforces
  // central deactivation). Invite administration is meaningless without the
  // signup flow, so its mutations go too.
  const innerPath0 = url.pathname === '/laoka-ws' ? '/ws' : url.pathname.replace(/^\/laoka(?=\/|$)/, '') || '/'
  if (/^\/api\/(auth\/(login|signup|logout|password)|invites(\/.*)?)$/.test(innerPath0)) {
    return fail(403, 'Accounts and sign-in are handled by the Home super app (use /login).')
  }

  // Realtime socket: Home serves it at /laoka-ws so it cannot collide with
  // W.A.Y's /ws. Rewrite to the /ws Laoka's router expects and dispatch
  // through Laoka itself — its entry authenticates the cookie BEFORE
  // handing the socket to the Lobby DO, so the check is preserved.
  const innerPath = innerPath0
  const inner = new URL(innerPath, url.origin)

  const laokaEnv = {
    ...env,
    DB: env.LAOKA_DB,
    ASSETS: laokaScopedAssets(env),
  }

  // Laoka's default export is a plain { fetch } object: exactly what the
  // standalone Worker was. ctx rides along so its routes can waitUntil.
  return laokaWorker.fetch(new Request(inner, request), laokaEnv, ctx)
}
