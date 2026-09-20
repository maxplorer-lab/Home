// routes/ingest.ts
// Speaks enough of μlogger's actual client protocol to accept uploads
// from the unmodified Android app -- NOT a simple per-ping Basic Auth
// endpoint. Basic Auth per request is the obvious guess and it is wrong:
// μlogger authenticates ONCE and then echoes a session cookie (in the
// older RFC 2109 quoted form -- see getCookie in lib/session.ts), so a
// stateless per-ping credential check rejects every upload.
// The real flow: POST action=auth (user/pass) -> session cookie ->
// POST action=addtrack -> trackid -> repeated POST action=addpos.
//
// Deliberately minimal: WAY has no "tracks" concept. addtrack just hands
// back a fixed id the app is required to echo on every addpos; we never
// validate it, since all we actually care about is which DEVICE sent a
// ping.
//
// KNOWN LIMITATION: μlogger's real protocol does not report battery
// level at all (unlike OwnTracks). gps_pings.battery will be null for
// every ping ingested through this route.

import { Env } from "../types";
import { verifyPassword, signToken, verifyToken } from "../lib/auth-crypto";
import { RawPing } from "../lib/state-machine";
import { getUserByUsername } from "../db/queries";
import {
  DEVICE_SESSION_COOKIE, DEVICE_SESSION_TTL_SECONDS, getCookie, buildSetCookie,
} from "../lib/session";

interface DeviceSessionPayload {
  deviceId: string; // == the username (one person == one device)
}

/** The spelling the account actually has today, for a name that may have
 * been spelled differently when this session was minted.
 *
 * The device cookie lasts 30 days and nothing re-looks-up the account on
 * every fix, so a session created before a rename would keep stamping the
 * old spelling onto gps_pings.device_id -- which is the key the dashboard
 * draws markers, trips and the map by. That is a rename quietly undoing
 * itself, one ping at a time.
 *
 * A name with no account at all passes through untouched rather than
 * erroring: the fix then fails the way it always would, instead of the
 * whole device going dark because its row was renamed or removed. */
async function canonicalDeviceId(db: D1Database, deviceId: string): Promise<string> {
  if (!deviceId) return deviceId;
  const user = await getUserByUsername(db, deviceId);
  return user?.username || deviceId;
}

function jsonError(message: string, status = 401): Response {
  return new Response(JSON.stringify({ error: true, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonSuccess(extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: false, ...extra }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** μlogger POSTs form-encoded (occasionally multipart, for waypoint photos
 * we don't support). Normalise both to a single lookup interface. */
async function parseFields(request: Request): Promise<URLSearchParams> {
  if (request.method === "GET") {
    return new URL(request.url).searchParams;
  }
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const params = new URLSearchParams();
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") params.set(k, v);
    }
    return params;
  }
  return new URLSearchParams(await request.text());
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  const fields = await parseFields(request);
  const action = fields.get("action");
  if (!action) return jsonError("Missing action", 400);

  // ---- action=auth: no session required yet, this is what creates one ----
  if (action === "auth") {
    const username = fields.get("user");
    const pass = fields.get("pass");
    if (!username || !pass) return jsonError("Missing credentials", 400);

    // One person == one device (migration 0002): μlogger authenticates
    // with the SAME username/password as the dashboard login, matched by
    // the same case-insensitive rule (see getUserByUsername). The password
    // is still the gate -- the folding only decides which row is meant.
    const user = await getUserByUsername(env.WAY_DB, username);

    if (!user || !(await verifyPassword(pass, user.password_hash))) {
      return jsonError("Unauthorized");
    }

    // deviceId in the session == the username -- the STORED spelling, not
    // what the phone typed -- so every ping lands under the account's one
    // true name however the app was configured. This is what gets stamped
    // onto every ping (gps_pings.device_id) and what the dashboard keys
    // markers/badges by.
    const token = await signToken(
      { deviceId: user.username, exp: Math.floor(Date.now() / 1000) + DEVICE_SESSION_TTL_SECONDS },
      env.SESSION_SECRET
    );

    const res = jsonSuccess();
    // Secure only when actually serving https (see buildSetCookie in
    // session.ts) -- wrangler dev serves http, production serves https.
    res.headers.append("Set-Cookie", buildSetCookie(DEVICE_SESSION_COOKIE, token, DEVICE_SESSION_TTL_SECONDS, new URL(request.url).protocol === "https:"));
    return res;
  }

  // ---- Every other action requires a valid session from action=auth ----
  const cookie = getCookie(request, DEVICE_SESSION_COOKIE);
  const session = cookie
    ? await verifyToken<DeviceSessionPayload>(cookie, env.SESSION_SECRET)
    : null;
  if (!session) return jsonError("Unauthorized");
  const deviceId = await canonicalDeviceId(env.WAY_DB, session.deviceId);

  if (action === "addtrack") {
    // No real "tracks" table -- fixed id, never validated on addpos.
    return jsonSuccess({ trackid: 1 });
  }

  if (action === "addpos") {
    const lat = parseFloat(fields.get("lat") ?? "");
    const lon = parseFloat(fields.get("lon") ?? "");
    const timeSec = parseInt(fields.get("time") ?? "", 10);
    if (Number.isNaN(lat) || Number.isNaN(lon) || Number.isNaN(timeSec)) {
      return jsonError("Missing required parameter", 400);
    }

    // μlogger reports speed in metres/second (Android LocationManager
    // convention) -- state-machine.ts expects km/h throughout.
    const speedRaw = fields.get("speed");
    const speedMs = speedRaw !== null ? parseFloat(speedRaw) : NaN;
    const vel = !Number.isNaN(speedMs) ? speedMs * 3.6 : null;

    const accuracyRaw = fields.get("accuracy");
    const altitudeRaw = fields.get("altitude");

    const ping: RawPing = {
      deviceId,
      timestamp: new Date(timeSec * 1000).toISOString(),
      latitude: lat,
      longitude: lon,
      vel,
    };

    // Hand off to the single fleet DO for everything stateful: glitch
    // filtering, the state machine, persistence, and live broadcast.
    // See FleetDO.ts for the /ingest contract this call relies on.
    const doId = env.FLEET_DO.idFromName("fleet");
    const stub = env.FLEET_DO.get(doId);
    const doResponse = await stub.fetch("https://fleet-do/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ping,
        accuracy: accuracyRaw !== null ? parseFloat(accuracyRaw) : null,
        altitude: altitudeRaw !== null ? parseFloat(altitudeRaw) : null,
      }),
    });

    if (!doResponse.ok) {
      return jsonError("Internal error processing position", 500);
    }
    return jsonSuccess();
  }

  return jsonError(`Unknown action: ${action}`, 400);
}
