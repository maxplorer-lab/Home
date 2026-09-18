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
  // Forward the upgrade with the verified username attached as a header --
  // the DO uses this to stamp chat messages, never trusting whatever a
  // client-side message claims about who sent it.
  const forwarded = new Request(request, { headers: new Headers(request.headers) });
  forwarded.headers.set("X-WAY-Username", session.username);
  return stub.fetch(forwarded);
}

/** /way/* API + auth. Receives the request with the /way prefix REMOVED
 * (root rewrites path → /api/...), so internal checks are unchanged. */
export async function handleWay(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/auth/")) {
    return handleAuth(request, env, url.pathname);
  }

  if (url.pathname.startsWith("/api/")) {
    return handleDashboardApi(request, env, url.pathname);
  }

  return new Response("Not found", { status: 404 });
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
