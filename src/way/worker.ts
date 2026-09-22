// index.ts — WAY module inside the Home super app.
//
// This file is NO LONGER a Worker entry. It exports two functions that the
// Home root Worker (src/index.tsx) calls:
//   • handleWay(request, env)   → mounted by the root at /way/*  (API + auth)
//   • handleWayWebSocket(...)   → mounted by the root at /ws     (app-global)
//   • flushFleet(env, ctx)      → called by the root's daily cron
//
// The API paths stay /api/* INTERNALLY: the root strips the /way prefix
// before calling handleWay, and the dashboard was patched to request
// /way/api/* — so handleDashboardApi keeps seeing "/api/..." exactly as
// before. One rewrite at the boundary, zero rewrites in the API code.
//
// The original standalone entry (default export + scheduled) is preserved
// below as comments for reference; routing and cron now live in the root.
//
// Full route-by-route reference: docs/ARCHITECTURE.md in the original W.A.Y repo.

import { Env } from "./types";
import { handleIngest } from "./routes/ingest";
import { handleAuth } from "./routes/auth";
import { handleDashboardApi } from "./routes/dashboard-api";
import { verifyToken } from "./lib/auth-crypto";
import { getUserByUsername } from "./db/queries";
import { USER_SESSION_COOKIE, getCookie } from "./lib/session";

export { FleetDO } from "./do/FleetDO";

interface UserSessionPayload {
  userId: number;
  username: string;
}

/** WebSocket upgrade for the dashboard chat/live feed. App-global at /ws:
 * the FleetDO stamps chat identity from the verified session, so the
 * browser must hit the same origin it holds the way_user_session cookie
 * for — which / is, regardless of which app's page opens the socket. */
export async function handleWayWebSocket(request: Request, env: Env): Promise<Response> {
  const cookie = getCookie(request, USER_SESSION_COOKIE);
  const session = cookie ? await verifyToken<UserSessionPayload>(cookie, env.SESSION_SECRET) : null;
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const id = env.FLEET_DO.idFromName("fleet");
  const stub = env.FLEET_DO.get(id);
  // The token's own spelling is NOT the identity. A session lasts 30 days, so
  // the cookie a phone holds across a rename still carries the OLD casing, and
  // the DO stamps it onto every chat row, reaction and push title: the person's
  // own messages then read as someone else's, and the notify lookup (which is
  // keyed by name) finds no account and rings nobody. Resolve the ACCOUNT here,
  // exactly as the phone's door does (canonicalDeviceId in routes/ingest.ts),
  // so one person has exactly one spelling no matter which door they used.
  // A name with no row is passed through rather than refused: standalone W.A.Y
  // deployments may have no users row at all, and the DO's own ledger already
  // says "no such user" for it.
  const account = await getUserByUsername(env.WAY_DB, session.username);
  // Forward the upgrade with the verified username attached as a header --
  // the DO uses this to stamp chat messages, never trusting whatever a
  // client-side message claims about who sent it.
  const forwarded = new Request(request, { headers: new Headers(request.headers) });
  forwarded.headers.set("X-WAY-Username", account?.username ?? session.username);
  return stub.fetch(forwarded);
}

/** /way/* API + auth. Receives the request with the /way prefix REMOVED
 * (root rewrites path → /api/...), so internal checks are unchanged. */
/**
 * Drop the FleetDO's cached notification config (topics + subscriptions).
 *
 * The DO caches them so a ping never waits on D1, which means a channel
 * change made in /settings is invisible to it until the cache is dropped.
 * Call this after ANY change to a person's ntfy channel, or a rotation looks
 * like it silently failed. Never throws — settings must not fail because the
 * DO was busy.
 */
export async function reloadWayNotifications(env: Env): Promise<void> {
  try {
    const id = env.FLEET_DO.idFromName("fleet");
    await env.FLEET_DO.get(id).fetch("https://fleet-do/reload-notifications", { method: "POST" });
  } catch {
    // best effort
  }
}

// Re-exported for callers that already reach WAY's surface (and so the
// module's public shape stays one place). The implementation lives in
// ./system-chat so src/lib/notify.ts can call it WITHOUT importing this worker
// and everything it pulls in -- see that file's header for why.
export { postSystemChat } from "./system-chat";

export async function handleWay(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const isAuth = url.pathname.startsWith("/api/auth/");
  const isApi = isAuth || url.pathname.startsWith("/api/");
  if (!isApi) return new Response("Not found", { status: 404 });

  // Both groups are read by a PAGE, so an unexpected failure must still answer
  // with a sentence. This is the completion of a rule this app already learned
  // the hard way: the share's own failures are NAMED (see lib/share.ts), and
  // yet a throw ABOVE that layer — `requireUser` reading D1, the identity lookup
  // the minter does first — still escaped as a bodyless 500, which a JSON client
  // can only flatten back into "Could not generate a code.": the same sentence
  // that names nothing, from a different cause. Observed for real on
  // POST /api/share (2026-09-21), so this is not a hypothesis about a rare
  // branch. Logged with its route — never swallowed, because a fault that
  // answers politely still has to be findable in the logs.
  try {
    return isAuth
      ? await handleAuth(request, env, url.pathname)
      : await handleDashboardApi(request, env, url.pathname);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`WAY ${url.pathname} threw: ${detail}`);
    return new Response(
      JSON.stringify({ error: true, message: "Something went wrong on the server — try again" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

/** μlogger ingest. App-global at /ulogger (the phone app cannot be
 * re-pointed per-module and speaks its own fixed protocol). */
export async function handleWayIngest(request: Request, env: Env): Promise<Response> {
  return handleIngest(request, env);
}

/** Daily flush of the fleet DO's buffers into way-db. Called by the
 * root Worker's scheduled() handler at 21:00 UTC (00:00 UTC+3). */
export async function flushFleet(env: Env, ctx: ExecutionContext): Promise<void> {
  const id = env.FLEET_DO.idFromName("fleet");
  const stub = env.FLEET_DO.get(id);
  ctx.waitUntil(
    stub.fetch("https://fleet-do/flush", { method: "POST" }).then(async (res) => {
      const result = await res.json();
      console.log("Daily flush result:", JSON.stringify(result));
    })
  );
}
