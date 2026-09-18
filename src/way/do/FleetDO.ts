// FleetDO.ts
// The single household-wide Durable Object -- the WRITE PATH of the whole
// system. Every GPS ping is classified, stored and broadcast here; D1 only
// catches up once a day (see the /flush route below). If you are changing
// tracking or notification behaviour, this file and lib/state-machine.ts are
// where it happens; read docs/ARCHITECTURE.md first.
//
// HTTP routes (all internal -- fetched by src/index.ts, never by a browser):
//   POST /ingest               accept + classify a ping (the hot path)
//   POST /chat                 insert a chat message (currently UNUSED -- real
//                              chat arrives over the WebSocket below; kept as
//                              a server-side entry point for future bot/system
//                              messages)
//   POST /flush                copy pending_sync + chat_messages into D1
//   POST /reload-geofences     invalidate the geofence cache
//   POST /reload-notifications invalidate the subscriber/topic cache
//   GET  /debug-notify         last notification decision + cooldowns
//   GET  /ws (Upgrade)         dashboard WebSocket, snapshot on connect
//
// Three DO-local SQLite tables (durable the instant they're written -- see
// migrations/0001_init.sql's header comment for why this isn't the
// same thing as D1):
//   - device_state : per-device MotionState + control flags + lastStatus +
//                    exitBuffer, survives DO eviction
//   - pending_sync : track points not yet flushed to D1 (throttled per
//                    the driving/walking persistence rules)
//   - chat_messages: recent scrollback, flushed (not deleted) daily
//
// Two rules that have caused silent outages before, do not undo them:
//   1. /flush chunks at <= 100 statements (D1's batch() cap) and deletes a
//      chunk only after D1 acknowledges it.
//   2. Auto-generated chat rows carry sender = null, but D1's
//      messages.sender is NOT NULL -- they must be mapped to "System".
// See docs/OPERATIONS.md, "Known failure modes".

import { DurableObject } from "cloudflare:workers";
import { Env, GeofenceRow } from "../types";
import {
  Geofence, distanceM, bearingDegrees, angularDiff } from "../lib/geofence";
import {
  NotifyEventType, NOTIFY_EVENT_TYPES, EVENT_TAGS, inQuietHours, publishNtfy, TZ_OFFSET_MS,
  NTFY_URL_SETTING_KEY, DEFAULT_NTFY_URL, normalizeNtfyServer,
} from "../lib/notify";
import {
  processPing,
  initialMotionState,
  isGlitch,
  MotionState,
  RawPing,
  PingResult,
  ForcedMode,
} from "../lib/state-machine";

/** Household ntfy server, in home-db (the unified settings own it). */
const NTFY_SERVER_HOME_KEY = "ntfy_server";

interface LiveDeviceStatus extends PingResult {
  timestamp: string;
  latitude: number;
  longitude: number;
  speed: number | null; // raw instantaneous speed (km/h) -- distinct from PingResult.speedAvg
}

/** A ping held back during the exit guard, awaiting the confirmed exit. */
interface BufferedPing {
  timestamp: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  speed: number | null;
  speedAvg: number;
  isDriving: boolean;
  distance: number;
  legId: number | null;
  accuracy: number | null;
}

interface StoredDeviceState {
  motion: MotionState;
  forcedMode: ForcedMode;              // manual driving/walking lock, off by default
  recordingPaused: boolean;            // true = live tracking continues, history doesn't
  lastStatus: LiveDeviceStatus | null; // full last-known status, for snapshot-on-connect
  exitBuffer: BufferedPing[];          // pings held during the exit guard
}

interface IngestBody {
  ping: RawPing;
  accuracy: number | null;
  altitude: number | null;
}

// Push-notification policy. A per-(source, event type, geofence) cooldown
// keeps GPS jitter / fence flapping from becoming a notification storm, and
// the per-source daily cap is a safety valve. Routing, quiet hours and the
// ntfy publish itself live in lib/notify.ts.
const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
const NOTIFY_DAILY_CAP = 100;

// "Entry timer": while a device is driving TOWARD a category="Home" fence,
// notify once when the estimated time to the fence edge crosses each of
// these (seconds), and re-arm when it turns away or arrives.
const APPROACH_THRESHOLDS = [60, 30];
const APPROACH_MIN_SPEED_KMH = 15;    // below this there is no meaningful ETA
const APPROACH_MAX_BEARING_DIFF = 55; // must actually be heading at the fence

// Exit-guard buffer cap (~5 min at a 5s cadence). A device parked just outside
// the exit radius must not be able to grow this without bound.
const EXIT_BUFFER_MAX = 60;

// How much of a quoted message a reply carries. The chat input caps messages at
// 200 chars, so this keeps a quote visually a quote rather than a duplicate of
// the whole message.
const REPLY_SNIPPET_MAX_CHARS = 120;

// Chat reactions (👍🤣💖). The set is deliberately fixed and tiny: the emoji is
// validated server-side against this exact list, so a malformed frame can never
// inject arbitrary content into a broadcast or into D1. A reaction is a toggle
// per user (WhatsApp semantics): one reaction per person per message -- tapping
// a different emoji replaces theirs, tapping the same one removes it.
const REACTION_EMOJIS = ["👍", "🤣", "💖"];

// Event types an OUTSIDE caller (the Sompitra module, via lib/notify.ts) may
// stamp on a system chat message. Validated against this exact list so the
// intake endpoint can never be used to mint an arbitrary event type that the
// chat renderer would then have no styling for.
//
// "arrived"/"left" are NOT accepted here -- WAY generates those itself from
// geofence transitions (see handleGeofenceEvents) and their wording carries a
// device id. This endpoint is for the OTHER modules.
//
// Income and expense are separate types so the chat can colour them apart.
// ("budget" was the first, single money type and is still rendered by the chat
// page's style map, but it is no longer accepted here -- nothing posts it.)
const EXTERNAL_SYSTEM_EVENTS = ["expense", "income", "kine"];

interface NotifyUser {
  id: number;
  username: string;
  topic: string | null;
  quietStart: number;
  quietEnd: number;
}

export class FleetDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private geofenceCache: Geofence[] | null = null;
  // Notification routing cache (users' topics + the subscription grid),
  // invalidated by /reload-notifications after any admin/user edit.
  private notifyCache: {
    users: NotifyUser[];
    subs: Array<{ subscriberId: number; sourceId: number; eventType: string }>;
    /** Where notifications are published, resolved at cache-load time.
     * `source` records which layer supplied it, so /debug-notify can say
     * whether an admin setting, the wrangler var, or the default is in
     * force -- see lib/notify.ts's resolution-order comment. */
    server: { url: string; source: "setting" | "env" | "default" };
  } | null = null;
  private notifyCooldowns = new Map<string, number>();
  private notifyDaily = new Map<string, { day: string; count: number }>();
  private lastNotify: { at: string; source: string; type: string; outcome: string } | null = null;
  // "deviceId:fenceName" -> thresholds already announced on this approach.
  private approachFired = new Map<string, Set<number>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensureSchema();
    // Diagnostic: proves which code version this DO instance is running.
    console.log("FleetDO started (notify build)");
  }

  private ensureSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS device_state (
        device_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_sync (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude REAL,
        speed REAL,
        speed_avg_30s REAL,
        is_inside_geofence INTEGER,
        geofence_name TEXT,
        is_driving INTEGER,
        distance_km REAL,
        is_stationary INTEGER,
        is_keep_alive INTEGER,
        battery REAL,
        accuracy REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        sender TEXT,
        device_id TEXT,
        message TEXT NOT NULL,
        is_auto INTEGER NOT NULL DEFAULT 0,
        event_type TEXT,
        gps_timestamp TEXT,
        created_at TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0
      )
    `);
    // pending_sync.leg_id was added later (legs are a backend-only concept).
    // ALTER throws if the column already exists, which is fine -- and it is
    // needed because CREATE TABLE IF NOT EXISTS won't touch an existing DO's
    // table.
    try {
      this.sql.exec(`ALTER TABLE pending_sync ADD COLUMN leg_id INTEGER`);
    } catch {
      // column already present
    }
    // Chat replies (migration 0006 on the D1 side) -- same ALTER dance, same
    // reason: this DO already has a chat_messages table without these columns.
    for (const col of ["reply_to_id", "reply_to_sender", "reply_to_snippet"]) {
      try {
        this.sql.exec(`ALTER TABLE chat_messages ADD COLUMN ${col} TEXT`);
      } catch {
        // column already present
      }
    }

    // The try/catch above is deliberately silent, which means a genuine ALTER
    // failure would only ever show up later as chat messages that never send.
    // Probe the result instead, so a cold start states plainly whether it is
    // healthy. Wrapped as well: this runs in the constructor, and a throw here
    // would stop the DO from starting at all.
    try {
      this.sql.exec(`SELECT reply_to_id FROM chat_messages LIMIT 1`).toArray();
      console.log("FleetDO ready: chat_messages has the reply columns");
    } catch (e) {
      console.log(
        `FleetDO SCHEMA PROBLEM: chat_messages is missing reply columns (${e instanceof Error ? e.message : String(e)}) -- ` +
        `chat replies will fail; the ALTERs in ensureSchema did not apply`
      );
    }

    // Chat reactions (migration 0007 on the D1 side). Same try/catch ALTER
    // dance as the reply columns above, same reason: this DO already has a
    // chat_messages table without these columns, and CREATE TABLE IF NOT
    // EXISTS won't touch an existing table. Three columns:
    //   reactions          JSON object emoji -> count, e.g. {"👍":2}
    //   reaction_users     JSON object username -> emoji (who reacted, so a
    //                      client can show "you reacted" and toggling stays
    //                      one-per-user without re-deriving it)
    //   reaction_updated_at  ISO timestamp of the last reaction change
    // All nullable: rows written before this feature simply have none.
    for (const col of ["reactions", "reaction_users", "reaction_updated_at"]) {
      try {
        this.sql.exec(`ALTER TABLE chat_messages ADD COLUMN ${col} TEXT`);
      } catch {
        // column already present
      }
    }

    // The reply-column probe above is deliberately silent about WHY it failed;
    // this one additionally proves the reaction columns landed, so a cold start
    // states plainly whether chat reactions are usable.
    try {
      this.sql.exec(`SELECT reactions, reaction_users FROM chat_messages LIMIT 1`).toArray();
      console.log("FleetDO ready: chat_messages has the reaction columns");
    } catch (e) {
      console.log(
        `FleetDO SCHEMA PROBLEM: chat_messages is missing reaction columns (${e instanceof Error ? e.message : String(e)}) -- ` +
        `chat reactions will fail; the ALTERs in ensureSchema did not apply`
      );
    }
  }

  // ------------------------------------------------------------
  //  fetch() -- internal calls from ingest.ts / ws.ts / the daily cron
  //  handler, plus WebSocket upgrades from the dashboard.
  // ------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      // index.ts verifies the human session cookie BEFORE forwarding the
      // upgrade here, and passes the verified username in this header --
      // the DO never trusts a client-supplied identity for anything.
      const username = request.headers.get("X-WAY-Username");
      return this.handleWebSocketUpgrade(username);
    }

    if (url.pathname === "/ingest" && request.method === "POST") {
      const body = (await request.json()) as IngestBody;
      await this.handleIngest(body);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/chat" && request.method === "POST") {
      const body = (await request.json()) as { sender: string; message: string };
      this.handleChatMessage(body.sender, body.message);
      return new Response(null, { status: 204 });
    }

    // System chat message posted by a SIBLING MODULE (Sompitra's
    // expense/income/kine events), so the household's one chat carries every
    // activity, not just
    // WAY's geofence arrivals. Always attributed to "nobody" (sender null) and
    // flagged is_auto, so it renders as a centred system row exactly like
    // WAY's own "📍 arrived at Home" lines.
    //
    // The sender is deliberately NOT accepted from the request body: a system
    // message must never be able to masquerade as a person's message.
    if (url.pathname === "/system-chat" && request.method === "POST") {
      const body = (await request.json()) as {
        message?: string;
        eventType?: string;
        gpsTimestamp?: string;
      };
      const text = (body.message ?? "").trim();
      const eventType = body.eventType ?? "";
      if (!text || !EXTERNAL_SYSTEM_EVENTS.includes(eventType)) {
        return new Response(
          JSON.stringify({ error: true, message: `Expected a message and eventType one of: ${EXTERNAL_SYSTEM_EVENTS.join(", ")}` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      this.handleChatMessage(null, text, {
        isAuto: true,
        eventType,
        gpsTimestamp: body.gpsTimestamp ?? null,
      });
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/flush" && request.method === "POST") {
      try {
        const result = await this.flushToD1();
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        // Always return JSON even on failure, so callers (the manual flush
        // endpoint, or the cron's log line) can see WHAT failed.
        return new Response(
          JSON.stringify({ error: true, message: e instanceof Error ? e.message : "Flush failed" }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    if (url.pathname === "/reload-geofences" && request.method === "POST") {
      await this.reloadGeofences();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/reload-notifications" && request.method === "POST") {
      this.notifyCache = null;
      return new Response(null, { status: 204 });
    }

    // Diagnostic probe (reachable only via the Worker's /api/debug/notify):
    // reports this instance's build marker and exactly what it has cached,
    // so we can tell "stale code" from "stale config" without a live tail.
    if (url.pathname === "/debug-notify" && request.method === "GET") {
      const cfg = await this.getNotifyConfig();
      return new Response(
        JSON.stringify(
          {
            // Bump this whenever the DO's own code changes. Durable Objects are
            // NOT replaced by a plain deploy in the way a Worker is: an
            // instance can keep running older code until it is evicted, so
            // "did my DO change actually take effect?" is a real question --
            // especially at cutover. GET /way/api/debug/notify answers it.
            // v3 = accepts /system-chat (Sompitra's activity in the chat).
            // v4 = splits that into expense/income so they read differently.
            build: "notify-v4-expense-income",
            // The event types this DO will accept from sibling modules, straight
            // from the allowlist. Reported here so a test (or a human) can ask
            // "does the RUNNING instance know about income yet?" without
            // relying on a version string staying greppable forever.
            systemChatEvents: EXTERNAL_SYSTEM_EVENTS,
            // Effective publish target, plus WHICH layer supplied it, so
            // "I changed the setting but pushes still fail" is answerable
            // without a live tail.
            server: cfg.server.url,
            serverSource: cfg.server.source,
            serverFromEnv: this.env.NTFY_URL ?? null,
            cacheWasLoaded: this.notifyCache !== null,
            users: cfg.users.map((u) => ({
              id: u.id, username: u.username, topic: u.topic, quiet: `${u.quietStart}-${u.quietEnd}`,
            })),
            subsCount: cfg.subs.length,
            subs: cfg.subs,
            // Per-event-type recipient counts: an event type with 0 here can
            // never fire, which is exactly how "Entry timer" silently did
            // nothing (nobody had ticked it).
            subscribedEventTypes: NOTIFY_EVENT_TYPES.map((t) => ({
              eventType: t,
              recipients: cfg.subs.filter((s) => s.eventType === t).length,
            })),
            lastNotify: this.lastNotify,
            cooldowns: Array.from(this.notifyCooldowns.entries()),
          },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  }

  // ------------------------------------------------------------
  //  WebSocket handling (hibernatable -- idle dashboard connections
  //  don't burn DO duration while nothing is happening)
  // ------------------------------------------------------------
  private handleWebSocketUpgrade(username: string | null): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    // Hibernatable sockets lose ordinary closure state when hibernated --
    // serializeAttachment persists small metadata across hibernation, so
    // webSocketMessage can still recover which human this socket belongs
    // to later, without trusting whatever the client claims per-message.
    server.serializeAttachment({ username });
    // Tell this socket WHO it is: chat identity is fixed at connect time
    // from the session (stamped into the attachment above), so a client
    // whose local app user differs from its WAY session can still render
    // "mine" and react as the account the DO will actually stamp with.
    // Additive field -- older dashboards ignore unknown snapshot keys.
    server.send(JSON.stringify({ ...this.buildSnapshot(), you: username }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Full current state for every device the DO has ever heard from,
   * plus TODAY's not-yet-flushed track points and recent chat scrollback
   * (including today's not-yet-synced messages) -- sent once, immediately
   * on connect. This is what actually fixes the old dashboard's "reverts
   * to early-morning position" bug: there is no date filter anywhere in
   * this query, so there's no midnight boundary for a stale position to
   * hide behind. It also solves a gap /api/history can't: D1 only ever
   * has yesterday-and-earlier data (populated once daily by the midnight
   * flush), so today's route-so-far only exists here, in pending_sync. */
  private buildSnapshot(): {
    type: "snapshot";
    devices: Record<string, LiveDeviceStatus | null>;
    tracks: Record<string, unknown[]>;
    chat: unknown[];
  } {
    const rows = this.sql.exec<{ device_id: string; state_json: string }>(`SELECT device_id, state_json FROM device_state`).toArray();
    const devices: Record<string, LiveDeviceStatus | null> = {};
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.state_json) as Partial<StoredDeviceState>;
        devices[row.device_id] = parsed.lastStatus ?? null;
      } catch {
        devices[row.device_id] = null;
      }
    }

    const trackRows = this.sql.exec(`SELECT * FROM pending_sync ORDER BY device_id, id`).toArray() as any[];
    const tracks: Record<string, unknown[]> = {};
    for (const t of trackRows) {
      (tracks[t.device_id] ??= []).push(t);
    }

    const chat = this.sql
      .exec(`SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT 60`)
      .toArray()
      .reverse();

    return { type: "snapshot", devices, tracks, chat };
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Dashboard -> server messages: chat, and the two device-control
    // toggles (forced driving/walking mode, pause recording). Both
    // controls are meant to live behind a menu, not the main dashboard
    // view -- that's a frontend placement decision, doesn't affect this
    // handler.
    if (typeof message !== "string") return;
    try {
      const data = JSON.parse(message);
      const attachment = ws.deserializeAttachment() as { username: string | null } | null;

      if (data?.type === "chat" && typeof data.message === "string") {
        // Sender is ALWAYS the verified identity attached at connect time,
        // never whatever the client puts in the message -- a browser
        // console can't impersonate the other household member.
        const text = data.message.trim();
        if (!text) return; // an empty bubble is never worth storing
        // Only the reply's TARGET ID is taken from the client; the quoted
        // sender/snippet are resolved from our own scrollback inside
        // handleChatMessage, so the quote can't be forged.
        const replyToId = typeof data.replyToId === "string" && data.replyToId ? data.replyToId : null;
        this.handleChatMessage(attachment?.username ?? null, text, { replyToId });
        return;
      }

      // Chat reactions: { type: "chat-react", id, emoji }. The reactor is the
      // socket's verified identity (same rule as chat senders) and the emoji
      // must be in the fixed set -- both validated again inside
      // handleReaction. Unknown ids fall through silently there; anything
      // malformed lands here and is ignored, exactly like the other frames.
      if (
        data?.type === "chat-react" &&
        typeof data.id === "string" &&
        typeof data.emoji === "string"
      ) {
        this.handleReaction(attachment?.username ?? null, data.id, data.emoji);
        return;
      }

      if (
        data?.type === "setForcedMode" &&
        typeof data.deviceId === "string" &&
        (data.mode === "driving" || data.mode === "walking" || data.mode === null)
      ) {
        this.setForcedMode(data.deviceId, data.mode as ForcedMode);
        return;
      }

      if (
        data?.type === "setRecordingPaused" &&
        typeof data.deviceId === "string" &&
        typeof data.paused === "boolean"
      ) {
        this.setRecordingPaused(data.deviceId, data.paused);
        return;
      }
    } catch {
      // Malformed client message -- ignore rather than crash the socket.
    }
  }

  /** Manual driving/walking lock -- takes effect on the very next ping.
   * Deliberately never auto-clears: a person who sets "walking" while
   * carrying the phone stays walking until they turn it off. */
  private setForcedMode(deviceId: string, mode: ForcedMode) {
    const stored = this.loadDeviceState(deviceId);
    stored.forcedMode = mode;
    this.saveDeviceState(deviceId, stored);
    this.broadcast({ type: "deviceControlState", deviceId, forcedMode: mode, recordingPaused: stored.recordingPaused });
  }

  /** Pause/resume history persistence. Live position and device_state
   * keep updating regardless -- only pending_sync writes are gated. */
  private setRecordingPaused(deviceId: string, paused: boolean) {
    const stored = this.loadDeviceState(deviceId);
    stored.recordingPaused = paused;
    this.saveDeviceState(deviceId, stored);
    this.broadcast({ type: "deviceControlState", deviceId, forcedMode: stored.forcedMode, recordingPaused: paused });
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    // Hibernation/runtime handles socket cleanup. Handler must still be
    // implemented for the hibernatable WebSocket API contract.
  }

  private broadcast(payload: Record<string, unknown>) {
    const msg = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // A dead socket is cleaned up by the runtime -- don't let one
        // bad client break the broadcast to everyone else.
      }
    }
  }

  // ------------------------------------------------------------
  //  Ping ingestion pipeline
  // ------------------------------------------------------------
  private async handleIngest(body: IngestBody) {
    const { ping, accuracy, altitude } = body;
    const stored = this.loadDeviceState(ping.deviceId);

    // ---- Glitch pre-filter, using the last known raw position ----
    if (
      stored.motion.lastLat !== null &&
      stored.motion.lastLon !== null &&
      stored.motion.lastTs !== null &&
      isGlitch(
        stored.motion.lastLat, stored.motion.lastLon, stored.motion.lastTs,
        ping.latitude, ping.longitude, ping.timestamp
      )
    ) {
      return; // dropped silently, same as the Python receiver
    }

    const geofences = await this.getGeofences();
    const { state: newMotion, result } = processPing(stored.motion, ping, geofences, stored.forcedMode);

    // If the device just crossed a fence's exit radius, start the outgoing
    // track AT the boundary instead of the first ping past it.
    if (result.edgePoint) {
      this.handleEdgePoint(ping.deviceId, result.edgePoint, ping, result, altitude, accuracy, stored.recordingPaused);
    }

    // ---- Exit-guard buffer -------------------------------------------------
    // Pings during the 30s exit guard are HELD: not persisted and not drawn
    // live. On the confirmed exit they are flushed in order (edge point, then
    // these, then the confirming ping), so the outgoing track follows the real
    // path from the fence edge instead of jumping straight to the first
    // post-confirmation ping. A bounce-back discards them -- which is what
    // keeps GPS jitter from leaving spurs behind.
    let exitBuffer = stored.exitBuffer;
    if (newMotion.geoState === "EXITING") {
      exitBuffer = exitBuffer.concat([{
        timestamp: ping.timestamp,
        latitude: ping.latitude,
        longitude: ping.longitude,
        altitude,
        speed: ping.vel ?? null,
        speedAvg: result.speedAvg,
        isDriving: result.isDriving,
        distance: result.distance,
        legId: result.legId ?? null,
        accuracy,
      }]);
      if (exitBuffer.length > EXIT_BUFFER_MAX) exitBuffer = exitBuffer.slice(exitBuffer.length - EXIT_BUFFER_MAX);
    } else if (result.edgePoint) {
      // Exit just confirmed. The edge point was already written above, so the
      // held pings go in next, in order, ahead of the confirming ping.
      if (!stored.recordingPaused) this.flushExitBuffer(ping.deviceId, exitBuffer);
      exitBuffer = [];
    } else if (newMotion.geoState === "CONFIRMED_INSIDE") {
      exitBuffer = []; // bounced back inside (or never left) -- nothing to keep
    }

    // ---- stationary / moving events (push notification only, never chat) ----
    // Only fires outside a geofence: inside one the status is "at <place>",
    // which is what the entry/exit events already cover.
    if (stored.lastStatus) {
      const wasStationary = stored.lastStatus.isStationary === true;
      const isStationaryNow = result.isStationary === true;
      if (!wasStationary && isStationaryNow) {
        console.log(`event ${ping.deviceId}: stationary`);
        this.ctx.waitUntil(this.notifyStationary(ping.deviceId, ping.latitude, ping.longitude));
      } else if (wasStationary && !isStationaryNow) {
        console.log(`event ${ping.deviceId}: moving`);
        this.ctx.waitUntil(
          this.notifyEvent(ping.deviceId, "moving", `${ping.deviceId} is now moving`, "Moving again", "")
        );
      }
    }

    // ---- "Entry timer": 60s / 30s from a Home fence, while driving at it ----
    this.maybeNotifyApproach(ping, stored.motion, result, geofences);

    // recordingPaused overrides everything else -- no history writes at all
    // while paused.
    const shouldPersist = !stored.recordingPaused && this.shouldPersistTrackPoint(result);

    // device_state updates on every ping regardless of the throttle or
    // the pause flag -- it's a single UPSERT row, not a growing table,
    // so there's no storage cost to always keeping it current, and the
    // live dot must keep moving even while paused: pause hides HISTORY,
    // never the live position.
    const lastStatus: LiveDeviceStatus = {
      ...result,
      timestamp: ping.timestamp,
      latitude: ping.latitude,
      longitude: ping.longitude,
      speed: ping.vel ?? null,
    };
    this.saveDeviceState(ping.deviceId, {
      motion: newMotion,
      forcedMode: stored.forcedMode,
      recordingPaused: stored.recordingPaused,
      lastStatus,
      exitBuffer,
    });

    if (shouldPersist) {
      this.sql.exec(
        `INSERT INTO pending_sync
          (device_id, timestamp, latitude, longitude, altitude, speed, speed_avg_30s,
           is_inside_geofence, geofence_name, is_driving, distance_km, is_stationary,
           is_keep_alive, battery, accuracy, leg_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ping.deviceId, ping.timestamp, ping.latitude, ping.longitude, altitude,
        ping.vel ?? null, result.speedAvg, result.isInside ? 1 : 0, result.geofenceName,
        result.isDriving ? 1 : 0, result.distance, result.isStationary ? 1 : 0,
        0, null, accuracy, result.legId ?? null
      );
    }

    this.maybeLogGeofenceEvent(ping.deviceId, stored.motion, newMotion, result, ping.timestamp);

    // Live broadcast fires on every raw ping, unthrottled -- this is
    // what makes the dashboard dot move smoothly. Separate decision from
    // what gets persisted to track history above. Includes raw `speed`
    // (instantaneous, from the device) alongside `speedAvg` (the state
    // machine's smoothed classification input) -- the dashboard's big
    // speedometer number wants the former, not the latter.
    this.broadcast({
      type: "position",
      deviceId: ping.deviceId,
      timestamp: ping.timestamp,
      latitude: ping.latitude,
      longitude: ping.longitude,
      speed: ping.vel ?? null,
      // The frontend must move the live dot but NOT add this to the track --
      // during the guard the point is held in exitBuffer and drawn later.
      guarding: newMotion.geoState === "EXITING",
      ...result,
    });
  }

  /** Writes + broadcasts the pings held during the exit guard, in order.
   * Broadcast as `track`, not `position`: these are OLDER than the live dot's
   * current position, so they must never move the marker. */
  private flushExitBuffer(deviceId: string, buffer: BufferedPing[]) {
    for (const p of buffer) {
      this.sql.exec(
        `INSERT INTO pending_sync
          (device_id, timestamp, latitude, longitude, altitude, speed, speed_avg_30s,
           is_inside_geofence, geofence_name, is_driving, distance_km, is_stationary,
           is_keep_alive, battery, accuracy, leg_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        deviceId, p.timestamp, p.latitude, p.longitude, p.altitude,
        p.speed, p.speedAvg, 0, null, p.isDriving ? 1 : 0,
        p.distance, 0, 0, null, p.accuracy, p.legId
      );
      this.broadcast({
        type: "track",
        deviceId,
        timestamp: p.timestamp,
        latitude: p.latitude,
        longitude: p.longitude,
        speed: p.speed,
        // Deliberately outside: the device HAS crossed the exit radius. The
        // state machine reports isInside=true during the guard only so the
        // exit event fires correctly, which is not a track concern.
        isInside: false,
        geofenceName: null,
        isDriving: p.isDriving,
        speedAvg: p.speedAvg,
        distance: p.distance,
        isStationary: false,
        legId: p.legId,
      });
    }
  }

  /** Persists + broadcasts a synthetic point at a fence-edge crossing, so
   * the outgoing track starts AT the boundary rather than at the first raw
   * ping past it (which can be ~100m out at driving speed). */
  private handleEdgePoint(
    deviceId: string,
    edge: { latitude: number; longitude: number; timestamp: string; isDriving: boolean },
    ping: RawPing,
    result: PingResult,
    altitude: number | null,
    accuracy: number | null,
    recordingPaused: boolean
  ) {
    const speed = ping.vel ?? result.speedAvg;
    if (!recordingPaused) {
      this.sql.exec(
        `INSERT INTO pending_sync
          (device_id, timestamp, latitude, longitude, altitude, speed, speed_avg_30s,
           is_inside_geofence, geofence_name, is_driving, distance_km, is_stationary,
           is_keep_alive, battery, accuracy, leg_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        deviceId, edge.timestamp, edge.latitude, edge.longitude, altitude,
        speed, result.speedAvg, 0, null, edge.isDriving ? 1 : 0,
        0, 0, 0, null, accuracy, result.legId ?? null
      );
    }
    this.broadcast({
      type: "track",
      deviceId,
      timestamp: edge.timestamp,
      latitude: edge.latitude,
      longitude: edge.longitude,
      speed,
      isInside: false,
      geofenceName: null,
      isDriving: edge.isDriving,
      speedAvg: result.speedAvg,
      distance: 0,
      isStationary: false,
    });
  }

  /** What becomes long-term history.
   *
   * Driven AND walked points outside a fence are kept; stationary and
   * inside-fence pings still carry no track information and are dropped (a
   * phone on a desk indoors emits a ping every few seconds all day, and
   * storing those would bury the real journeys in noise).
   *
   * This MUST stay in step with the dashboard's shouldDrawPoint()
   * (public/way/index.html), which applies the identical rule when it rebuilds
   * today's track from the snapshot. When it was narrower than the frontend
   * (driving only), a walked track drew live, then vanished on refresh --
   * because it had never been written to pending_sync in the first place.
   *
   * Walking is history, but NOT distance: the dashboard only accumulates
   * today's/monthly totals from rows with is_driving = 1. Walking points are
   * stored with distance 0 anyway (see computeDriving in lib/state-machine.ts).
   * See docs/ARCHITECTURE.md, "Persistence policy". */
  private shouldPersistTrackPoint(result: PingResult): boolean {
    return !result.isInside && !result.isStationary;
  }

  /** Looks up a geofence's friendly display_name from the already-cached
   * geofence list (see getGeofences()) -- falls back to the raw name if
   * somehow not found, rather than showing nothing. */
  private displayNameFor(geofenceName: string | null): string {
    if (!geofenceName) return "a location";
    const match = this.geofenceCache?.find((f) => f.name === geofenceName);
    return match?.displayName ?? geofenceName;
  }

  private maybeLogGeofenceEvent(
    deviceId: string,
    prior: MotionState,
    next: MotionState,
    result: PingResult,
    timestamp: string
  ) {
    // "arrived" only on a CONFIRMED entry (OUTSIDE -> CONFIRMED_INSIDE), and
    // "left" only on a CONFIRMED exit (EXITING -> OUTSIDE). The intermediate
    // CONFIRMED_INSIDE <-> EXITING transitions are just hysteresis wiggle and
    // must NOT emit events -- that was what caused ghost "left"/"arrived"
    // pairs from GPS jitter near the fence boundary.
    if (prior.geoState === "OUTSIDE" && next.geoState === "CONFIRMED_INSIDE") {
      const place = this.displayNameFor(result.geofenceName);
      console.log(`event ${deviceId}: entry (${place})`);
      this.handleChatMessage(null, `${deviceId} arrived at ${place}`, {
        deviceId, isAuto: true, eventType: "arrived", gpsTimestamp: timestamp,
      });
      this.ctx.waitUntil(
        this.notifyEvent(deviceId, "entry", `${deviceId} arrived at ${place}`, `Arrived at ${place}`, place)
      );
    } else if (prior.geoState === "EXITING" && next.geoState === "OUTSIDE" && prior.lastGeofenceName) {
      const place = this.displayNameFor(prior.lastGeofenceName);
      console.log(`event ${deviceId}: exit (${place})`);
      this.handleChatMessage(null, `${deviceId} left ${place}`, {
        deviceId, isAuto: true, eventType: "left", gpsTimestamp: timestamp,
      });
      this.ctx.waitUntil(
        this.notifyEvent(deviceId, "exit", `${deviceId} left ${place}`, `Left ${place}`, place)
      );
    }
  }

  // ------------------------------------------------------------
  //  Chat
  // ------------------------------------------------------------
  private handleChatMessage(
    sender: string | null,
    message: string,
    opts: {
      deviceId?: string | null;
      isAuto?: boolean;
      eventType?: string | null;
      gpsTimestamp?: string | null;
      replyToId?: string | null;
    } = {}
  ) {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // Reply linkage is resolved from OUR scrollback, never from whatever the
    // client claims to be quoting -- otherwise a browser console could forge a
    // quote attributed to the other household member. An id we no longer hold
    // (or one that never existed) degrades silently to a normal message rather
    // than rendering a dangling quote.
    let replyToId: string | null = null;
    let replyToSender: string | null = null;
    let replyToSnippet: string | null = null;
    if (opts.replyToId) {
      const rows = this.sql
        .exec<{ sender: string | null; message: string }>(
          `SELECT sender, message FROM chat_messages WHERE id = ?`,
          opts.replyToId
        )
        .toArray();
      if (rows.length > 0) {
        replyToId = opts.replyToId;
        replyToSender = rows[0].sender ?? "System";
        replyToSnippet = rows[0].message.slice(0, REPLY_SNIPPET_MAX_CHARS);
      }
    }

    this.sql.exec(
      `INSERT INTO chat_messages
         (id, sender, device_id, message, is_auto, event_type, gps_timestamp, created_at, synced,
          reply_to_id, reply_to_sender, reply_to_snippet)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      id, sender, opts.deviceId ?? null, message, opts.isAuto ? 1 : 0,
      opts.eventType ?? null, opts.gpsTimestamp ?? null, createdAt,
      replyToId, replyToSender, replyToSnippet
    );
    this.broadcast({
      type: "chat", id, sender, deviceId: opts.deviceId ?? null, message,
      isAuto: !!opts.isAuto, eventType: opts.eventType ?? null, createdAt,
      replyToId, replyToSender, replyToSnippet,
      // A fresh message has no reactions yet; the fields exist so clients can
      // treat live frames and snapshot rows identically.
      reactions: null, reactionUsers: null, reactionUpdatedAt: null,
    });

    // Human chat pushes a notification (title = sender, body = the full
    // message so expanding the notification shows the content). Auto
    // geofence events are notified as entry/exit, never as chat.
    if (sender && !opts.isAuto) {
      this.ctx.waitUntil(this.notifyEvent(sender, "chat", sender, message, ""));
    }
  }

  /**
   * Toggle a reaction on a chat message (👍🤣💖). WhatsApp semantics: one
   * reaction per user per message -- tapping a different emoji replaces
   * theirs, tapping the same emoji removes it. The reactor comes from the
   * socket's verified attachment, never from the payload (same rule as chat
   * senders), and the emoji is validated against the fixed set here again.
   *
   * The message must still exist in the DO's scrollback -- reactions are
   * live state, so an unknown/flushed-out id is simply ignored (snapshot
   * rows already carry whatever reactions the message had).
   *
   * Deliberately NO notification: reactions are cosmetic, and the notify
   * pipeline is the one seam between chat and tracking that must stay
   * untouched from the chat side. Also deliberately no cache: chat volume
   * is tiny, and a read-modify-write per toggle is simpler than invalidating.
   * Concurrency is a non-issue -- DO SQLite exec is synchronous and this is
   * the single DO instance, so the read-modify-write cannot interleave.
   */
  private handleReaction(reactor: string | null, messageId: string, emoji: string) {
    if (!reactor || !messageId || !REACTION_EMOJIS.includes(emoji)) return;
    try {
      const rows = this.sql
        .exec<{ reactions: string | null; reaction_users: string | null }>(
          `SELECT reactions, reaction_users FROM chat_messages WHERE id = ?`,
          messageId
        )
        .toArray();
      if (rows.length === 0) return;

      // Existing state, tolerating rows written before this feature (NULL
      // columns) and malformed JSON (treated as empty rather than throwing --
      // a broken reaction map must never be able to break the toggle).
      let users: Record<string, string> = {};
      try { users = rows[0].reaction_users ? JSON.parse(rows[0].reaction_users) : {}; } catch { users = {}; }

      // Toggle per user: same emoji removes, a different emoji replaces.
      const previous = users[reactor];
      if (previous === emoji) delete users[reactor];
      else users[reactor] = emoji;

      // Counts are always rebuilt from the users map -- one source of truth,
      // so the two JSON columns can never drift apart.
      const counts: Record<string, number> = {};
      for (const u of Object.keys(users)) {
        const e = users[u];
        counts[e] = (counts[e] ?? 0) + 1;
      }

      const now = new Date().toISOString();
      this.sql.exec(
        `UPDATE chat_messages SET reactions = ?, reaction_users = ?, reaction_updated_at = ? WHERE id = ?`,
        JSON.stringify(counts), JSON.stringify(users), now, messageId
      );

      // Broadcast the post-toggle state to every dashboard -- Sompitra's chat
      // page included, it is the same socket. Empty maps go out as null so
      // clients render "no reactions" instead of an empty pill.
      this.broadcast({
        type: "chatReactions",
        id: messageId,
        reactions: Object.keys(counts).length ? counts : null,
        reactionUsers: Object.keys(users).length ? users : null,
        reactionUpdatedAt: now,
      });
    } catch {
      // A failed reaction must never be able to break the socket loop.
    }
  }

  // ------------------------------------------------------------
  //  Device state persistence (synchronous -- DO SQLite exec is sync,
  //  unlike D1's async API)
  // ------------------------------------------------------------
  private loadDeviceState(deviceId: string): StoredDeviceState {
    const rows = this.sql
      .exec<{ state_json: string }>(`SELECT state_json FROM device_state WHERE device_id = ?`, deviceId)
      .toArray();
    const row = rows.length > 0 ? rows[0] : null;
    if (!row) {
      return {
        motion: initialMotionState(),
        forcedMode: null,
        recordingPaused: false,
        lastStatus: null,
        exitBuffer: [],
      };
    }
    // Old rows saved before these fields existed won't have them --
    // default rather than leaving undefined.
    const parsed = JSON.parse(row.state_json) as Partial<StoredDeviceState> & { motion: MotionState };
    return {
      motion: parsed.motion,
      forcedMode: parsed.forcedMode ?? null,
      recordingPaused: parsed.recordingPaused ?? false,
      lastStatus: parsed.lastStatus ?? null,
      exitBuffer: parsed.exitBuffer ?? [],
    };
  }

  private saveDeviceState(deviceId: string, state: StoredDeviceState) {
    this.sql.exec(
      `INSERT INTO device_state (device_id, state_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      deviceId, JSON.stringify(state), new Date().toISOString()
    );
  }

  // ------------------------------------------------------------
  //  Geofence cache -- loaded from D1, cached for the DO's lifetime and
  //  invalidated by the /reload-geofences route (called by the Worker
  //  after any geofence CRUD). See reloadGeofences() below.
  // ------------------------------------------------------------
  private async getGeofences(): Promise<Geofence[]> {
    if (this.geofenceCache) return this.geofenceCache;
    const { results } = await this.env.WAY_DB.prepare("SELECT * FROM geofences").all<GeofenceRow>();
    this.geofenceCache = results.map((r) => ({
      name: r.name,
      displayName: r.display_name,
      category: r.category,
      lat: r.lat,
      lon: r.lon,
      radiusM: r.radius_m,
      exitRadiusM: r.exit_radius_m,
    }));
    return this.geofenceCache;
  }

  /** Re-fetch geofences from D1 and invalidate the in-memory cache. Called
   * by the Worker after any geofence create/update/delete so a change takes
   * effect immediately, without waiting for a DO eviction/redeploy. Also
   * sweeps device_state: a device that was CONFIRMED_INSIDE a now-deleted
   * fence is reset to OUTSIDE so it doesn't hang inside a ghost fence. */
  private async reloadGeofences(): Promise<void> {
    this.geofenceCache = null;
    const fences = await this.getGeofences();
    const names = new Set(fences.map((f) => f.name));

    const rows = this.sql
      .exec<{ device_id: string; state_json: string }>(`SELECT device_id, state_json FROM device_state`)
      .toArray();
    for (const row of rows) {
      try {
        const st = JSON.parse(row.state_json) as StoredDeviceState;
        const inside = st.motion.geoState === "CONFIRMED_INSIDE" || st.motion.geoState === "EXITING";
        if (inside && st.motion.lastGeofenceName && !names.has(st.motion.lastGeofenceName)) {
          st.motion.geoState = "OUTSIDE";
          st.motion.lastGeofenceName = null;
          st.motion.exitStartTime = null;
          st.motion.entryStartTime = null;
          st.motion.pendingFenceName = null;
          if (st.lastStatus) {
            st.lastStatus.isInside = false;
            st.lastStatus.geofenceName = null;
          }
          this.saveDeviceState(row.device_id, st);
        }
      } catch {
        // Unreadable state_json -- leave it; the next ping will re-init.
      }
    }
  }

  // ------------------------------------------------------------
  //  Push notifications (ntfy.sh)
  //  Each user owns ONE random topic, and their phone follows only that
  //  topic. The subscription grid decides what is routed into it, so the
  //  sorting happens here -- never in the receiving app.
  // ------------------------------------------------------------
  private async getNotifyConfig() {
    if (this.notifyCache) return this.notifyCache;
    const { results: users } = await this.env.WAY_DB
      .prepare("SELECT id, username, ntfy_topic, quiet_start, quiet_end FROM users")
      .all<{ id: number; username: string; ntfy_topic: string | null; quiet_start: number | null; quiet_end: number | null }>();
    const { results: subs } = await this.env.WAY_DB
      .prepare("SELECT subscriber_id, source_id, event_type FROM notification_subs")
      .all<{ subscriber_id: number; source_id: number; event_type: string }>();

    // The CHANNEL belongs to the person and lives in home-db
    // (users.ntfy_topic) — see migrations-home/0002. way-db's own column is
    // the pre-merge copy and is now only a FALLBACK, so a deployment that has
    // not adopted the channels yet still notifies. Reading home-db here is
    // what keeps one phone = one topic: without it, WAY activity would keep
    // going to way-db's stale topic while Sompitra used the new one.
    // Keyed for EVERY active home user, including those with no channel: a
    // person who TURNED THEIR CHANNEL OFF must stay off, so the way-db
    // fallback below is only for people home-db has never heard of (i.e. the
    // migration has not run), never for an explicit "no channel".
    const homeChannels = new Map<string, string | null>();
    let homeServerUrl: string | null = null;
    try {
      const { results: channels } = await this.env.HOME_DB
        .prepare("SELECT lower(username) AS u, ntfy_topic FROM users WHERE is_active = 1")
        .all<{ u: string; ntfy_topic: string | null }>();
      for (const row of channels ?? []) homeChannels.set(row.u, row.ntfy_topic || null);
      const setting = await this.env.HOME_DB
        .prepare("SELECT value FROM home_settings WHERE key = ?")
        .bind(NTFY_SERVER_HOME_KEY)
        .first<{ value: string }>();
      homeServerUrl = setting?.value ? normalizeNtfyServer(setting.value) : null;
    } catch {
      // No home-db yet (or migration 0002 not applied): fall back to way-db.
      homeServerUrl = null;
    }

    // Admin-set server root wins over the wrangler var, which wins over the
    // built-in default. Wrapped because app_settings only exists once
    // migration 0005 has been applied -- a DO that starts before that must
    // still load its users and subs rather than failing the whole cache.
    let settingUrl: string | null = null;
    try {
      const row = await this.env.WAY_DB
        .prepare("SELECT value FROM app_settings WHERE key = ?")
        .bind(NTFY_URL_SETTING_KEY)
        .first<{ value: string }>();
      settingUrl = row?.value ? normalizeNtfyServer(row.value) : null;
    } catch {
      settingUrl = null;
    }
    const envUrl = this.env.NTFY_URL ? normalizeNtfyServer(this.env.NTFY_URL) : null;
    const server: { url: string; source: "setting" | "env" | "default" } = homeServerUrl
      ? { url: homeServerUrl, source: "setting" }
      : settingUrl
        ? { url: settingUrl, source: "setting" }
        : envUrl
          ? { url: envUrl, source: "env" }
          : { url: DEFAULT_NTFY_URL, source: "default" };

    this.notifyCache = {
      users: users.map((u) => ({
        id: u.id, username: u.username,
        topic: homeChannels.has(u.username.toLowerCase())
          ? homeChannels.get(u.username.toLowerCase()) ?? null
          : u.ntfy_topic,
        quietStart: u.quiet_start ?? 22, quietEnd: u.quiet_end ?? 6,
      })),
      subs: subs.map((s) => ({ subscriberId: s.subscriber_id, sourceId: s.source_id, eventType: s.event_type })),
      server,
    };
    return this.notifyCache;
  }

  /** Routes one event to every subscriber who asked for it. Never throws --
   * a ntfy outage must not be able to affect tracking. `cooldownKey` scopes
   * the cooldown (the geofence name for entry/exit, "" otherwise). */
  private async notifyEvent(
    sourceUsername: string,
    eventType: NotifyEventType,
    title: string,
    body: string,
    cooldownKey: string
  ): Promise<void> {
    // Every step records here as well as to the log, so /debug-notify can
    // report the LAST routing decision without needing a live tail.
    const note = (outcome: string) => {
      this.lastNotify = { at: new Date().toISOString(), source: sourceUsername, type: eventType, outcome };
      console.log(`notify[${eventType}] ${sourceUsername}: ${outcome}`);
    };
    try {
      const cfg = await this.getNotifyConfig();
      const source = cfg.users.find((u) => u.username === sourceUsername);
      if (!source) {
        note(`no such user (users=${cfg.users.length})`);
        return;
      }

      const now = Date.now();
      const key = `${source.id}:${eventType}:${cooldownKey}`;
      // Chat is deliberately EXEMPT from the cooldown: every message is typed
      // by a person and matters. The daily cap below still applies to it.
      if (eventType !== "chat") {
        const sinceLast = now - (this.notifyCooldowns.get(key) ?? 0);
        if (sinceLast < NOTIFY_COOLDOWN_MS) {
          note(`cooldown (${Math.round(sinceLast / 1000)}s since last)`);
          return;
        }
      }

      const day = new Date(now + TZ_OFFSET_MS).toISOString().slice(0, 10);
      const daily = this.notifyDaily.get(String(source.id));
      const usedToday = daily && daily.day === day ? daily.count : 0;
      if (usedToday >= NOTIFY_DAILY_CAP) {
        note(`daily cap (${usedToday})`);
        return;
      }

      const recipients = cfg.subs.filter((s) => s.sourceId === source.id && s.eventType === eventType);
      if (recipients.length === 0) {
        note(`no subscribers (sourceId=${source.id}, totalSubs=${cfg.subs.length}, users=${cfg.users.length})`);
        return;
      }

      this.notifyCooldowns.set(key, now);
      this.notifyDaily.set(String(source.id), { day, count: usedToday + 1 });

      const baseUrl = cfg.server.url;
      for (const sub of recipients) {
        const u = cfg.users.find((x) => x.id === sub.subscriberId);
        if (!u) {
          note(`subscriber id ${sub.subscriberId} missing`);
          continue;
        }
        if (!u.topic) {
          note(`${u.username} has no topic`);
          continue;
        }
        // Quiet hours: ONLY chat gets through.
        if (eventType !== "chat" && inQuietHours(u.quietStart, u.quietEnd, now)) {
          note(`quiet hours for ${u.username} (${u.quietStart}-${u.quietEnd})`);
          continue;
        }
        note(`publishing to ${u.username} (topic=${u.topic})`);
        this.ctx.waitUntil(
          publishNtfy({ topic: u.topic, title, body, tag: EVENT_TAGS[eventType] }, baseUrl, this.env.NTFY_TOKEN).then((ok) => {
            note(`${u.username}: ${ok ? "published" : "PUBLISH FAILED"}`);
          })
        );
      }
    } catch (e) {
      note(`ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** "Entry timer": while a device is driving TOWARD a category="Home" fence,
   * announce the countdown once at 60s and again at 30s out. Re-arms when the
   * device turns away, and resets on arrival so the next trip announces again.
   * Purely notification-side -- it never touches the state machine or tracks. */
  private maybeNotifyApproach(ping: RawPing, prior: MotionState, result: PingResult, geofences: Geofence[]) {
    // Arriving (or sitting at) a fence clears the countdown.
    if (result.isInside) {
      this.approachFired.delete(ping.deviceId);
      return;
    }
    const speedKmh = ping.vel ?? result.speedAvg;
    if (!(speedKmh >= APPROACH_MIN_SPEED_KMH)) return;
    const speedMs = speedKmh / 3.6;

    // Heading taken from the previous position, so we can tell "driving at it"
    // from "driving past it".
    const heading =
      prior.lastLat !== null && prior.lastLon !== null
        ? bearingDegrees(prior.lastLat, prior.lastLon, ping.latitude, ping.longitude)
        : null;

    for (const f of geofences) {
      if ((f.category ?? "").toLowerCase() !== "home") continue;

      const entryRadiusM = f.radiusM || 50;
      const distM = distanceM(ping.latitude, ping.longitude, f.lat, f.lon) - entryRadiusM;
      if (distM <= 0) continue; // already within the entry radius

      const etaSec = distM / speedMs;
      const key = `${ping.deviceId}:${f.name}`;

      // Moving away / too far to matter -> re-arm for the next approach.
      if (etaSec > APPROACH_THRESHOLDS[0]) {
        this.approachFired.delete(key);
        continue;
      }
      if (heading !== null) {
        const toFence = bearingDegrees(ping.latitude, ping.longitude, f.lat, f.lon);
        if (angularDiff(heading, toFence) > APPROACH_MAX_BEARING_DIFF) continue;
      }

      const fired = this.approachFired.get(key) ?? new Set<number>();
      const place = f.displayName || f.name;
      for (const threshold of APPROACH_THRESHOLDS) {
        if (etaSec > threshold || fired.has(threshold)) continue;
        // Consume every looser threshold too, so a sudden jump from 70s to 25s
        // announces once rather than back-filling both.
        for (const t of APPROACH_THRESHOLDS) if (t >= threshold) fired.add(t);
        this.approachFired.set(key, fired);
        const words = threshold >= 60 ? "about a minute" : `${threshold} seconds`;
        this.ctx.waitUntil(
          this.notifyEvent(
            ping.deviceId,
            "approach",
            `${ping.deviceId} ~${threshold}s from ${place}`,
            `Arriving at ${place} in ${words}`,
            `${f.name}:${threshold}`
          )
        );
        break;
      }
      this.approachFired.set(key, fired);
    }
  }

  /** "Stopped at <street, suburb, municipality>" -- geocoded here (not in the
   * browser) because the whole point is notifying while the app is closed. */
  private async notifyStationary(deviceId: string, lat: number, lon: number): Promise<void> {
    const place = await this.reverseGeocodePlace(lat, lon);
    const title = place ? `Stopped at ${place}` : `${deviceId} stopped`;
    const body = place ? `${deviceId} stopped at ${place}` : `${deviceId} stopped`;
    await this.notifyEvent(deviceId, "stationary", title, body, "");
  }

  /** Street name, suburb and municipality only -- no region/state/county. */
  private async reverseGeocodePlace(lat: number, lon: number): Promise<string | null> {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=18&addressdetails=1`,
        { headers: { "User-Agent": "WAY-Dashboard/1.0 (household GPS tracker)" } }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { address?: Record<string, string> };
      const a = data.address ?? {};
      const parts = [a.road, a.suburb, a.municipality || a.city || a.town || a.village].filter(Boolean);
      return parts.length > 0 ? parts.join(", ") : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------
  //  Daily flush to D1 -- called by the Worker's scheduled handler at
  //  local midnight (UTC+3 -- see wrangler.jsonc's cron trigger). Runs at low-
  //  traffic time, keeping the (already very small at this scale) risk
  //  of a new ping landing mid-flush negligible rather than needing
  //  explicit locking.
  // ------------------------------------------------------------
  private async flushToD1(): Promise<{ pingsFlushed: number; messagesFlushed: number }> {
    const pendingPings = this.sql.exec(`SELECT * FROM pending_sync ORDER BY id`).toArray() as any[];
    const pendingMessages = this.sql
      .exec(`SELECT * FROM chat_messages WHERE synced = 0 ORDER BY created_at`)
      .toArray() as any[];

    // Reaction state is snapshotted at flush time: the DO holds the live
    // maps, D1's history row gets whatever the message had at midnight.
    // Late toggles keep working in the DO (their broadcast keeps dashboards
    // current) but history stops updating until the next flush -- accepted,
    // the DO's own scrollback is what clients actually render.

    // D1 caps batch() at 100 statements per call. Flushing everything in
    // ONE batch worked while a day produced <100 points, then silently
    // started failing once a busy day exceeded that -- leaving pending_sync
    // untouched (stale tracks on the map) and gps_pings unpopulated
    // (0 km in history). Chunk at 100, and delete/mark each chunk as it
    // lands so a mid-flush failure never duplicates already-flushed rows.
    const CHUNK = 100;

    for (let i = 0; i < pendingPings.length; i += CHUNK) {
      const chunk = pendingPings.slice(i, i + CHUNK);
      const statements = chunk.map((p) =>
        this.env.WAY_DB.prepare(
          `INSERT INTO gps_pings
            (device_id, timestamp, latitude, longitude, altitude, speed, speed_avg_30s,
             is_inside_geofence, geofence_name, is_driving, distance_km, is_stationary,
             is_keep_alive, battery, accuracy, leg_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          p.device_id, p.timestamp, p.latitude, p.longitude, p.altitude, p.speed,
          p.speed_avg_30s, p.is_inside_geofence, p.geofence_name, p.is_driving,
          p.distance_km, p.is_stationary, p.is_keep_alive, p.battery, p.accuracy,
          p.leg_id ?? null
        )
      );
      await this.env.WAY_DB.batch(statements);
      // Delete only THIS chunk's rows (id <= chunkMaxId). A ping landing
      // during the awaits above gets a higher AUTOINCREMENT id, so it is
      // left for the next flush.
      const chunkMaxId = chunk[chunk.length - 1].id as number;
      this.sql.exec(`DELETE FROM pending_sync WHERE id <= ?`, chunkMaxId);
    }

    for (let i = 0; i < pendingMessages.length; i += CHUNK) {
      const chunk = pendingMessages.slice(i, i + CHUNK);
      const statements = chunk.map((m) =>
        this.env.WAY_DB.prepare(
          `INSERT INTO messages
             (sender, message, gps_timestamp, is_auto, event_type, device_id, created_at,
              reply_to_id, reply_to_sender, reply_to_snippet,
              reactions, reaction_users, reaction_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        // Auto geofence events have sender = null in the DO, but D1's
        // messages.sender is NOT NULL. Map to "System" (the dashboard
        // already renders a null sender as "System"). This NOT NULL
        // violation is what made the whole flush fail before.
        ).bind(
          m.sender ?? "System", m.message, m.gps_timestamp, m.is_auto, m.event_type, m.device_id, m.created_at,
          // Rows written before migration 0006 have no reply columns on the
          // DO side either; `?? null` keeps them out of the NOT NULL path.
          m.reply_to_id ?? null, m.reply_to_sender ?? null, m.reply_to_snippet ?? null,
          // Chat reactions (migration 0007). Stored as the raw JSON strings
          // the DO columns already hold -- null when the message has none.
          m.reactions ?? null, m.reaction_users ?? null, m.reaction_updated_at ?? null
        )
      );
      await this.env.WAY_DB.batch(statements);
      // Mark synced rather than delete -- scrollback stays available to
      // a freshly-connecting dashboard client even after the flush.
      for (const m of chunk) {
        this.sql.exec(`UPDATE chat_messages SET synced = 1 WHERE id = ?`, m.id);
      }
    }

    return { pingsFlushed: pendingPings.length, messagesFlushed: pendingMessages.length };
  }
}
