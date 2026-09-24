// routes/dashboard-api.ts
// Everything the dashboard needs that ISN'T the live WebSocket feed:
// device(=user) and geofence lists, geofence CRUD, per-user profile/prefs,
// invite-code generation, historical track queries, KML/CSV export,
// history deletion, and synced chat history.
//
// Every route requires a valid human session. Destructive / admin-scoped
// routes additionally require role === "admin".
//
// NOTE on chat: this only returns SYNCED messages (i.e. flushed to D1 by
// the daily cron). Anything sent today, before the next midnight flush,
// only exists in the fleet DO's own chat_messages table and arrives via
// the WebSocket on connect, not through this route. See FleetDO.ts.

import { D1Database } from "@cloudflare/workers-types";
import { Env, UserRow } from "../types";
import { verifyToken } from "../lib/auth-crypto";
import { USER_SESSION_COOKIE, getCookie } from "../lib/session";
import {
  getUsers, getGeofences, getGeofenceByName, createGeofence, updateGeofence, deleteGeofence,
  getPingsInRange, getMessagesInRange, getUserById, updateUserProfile, updateUserPrefs,
  createInviteCode, getInviteCodeByCode, listInviteCodes,
  deletePingsOlderThan, deleteMessagesOlderThan,
  updateUserTopic, updateUserQuietHours, getNotificationSubs, replaceNotificationSubs,
  getAppSetting, setAppSetting, deleteAppSetting,
  GeofenceInput,
} from "../db/queries";
import { buildCsv, buildKml } from "../lib/export";
import { findHomeUserByName, getHomeUserFromCookie, listNtfyChannels, setWayTopic, HOME_COOKIE } from "../../identity";
import {
  WAY_SHARE_KIND, createShare, listShares, revokeShare, replaceOpenShares, timeUntil, shareErrorText,
  shareErrorStatus, listShareTargets, resolveShareTarget,
} from "../../lib/share";
import type { Env as HomeEnv } from "../../env";
import {
  NOTIFY_EVENT_TYPES, NotifyEventType, generateNtfyTopic,
  NTFY_URL_SETTING_KEY, DEFAULT_NTFY_URL, normalizeNtfyServer,
} from "../lib/notify";

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: true, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonSuccess(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Who may mint a live-share code, decided the SAME way /admin decides it: the
 * central account and its role, when the identity database is bound. A
 * standalone W.A.Y deployment has no HOME_DB and no central account at all, so
 * there the W.A.Y role stands in — the answer a standalone deployment has
 * always had. Returns the username to credit, or null to refuse. */
async function shareMinter(request: Request, env: Env, wayUser: UserRow): Promise<string | null> {
  if (env.HOME_DB) {
    const cookie = getCookie(request, HOME_COOKIE);
    if (!cookie) return null;
    const homeUser = await getHomeUserFromCookie(env.HOME_DB, cookie);
    if (!homeUser) return null;
    return homeUser.role === "admin" ? homeUser.username : null;
  }
  return wayUser.role === "admin" ? wayUser.username : null;
}

/** Resolve the human behind the session cookie to a full, AUTHORITATIVE
 * user row (re-fetched from D1 so role changes take effect immediately,
 * and so we're not trusting a possibly-stale signed token's role). */
async function requireUser(request: Request, env: Env): Promise<UserRow | null> {
  const cookie = getCookie(request, USER_SESSION_COOKIE);
  if (!cookie) return null;
  const session = await verifyToken<{ userId: number }>(cookie, env.SESSION_SECRET);
  if (!session) return null;
  return getUserById(env.WAY_DB, session.userId);
}

/** Defaults a missing end to "now" and a missing start to 24h before end
 * -- a sane default window rather than forcing every caller to always
 * pass both. */
function resolveRange(url: URL): { start: string; end: string } {
  const end = url.searchParams.get("end") ?? new Date().toISOString();
  const start =
    url.searchParams.get("start") ?? new Date(new Date(end).getTime() - 24 * 60 * 60 * 1000).toISOString();
  return { start, end };
}

async function reloadGeofences(env: Env): Promise<void> {
  const id = env.FLEET_DO.idFromName("fleet");
  const stub = env.FLEET_DO.get(id);
  await stub.fetch("https://fleet-do/reload-geofences", { method: "POST" });
}

async function reloadNotifications(env: Env): Promise<void> {
  const id = env.FLEET_DO.idFromName("fleet");
  const stub = env.FLEET_DO.get(id);
  await stub.fetch("https://fleet-do/reload-notifications", { method: "POST" });
}

/** 6-digit numeric invite code. Modulo bias over a 32-bit random is
 * negligible at household scale (a handful of codes ever generated). */
function randomInviteCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = (buf[0] << 24 | buf[1] << 16 | buf[2] << 8 | buf[3]) >>> 0;
  return String(n % 1000000).padStart(6, "0");
}

async function generateUniqueInviteCode(db: D1Database): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = randomInviteCode();
    if (!(await getInviteCodeByCode(db, code))) return code;
  }
  return randomInviteCode(); // collision beyond 5 tries is vanishingly unlikely
}

interface GeofenceFields {
  displayName: string;
  category: string | null;
  lat: number;
  lon: number;
  radiusM: number;
  exitRadiusM: number | null;
}

function parseGeofenceFields(body: unknown): GeofenceFields | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const displayName = typeof b.displayName === "string" ? b.displayName.trim() : "";
  const lat = typeof b.lat === "number" ? b.lat : NaN;
  const lon = typeof b.lon === "number" ? b.lon : NaN;
  if (!displayName || Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return {
    displayName,
    category: typeof b.category === "string" && b.category ? b.category : null,
    lat,
    lon,
    radiusM: typeof b.radiusM === "number" && b.radiusM > 0 ? b.radiusM : 50,
    exitRadiusM: typeof b.exitRadiusM === "number" && b.exitRadiusM > 0 ? b.exitRadiusM : null,
  };
}

/**
 * Every active person's TRACKING topic, keyed by lower-cased username.
 *
 * Best-effort on purpose: a standalone W.A.Y deployment has no identity
 * database bound at all, and its admin screen must still list users. A person
 * the identity database has never heard of is therefore served from way-db's
 * own copy, which is exactly the fallback the FleetDO uses when routing.
 */
async function homeTrackingTopics(env: Env): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  try {
    for (const ch of await listNtfyChannels(env.HOME_DB)) {
      out.set(ch.username.toLowerCase(), ch.way_topic || null);
    }
  } catch {
    // No HOME_DB (standalone W.A.Y): the caller falls back to way-db.
  }
  return out;
}

/** The home account for a username, or null when there is none to be found. */
async function homeUser(env: Env, username: string): Promise<{ id: string } | null> {
  try {
    return await findHomeUserByName(env.HOME_DB, username);
  } catch {
    return null;
  }
}

export async function handleDashboardApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (!user) {
    return jsonError("Unauthorized", 401);
  }
  const isAdmin = user.role === "admin";
  const url = new URL(request.url);
  // lib/share.ts is typed against the CENTRAL Env, because that is where the
  // grants live. This Worker is handed the outer env at runtime (a superset of
  // these declarations), and every share route checks `env.HOME_DB` through
  // shareMinter BEFORE calling in, so this cast cannot paper over a binding
  // that is genuinely absent.
  const shareEnv = env as unknown as HomeEnv;

  // ---- Devices (= users) ----
  if (pathname === "/api/devices" && request.method === "GET") {
    const users = await getUsers(env.WAY_DB);
    return jsonSuccess(
      users.map((u) => ({
        deviceId: u.username, displayName: u.username, emoji: u.emoji, color: u.color,
      }))
    );
  }

  // ---- Current user: profile + prefs ----
  if (pathname === "/api/users/me" && request.method === "GET") {
    return jsonSuccess({
      id: user.id, username: user.username, emoji: user.emoji, color: user.color,
      role: user.role, followZoom: user.follow_zoom, homeFence: user.home_fence,
    });
  }
  if (pathname === "/api/users/me" && request.method === "PUT") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    // Only update fields that were actually sent, so a profile save
    // ({emoji,color}) doesn't clobber prefs and vice-versa.
    let emoji = user.emoji;
    let color = user.color;
    let followZoom = user.follow_zoom;
    let homeFence = user.home_fence;
    if (body) {
      if ("emoji" in body) emoji = typeof body.emoji === "string" && body.emoji ? body.emoji : null;
      if ("color" in body) color = typeof body.color === "string" && body.color ? body.color : null;
      if ("followZoom" in body && typeof body.followZoom === "number") {
        followZoom = body.followZoom;
        if (followZoom < 8) followZoom = 8;
        if (followZoom > 19) followZoom = 19;
      }
      if ("homeFence" in body) homeFence = typeof body.homeFence === "string" && body.homeFence ? body.homeFence : null;
    }
    await updateUserProfile(env.WAY_DB, user.id, { emoji, color });
    await updateUserPrefs(env.WAY_DB, user.id, { followZoom, homeFence });
    return jsonSuccess({ id: user.id, username: user.username, emoji, color, role: user.role, followZoom, homeFence });
  }

  // ---- Geofences ----
  if (pathname === "/api/geofences" && request.method === "GET") {
    const geofences = await getGeofences(env.WAY_DB);
    return jsonSuccess(
      geofences.map((g) => ({
        name: g.name, displayName: g.display_name, category: g.category,
        lat: g.lat, lon: g.lon, radiusM: g.radius_m, exitRadiusM: g.exit_radius_m,
      }))
    );
  }
  if (pathname === "/api/geofences" && request.method === "POST") {
    if (!isAdmin) return jsonError("Admin only", 403);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const fields = parseGeofenceFields(body);
    if (!name || !fields) return jsonError("name, displayName, lat, and lon are required");
    if (await getGeofenceByName(env.WAY_DB, name)) return jsonError("A geofence with that name already exists", 409);
    await createGeofence(env.WAY_DB, { name, ...fields });
    await reloadGeofences(env);
    return jsonSuccess({ ok: true });
  }
  if (pathname.startsWith("/api/geofences/")) {
    const name = decodeURIComponent(pathname.slice("/api/geofences/".length));
    if (request.method === "PUT") {
      if (!isAdmin) return jsonError("Admin only", 403);
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const fields = parseGeofenceFields(body);
      if (!fields) return jsonError("displayName, lat, and lon are required");
      if (!(await getGeofenceByName(env.WAY_DB, name))) return jsonError("Geofence not found", 404);
      await updateGeofence(env.WAY_DB, name, { name, ...fields });
      await reloadGeofences(env);
      return jsonSuccess({ ok: true });
    }
    if (request.method === "DELETE") {
      if (!isAdmin) return jsonError("Admin only", 403);
      await deleteGeofence(env.WAY_DB, name);
      await reloadGeofences(env);
      return jsonSuccess({ ok: true });
    }
  }

  // ---- Invite codes (admin) ----
  if (pathname === "/api/invite-codes" && request.method === "POST") {
    if (!isAdmin) return jsonError("Admin only", 403);
    const code = await generateUniqueInviteCode(env.WAY_DB);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    await createInviteCode(env.WAY_DB, code, user.id, expiresAt);
    return jsonSuccess({ code, expiresAt });
  }
  if (pathname === "/api/invite-codes" && request.method === "GET") {
    if (!isAdmin) return jsonError("Admin only", 403);
    const codes = await listInviteCodes(env.WAY_DB);
    return jsonSuccess({
      codes: codes.map((c) => ({
        code: c.code, createdAt: c.created_at, expiresAt: c.expires_at, usedBy: c.used_by, usedAt: c.used_at,
      })),
    });
  }

  // ---- Manual flush (admin) -- same work as the midnight cron ----
  if (pathname === "/api/flush" && request.method === "POST") {
    if (!isAdmin) return jsonError("Admin only", 403);
    try {
      const id = env.FLEET_DO.idFromName("fleet");
      const stub = env.FLEET_DO.get(id);
      const res = await stub.fetch("https://fleet-do/flush", { method: "POST" });
      const result = (await res.json()) as {
        pingsFlushed?: number; messagesFlushed?: number; error?: boolean; message?: string;
      };
      if (!res.ok || result.error) {
        return jsonError(result.message ?? "Flush failed", res.ok ? 500 : res.status);
      }
      return jsonSuccess(result);
    } catch (e) {
      // Never let an error here turn into a non-JSON 500 page.
      return jsonError(e instanceof Error ? e.message : "Flush failed", 500);
    }
  }

  // ---- Live share (admin): mint, list, stop — from the MAP's own settings ----
  //
  // The console at /admin is the household-wide card (every code, the ended
  // ones, revoke-all); this is the same grant reached from the device you are
  // looking at, which is where the question "can I show someone this trip?"
  // actually comes up. Both doors decide WHO may mint the same way (see
  // shareMinter), so the answer cannot differ between them.
  if (pathname === "/api/share" && request.method === "GET") {
    const device = (url.searchParams.get("device") || "").trim();
    const miner = await shareMinter(request, env, user);
    const open = miner
      ? (await listShares(shareEnv, "active")).filter((s) => s.subject === device)
      : [];
    return jsonSuccess({
      device,
      // The people who can be shared, so the row can let the admin PICK one
      // instead of inheriting whatever device the map happens to be following.
      // Same list as the console's, from the same function, because a picker that
      // offers someone the mint then refuses is the bug this replaced.
      deviceOptions: await listShareTargets(shareEnv),
      // Reported for ANY signed-in person, so a non-admin is told why the
      // button is not there instead of being shown one that fails.
      canShare: !!miner,
      // Never the pin or its hash: a code is shown once, at mint time.
      open: open.map((s) => ({
        id: s.id, label: s.label, created_at: s.created_at, created_by: s.created_by,
        expires_at: s.expires_at, expiresIn: timeUntil(s.expires_at),
        last_used_at: s.last_used_at,
      })),
    });
  }
  if (pathname === "/api/share" && request.method === "POST") {
    const miner = await shareMinter(request, env, user);
    if (!miner) return jsonError("Admin only", 403);
    let body: Record<string, unknown> = {};
    try { body = (await request.json()) as Record<string, unknown>; } catch { /* empty body */ }
    const device = String(body.device || "").trim();
    if (!device) return jsonError("A device is required", 400);
    // The subject must be someone this household can actually share: a device
    // that HAS AN ACCOUNT. Checked through the same function the picker is built
    // from, so the two can never disagree — and so the leftover `Niri` device row
    // (no account, no pings, ever) is refused here instead of being offered in a
    // dropdown. A TYPO is refused by the same answer, which is why the message
    // names the real fault rather than saying "unknown device".
    // `body.label` is deliberately not read: the name comes from the subject.
    const name = await resolveShareTarget(shareEnv, device);
    if (!name) return jsonError("That device has no account to share", 400);
    const created = await createShare(shareEnv, {
      kind: WAY_SHARE_KIND, subject: device,
      createdBy: miner,
    });
    // The reason is NAMED, not swallowed: "Could not create that code" is what
    // a missing migration looks like from the outside, and it sends the reader
    // hunting in the wrong place. shareErrorText says which file to run.
    if (!created.ok) return jsonError(shareErrorText(created.error), shareErrorStatus(created.error));
    // ONE live code per device, so "who is shared" has exactly one answer: the
    // code just minted replaces whatever was open for this device. Done AFTER the
    // create, so a failed mint leaves a working code alone rather than revoking
    // it and then failing.
    const replaced = await replaceOpenShares(shareEnv, device, created.share.id);
    // The ONE response that ever carries the pin.
    return jsonSuccess({
      pin: created.pin, device, label: created.share.label, replaced,
      createdAt: created.share.created_at, expiresAt: created.share.expires_at,
      expiresIn: timeUntil(created.share.expires_at),
    });
  }
  if (pathname === "/api/share/revoke" && request.method === "POST") {
    const miner = await shareMinter(request, env, user);
    if (!miner) return jsonError("Admin only", 403);
    let body: Record<string, unknown> = {};
    try { body = (await request.json()) as Record<string, unknown>; } catch { /* empty body */ }
    const device = String(body.device || "").trim();
    if (!device) return jsonError("A device is required", 400);
    // Only the grants the clock has not already ended: stamping `revoked_at` on
    // one that midnight already closed would credit this admin with an ending
    // that never happened, and the console's ended list would then lie about it.
    const open = (await listShares(shareEnv, "active")).filter((s) => s.subject === device);
    let revoked = 0;
    for (const s of open) if (await revokeShare(shareEnv, s.id)) revoked++;
    return jsonSuccess({ device, revoked });
  }

  // ---- Users (admin): list + ntfy topic management ----
  //
  // The topic shown here is the TRACKING channel -- the one W.A.Y's own events
  // are routed to -- and it is answered from the identity database, because
  // that is where it lives (home-db users.way_topic; see migrations-home/0004).
  // way-db's copy of the column is only a fallback for a standalone
  // deployment. Reading the copy here is exactly how this screen once told an
  // admin to subscribe to a topic that received nothing: the DO had already
  // moved to the home-db channel while this page kept advertising the old one.
  if (pathname === "/api/users" && request.method === "GET") {
    if (!isAdmin) return jsonError("Admin only", 403);
    const users = await getUsers(env.WAY_DB);
    const channels = await homeTrackingTopics(env);
    return jsonSuccess(
      users.map((u) => {
        const known = channels.has(u.username.toLowerCase());
        return {
          id: u.id, username: u.username, emoji: u.emoji, color: u.color,
          role: u.role,
          ntfyTopic: known ? channels.get(u.username.toLowerCase()) ?? null : u.ntfy_topic,
          topicSource: known ? "identity" : "way-db",
        };
      })
    );
  }
  if (pathname.startsWith("/api/users/") && pathname.endsWith("/topic") && request.method === "POST") {
    if (!isAdmin) return jsonError("Admin only", 403);
    const rawId = pathname.slice("/api/users/".length, pathname.length - "/topic".length);
    const targetId = parseInt(rawId, 10);
    if (!Number.isFinite(targetId)) return jsonError("Bad user id", 400);
    const target = await getUserById(env.WAY_DB, targetId);
    if (!target) return jsonError("User not found", 404);
    // Regenerating invalidates the old topic immediately -- the user must be
    // given the new one, since their ntfy app is still following the old.
    // Rotating through the identity engine (when this person has a home
    // account) keeps the two copies -- and therefore the phone -- in step;
    // a standalone deployment with no identity database falls back to its own.
    let topic: string;
    const home = await homeUser(env, target.username);
    if (home) {
      topic = await setWayTopic(env, home.id);
    } else {
      topic = generateNtfyTopic();
      await updateUserTopic(env.WAY_DB, targetId, topic);
    }
    await reloadNotifications(env);
    return jsonSuccess({ id: targetId, username: target.username, ntfyTopic: topic });
  }

  // ---- Notification grid (self) ----
  if (pathname === "/api/notifications" && request.method === "GET") {
    const [subs, users] = await Promise.all([getNotificationSubs(env.WAY_DB, user.id), getUsers(env.WAY_DB)]);
    return jsonSuccess({
      quietStart: user.quiet_start, quietEnd: user.quiet_end,
      eventTypes: NOTIFY_EVENT_TYPES,
      subs: subs.map((s) => ({ sourceId: s.source_id, eventType: s.event_type })),
      // Only OTHER users -- nobody is notified about their own events.
      users: users
        .filter((u) => u.id !== user.id)
        .map((u) => ({ id: u.id, username: u.username, emoji: u.emoji })),
    });
  }
  if (pathname === "/api/notifications" && request.method === "PUT") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    let quietStart = user.quiet_start;
    let quietEnd = user.quiet_end;
    if (typeof body?.quietStart === "number") quietStart = Math.min(23, Math.max(0, Math.floor(body.quietStart)));
    if (typeof body?.quietEnd === "number") quietEnd = Math.min(23, Math.max(0, Math.floor(body.quietEnd)));

    const rawSubs = Array.isArray(body?.subs) ? (body?.subs as unknown[]) : [];
    const subs: Array<{ sourceId: number; eventType: string }> = [];
    for (const item of rawSubs) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      const sourceId = typeof it.sourceId === "number" ? it.sourceId : null;
      const eventType = typeof it.eventType === "string" ? it.eventType : null;
      if (sourceId === null || eventType === null) continue;
      if (sourceId === user.id) continue; // never subscribe to your own events
      if (!NOTIFY_EVENT_TYPES.includes(eventType as NotifyEventType)) continue;
      subs.push({ sourceId, eventType });
    }

    await replaceNotificationSubs(env.WAY_DB, user.id, subs);
    await updateUserQuietHours(env.WAY_DB, user.id, quietStart, quietEnd);
    await reloadNotifications(env);
    return jsonSuccess({ ok: true });
  }

  // ---- App settings (admin): currently just the ntfy server root ----
  // Resolution order is setting -> env.NTFY_URL (wrangler.jsonc) -> default.
  // GET reports all three layers so the UI can show which one is winning
  // instead of leaving the admin to guess why an edit had no effect.
  if (pathname === "/api/settings" && request.method === "GET") {
    if (!isAdmin) return jsonError("Admin only", 403);
    // Tolerant of app_settings not existing yet: Workers Builds deploys code
    // automatically, but migrations are applied by hand, so there is always a
    // window where the new code runs against the old schema. A missing table
    // must degrade to "no override", not a 500 -- and it must never return
    // non-JSON, which has crashed this frontend before.
    let override: string | null = null;
    try {
      override = await getAppSetting(env.WAY_DB, NTFY_URL_SETTING_KEY);
    } catch {
      override = null;
    }
    const envValue = env.NTFY_URL ? normalizeNtfyServer(env.NTFY_URL) : null;
    // An override that no longer normalizes (edited straight in the database,
    // say) must fall through exactly like FleetDO does, or the card would
    // claim "set here" while the DO was publishing somewhere else. `ntfyUrl`
    // still reports the raw stored string so the admin sees what they saved.
    const normalizedOverride = override ? normalizeNtfyServer(override) : null;
    return jsonSuccess({
      ntfyUrl: override,
      envNtfyUrl: envValue,
      defaultNtfyUrl: DEFAULT_NTFY_URL,
      effectiveNtfyUrl: normalizedOverride ?? envValue ?? DEFAULT_NTFY_URL,
      source: normalizedOverride ? "setting" : (envValue ? "env" : "default"),
    });
  }
  if (pathname === "/api/settings" && request.method === "PUT") {
    if (!isAdmin) return jsonError("Admin only", 403);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !("ntfyUrl" in body)) return jsonError("ntfyUrl is required");

    const raw = typeof body.ntfyUrl === "string" ? body.ntfyUrl.trim() : "";
    try {
      if (raw === "") {
        // Empty clears the override, falling back to env/default -- the way to
        // undo a bad value without needing direct database access.
        await deleteAppSetting(env.WAY_DB, NTFY_URL_SETTING_KEY);
      } else {
        const normalized = normalizeNtfyServer(raw);
        if (!normalized) {
          return jsonError("Enter a full http(s) URL, e.g. https://ntfy.example.com");
        }
        await setAppSetting(env.WAY_DB, NTFY_URL_SETTING_KEY, normalized);
      }
      // The DO caches this; without the reload the old server keeps being used
      // until the instance happens to be evicted.
      await reloadNotifications(env);
    } catch (e) {
      // Same rule as /api/flush: an unexpected failure must still be JSON.
      return jsonError(e instanceof Error ? e.message : "Could not save settings", 500);
    }
    return jsonSuccess({ ok: true });
  }

  // ---- Diagnostic: what does the FleetDO actually have cached? (admin) ----
  if (pathname === "/api/debug/notify" && request.method === "GET") {
    if (!isAdmin) return jsonError("Admin only", 403);
    try {
      const id = env.FLEET_DO.idFromName("fleet");
      const stub = env.FLEET_DO.get(id);
      const res = await stub.fetch("https://fleet-do/debug-notify", { method: "GET" });
      const text = await res.text();
      if (res.status === 404) {
        return jsonSuccess({ warning: "DO has no /debug-notify route -- it is running PRE-notification code", raw: text.slice(0, 80) });
      }
      return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : "debug failed", 500);
    }
  }

  // ---- History ----
  if (pathname === "/api/history" && request.method === "GET") {
    const deviceId = url.searchParams.get("device_id");
    if (!deviceId) return jsonError("device_id is required");
    const { start, end } = resolveRange(url);
    const pings = await getPingsInRange(env.WAY_DB, deviceId, start, end);
    return jsonSuccess({ deviceId, start, end, pings });
  }

  if (pathname === "/api/history/delete" && request.method === "POST") {
    if (!isAdmin) return jsonError("Admin only", 403);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const months = typeof body?.months === "number" && body.months > 0 ? body.months : null;
    if (!months) return jsonError("months is required");
    const deleteTracks = body?.deleteTracks === true;
    const deleteMessages = body?.deleteMessages === true;
    if (!deleteTracks && !deleteMessages) return jsonError("Select at least one item to delete");
    const cutoff = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000).toISOString();
    const deletedPings = deleteTracks ? await deletePingsOlderThan(env.WAY_DB, cutoff) : 0;
    const deletedMessages = deleteMessages ? await deleteMessagesOlderThan(env.WAY_DB, cutoff) : 0;
    return jsonSuccess({ deletedPings, deletedMessages });
  }

  // ---- Export ----
  if (pathname === "/api/export/csv" && request.method === "GET") {
    const deviceId = url.searchParams.get("device_id");
    if (!deviceId) return jsonError("device_id is required");
    const { start, end } = resolveRange(url);
    const pings = await getPingsInRange(env.WAY_DB, deviceId, start, end);
    return new Response(buildCsv(pings), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${deviceId}_${start}_${end}.csv"`,
      },
    });
  }

  if (pathname === "/api/export/kml" && request.method === "GET") {
    const deviceId = url.searchParams.get("device_id");
    if (!deviceId) return jsonError("device_id is required");
    const { start, end } = resolveRange(url);
    const pings = await getPingsInRange(env.WAY_DB, deviceId, start, end);
    return new Response(buildKml(deviceId, pings), {
      headers: {
        "Content-Type": "application/vnd.google-earth.kml+xml",
        "Content-Disposition": `attachment; filename="${deviceId}_${start}_${end}.kml"`,
      },
    });
  }

  // ---- Live chat watermark (the Home nav's unread dot, and the Home page's
  // ---- unread card) ----
  // The newest message as the DO holds it, NOT as D1 does: the flush runs once
  // at midnight, so today's messages exist only in the Durable Object. Returns
  // a timestamp to compare against and the unread lines, never the whole
  // conversation -- every page of the app polls this, so the answer is one row,
  // one count and a bounded window of previews (both limits are the DO's, so
  // they hold for every caller). `since` is the caller's own watermark, passed
  // through untouched: the DO binds it as a query parameter, so a forged value
  // can only ever describe the caller's own view of the room.
  if (pathname === "/api/chat/latest" && request.method === "GET") {
    const since = url.searchParams.get("since");
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    const id = env.FLEET_DO.idFromName("fleet");
    const res = await env.FLEET_DO.get(id).fetch(`https://fleet-do/chat-latest${qs}`);
    return new Response(res.body, {
      status: res.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // ---- Synced chat history ----
  if (pathname === "/api/chat/history" && request.method === "GET") {
    const { start, end } = resolveRange(url);
    const messages = await getMessagesInRange(env.WAY_DB, start, end);
    return jsonSuccess({ start, end, messages });
  }

  return jsonError("Not found", 404);
}
