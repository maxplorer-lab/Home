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

export async function handleDashboardApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const user = await requireUser(request, env);
  if (!user) {
    return jsonError("Unauthorized", 401);
  }
  const isAdmin = user.role === "admin";
  const url = new URL(request.url);

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

  // ---- Users (admin): list + ntfy topic management ----
  if (pathname === "/api/users" && request.method === "GET") {
    if (!isAdmin) return jsonError("Admin only", 403);
    const users = await getUsers(env.WAY_DB);
    return jsonSuccess(
      users.map((u) => ({
        id: u.id, username: u.username, emoji: u.emoji, color: u.color,
        role: u.role, ntfyTopic: u.ntfy_topic,
      }))
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
    const topic = generateNtfyTopic();
    await updateUserTopic(env.WAY_DB, targetId, topic);
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

  // ---- Synced chat history ----
  if (pathname === "/api/chat/history" && request.method === "GET") {
    const { start, end } = resolveRange(url);
    const messages = await getMessagesInRange(env.WAY_DB, start, end);
    return jsonSuccess({ start, end, messages });
  }

  return jsonError("Not found", 404);
}
