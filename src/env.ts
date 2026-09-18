// env.ts — the Home super app's bindings, one interface for all modules.
//
// Binding name → purpose:
//   HOME_DB    → home-db      (central identity: users + sessions — THE login)
//   DB         → sompitra-db  (Sompitra finance data + its sessions)
//   WAY_DB     → way-db       (W.A.Y tracking, chat history, accounts)
//   LAOKA_DB   → laoka        (Laoka meal plans + its sessions)
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
