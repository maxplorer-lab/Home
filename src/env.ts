// env.ts — the Home super app's bindings, one interface for all modules.
//
// Binding name → purpose. Since 2026-10-06 these bind TWO databases, not four:
// the bindings stay separate because each module's code asks for its own, but
// HOME_DB and WAY_DB resolve to the same database, and DB and LAOKA_DB to the
// other. Tables that would have collided carry the owning module's prefix.
//   HOME_DB    → home-db      (central identity: users + sessions — THE login)
//   WAY_DB     → home-db      (W.A.Y tracking + chat history — way_users, …)
//   DB         → sompitra-db  (Sompitra finance data + its sessions)
//   LAOKA_DB   → sompitra-db  (Laoka meals — laoka_users, laoka_sessions, …)
//   FLEET_DO   → FleetDO      (W.A.Y Durable Object: live state + chat)
//   LOBBY      → Lobby        (Laoka Durable Object: realtime fan-out)
//   ASSETS     → ./public     (Home shell + /way PWA bits + /laoka files)
//
// Secrets (set via .dev.vars locally, `wrangler secret put` in production):
//   AUTH_PEPPER      → HMAC pepper for the central password hashes
//                      (REQUIRED — at least 16 characters)
//   SESSION_SECRET   → signs W.A.Y session tokens (reuse W.A.Y's old value)
//   SETUP_TOKEN      → optional; if set, the one-time /bootstrap claim must
//                      supply it (protects the first-admin window)
//   NTFY_TOKEN       → optional, only if the ntfy server has auth enabled
export interface Env {
  HOME_DB: D1Database
  DB: D1Database
  WAY_DB: D1Database
  LAOKA_DB: D1Database
  FLEET_DO: DurableObjectNamespace
  LOBBY: DurableObjectNamespace
  ASSETS: Fetcher
  APP_NAME: string
  NTFY_URL?: string
  PBKDF2_ITERATIONS?: string
  AUTH_PEPPER: string
  SESSION_SECRET: string
  SETUP_TOKEN?: string
  NTFY_TOKEN?: string
}
