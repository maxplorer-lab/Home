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
  accuracyIsAcceptable,
  reportedSpeedIsCredible,
  speedFromPositions,
  MotionState,
  RawPing,
  PingResult,
  ForcedMode,
} from "../lib/state-machine";
import { WAY_CONFIG } from "../config";

/** Household ntfy server, in home-db (the unified settings own it). */
const NTFY_SERVER_HOME_KEY = "ntfy_server";

/**
 * This file's build marker. Bump it whenever the DO's own code changes — the
 * debug probe reports it, and `ensureSchema` uses it to decide whether the
 * ingest gate counters still describe THIS code (see the build-scoped reset
 * there). One constant, because those two jobs must never disagree.
 */
const DO_BUILD = "notify-v14-live-share";

/** What the public live-share view is allowed to know about ONE device. Its
 *  narrowness is the feature: no chat, no other device, no totals. */
interface ShareState {
  position: {
    lat: number; lng: number; at: string | null; speed: number | null;
    driving: boolean; stationary: boolean; place: string | null;
  } | null;
  /** [lat, lng, ISO] — today's track, possibly strided (see trackTotal). */
  track: Array<[number, number, string]>;
  trackTotal: number;
  now: number;
}

interface LiveDeviceStatus extends PingResult {
  timestamp: string;
  latitude: number;
  longitude: number;
  speed: number | null; // raw instantaneous speed (km/h) -- distinct from PingResult.speedAvg
  // Device-reported GPS accuracy (m). The intake GATES on it (a fix worse
  // than PRE_FILTER_MAX_ACCURACY_M never reaches here), but nothing else
  // classifies, stores or notifies from it -- it is carried live because the
  // dashboard's HUD health slot falls back to it (µlogger never reports a
  // battery level).
  accuracy: number | null;
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

// Anything above this (km/h) is GPS jitter, in BOTH of the ways the number can
// arrive: a ping whose POSITION implies it is dropped whole by
// state-machine.isGlitch, and one whose REPORTED speed claims it keeps its
// position and loses only the speed field (see handleIngest). One constant
// feeds both halves, so they cannot drift apart.
const PRE_FILTER_SPEED_LIMIT = WAY_CONFIG.PRE_FILTER_SPEED_LIMIT;

/** Most points a live-share track may carry. A long commute is a few thousand
 *  raw fixes; the public view is a status, not an archive, so above this the
 *  track is strided and says so (see buildShareState). */
const SHARE_TRACK_MAX = 1500;

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
  /** The TRACKING channel (home-db users.way_topic, way-db as fallback) —
   *  never the money feed, which Sompitra pushes to on its own. */
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
  // The DASHBOARD's half of the same moment: which device the map should pulse
  // for, at which level, and when the threshold that set it fired. Purely
  // visual -- never persisted, never notified, and it decides nothing about
  // the state machine, so an evicted DO simply stops pulsing (the
  // notification, which is the durable half, has already been sent).
  private approachPulses = new Map<string, { fence: string; place: string; threshold: number; at: number }>();

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

    // ---- Ingest gate ledger --------------------------------------------
    // WHY this exists at all: EVERY gate in handleIngest drops a ping
    // silently, on purpose (µlogger must never see an error). The cost is that
    // "the phone was correctly filtered" and "the phone never uploaded" are
    // the same observable from outside -- so a real-world test of the tracking
    // rules could not be read, which is exactly what this ledger fixes.
    //
    // It lives in the DO's own SQLite rather than home-db's diag_events on
    // purpose, and the split is the whole design: these are the HIGH-frequency
    // facts (a parked phone produces thousands of collapsed points a night),
    // and pushing that volume into D1 to record "the same phone was collapsed
    // again" is how a free-tier app dies. Notifications, which happen a few
    // times a day, go to diag_events instead.
    //
    //   ingest_gates : one row per gate, a durable counter
    //   ingest_drops : a bounded SAMPLE of the last few, with the reason
    //                  (the counters say "how many", this says "what did it
    //                  actually look like")
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ingest_gates (
        gate     TEXT PRIMARY KEY,
        n        INTEGER NOT NULL DEFAULT 0,
        first_at TEXT NOT NULL,
        last_at  TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ingest_drops (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        at        TEXT NOT NULL,
        device_id TEXT,
        gate      TEXT NOT NULL,
        detail    TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // The counters above are DURABLE — they survive eviction on purpose, so a
    // parked-phone test spanning an eviction is still readable. That is also
    // how they lie: after a deploy they describe code that no longer exists,
    // and the two sums reported by /debug-notify stay permanently skewed.
    //
    // This is not theoretical. Mutation-testing the ledger itself (removing the
    // accuracy gate's counter) added two `received` pings to an instance that
    // could no longer count them as `accuracy`; the sum was still broken after
    // the code was restored, because nothing knew the rows predated different
    // code. So the counters are SCOPED TO THE BUILD that wrote them: a changed
    // marker clears them. The reading is then always "since this code started",
    // which is the only reading under which the sums mean anything.
    //
    // Consequence worth knowing: changing which gates count without bumping
    // DO_BUILD leaves the sums broken, and `npm run smoke` fails on exactly that
    // (section 19) — the fix is the marker bump, not the counter.
    const meta = (key: string): string | null => {
      try {
        return this.sql.exec<{ value: string }>(`SELECT value FROM do_meta WHERE key = ?`, key).toArray()[0]?.value ?? null;
      } catch {
        return null;
      }
    };
    try {
      const stored = meta("gate_build");
      if (stored !== DO_BUILD) {
        if (stored !== null) {
          console.log(
            `FleetDO build changed (${stored} → ${DO_BUILD}): clearing the ingest gate counters, which only ever described the old code`
          );
          this.sql.exec(`DELETE FROM ingest_gates`);
          this.sql.exec(`DELETE FROM ingest_drops`);
        }
        this.sql.exec(`INSERT OR REPLACE INTO do_meta (key, value) VALUES ('gate_build', ?)`, DO_BUILD);
      }
    } catch (e) {
      // Never stop the DO from starting over bookkeeping -- a constructor throw
      // would take the whole write path down.
      console.log(`FleetDO could not scope the gate counters to its build: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Count one ingest decision, and keep a bounded sample of the interesting
   * ones. Called from every gate in handleIngest -- including the "nothing went
   * wrong" ones, because the counters only mean something next to each other:
   * "12 collapsed" is only reassuring when you can also see the 14 that
   * arrived.
   *
   * NEVER throws. A drop is already a deliberate silent-skip by contract, and
   * bookkeeping must not be the thing that upgrades it to a throw -- a ping
   * that would have been dropped cleanly would instead 500 the ingest route.
   */
  private countGate(gate: string, deviceId: string | null, detail: string, sample = true): void {
    try {
      const now = new Date().toISOString();
      this.sql.exec(
        `INSERT INTO ingest_gates (gate, n, first_at, last_at) VALUES (?, 1, ?, ?)
           ON CONFLICT(gate) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
        gate, now, now
      );
      // Only the things that did NOT go through get a sampled row. The
      // high-volume outcomes (arrived / accepted / collapsed / drawn) pass
      // sample = false and stay counters -- otherwise the 80-row window would
      // be nothing but "a ping arrived" and the one parked-phone anomaly worth
      // reading would have been pushed out an hour ago.
      if (sample) {
        this.sql.exec(
          `INSERT INTO ingest_drops (at, device_id, gate, detail) VALUES (?, ?, ?, ?)`,
          now, deviceId, gate, detail
        );
        // Bounded sample: the counters are the durable record, this window is
        // the "what did it look like" one. Pruned by id (the primary key), so
        // it is a cheap index range delete rather than a table scan.
        this.sql.exec(`DELETE FROM ingest_drops WHERE id <= (SELECT MAX(id) - 80 FROM ingest_drops)`);
      }
    } catch {
      // Deliberately silent, like every other decision on this path.
    }
  }

  /**
   * The ingest gate ledger, as /debug-notify reports it.
   *
   * Read it as an equation rather than a list: `received` should equal
   * `accuracy + glitch + accepted`, and `accepted` should equal
   * `drawn + collapsed + unwitnessed + paused`. Those two sums are the point -- they are
   * what turns "0 drawn" from alarming into explained, and a sum that does not
   * hold means a gate exists that nobody recorded.
   */
  private readGateLedger(): {
    gates: Array<{ gate: string; n: number; firstAt: string; lastAt: string }>;
    drops: Array<{ at: string; deviceId: string | null; gate: string; detail: string }>;
  } {
    try {
      const gates = this.sql
        .exec<{ gate: string; n: number; first_at: string; last_at: string }>(
          `SELECT gate, n, first_at, last_at FROM ingest_gates ORDER BY n DESC, gate ASC`
        )
        .toArray();
      const drops = this.sql
        .exec<{ at: string; device_id: string | null; gate: string; detail: string }>(
          `SELECT at, device_id, gate, detail FROM ingest_drops ORDER BY id DESC LIMIT 25`
        )
        .toArray();
      return {
        gates: gates.map((g) => ({ gate: g.gate, n: g.n, firstAt: g.first_at, lastAt: g.last_at })),
        drops: drops.map((d) => ({ at: d.at, deviceId: d.device_id, gate: d.gate, detail: d.detail })),
      };
    } catch (e) {
      // A missing table here means this instance is running pre-ledger code (or
      // the CREATEs did not apply); say so instead of reporting an empty list,
      // which would read as "nothing was ever dropped".
      console.log(
        `FleetDO ingest ledger unreadable: ${e instanceof Error ? e.message : String(e)}`
      );
      return { gates: [], drops: [] };
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

    // The Home nav's unread dot: WHEN the chat last received anything, and
    // nothing else. Read from here rather than D1 because the flush is nightly
    // -- today's messages exist only in this DO. One row, no conversation, so
    // a poll on every page of the app stays cheap. The caller (the Worker's
    // /way/api/chat/latest) has already required a session.
    if (url.pathname === "/chat-latest" && request.method === "GET") {
      const rows = this.sql
        .exec<{ id: string; created_at: string }>(
          `SELECT id, created_at FROM chat_messages ORDER BY created_at DESC LIMIT 1`
        )
        .toArray();
      const newest = rows[0] ?? null;
      return new Response(
        JSON.stringify({ id: newest?.id ?? null, at: newest?.created_at ?? null }),
        { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
      );
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

    // Clear the ingest gate ledger so the NEXT reading starts from zero.
    //
    // The counters are durable and build-scoped, so a code change clears them
    // by itself — but wanting a clean reading without changing any code is the
    // normal case before a real-world test ("reset, drive home, now read what
    // the gates did"), and without this the only way to get one would be a
    // deploy. Deliberately not part of the build marker's reset: this is a
    // deliberate act, visible as its own button.
    if (url.pathname === "/reset-gates" && request.method === "POST") {
      this.sql.exec(`DELETE FROM ingest_gates`);
      this.sql.exec(`DELETE FROM ingest_drops`);
      console.log("FleetDO ingest gate ledger reset by an admin");
      return new Response(null, { status: 204 });
    }

    // ONE device's live state, for the public live-share view (the Worker's
    // /live/api/state -- see src/lib/share.ts). Reached with a device id and
    // nothing else: a grant for one device has no way to ask about another,
    // because the id in the query IS the grant's subject, never a parameter a
    // viewer supplies.
    if (url.pathname === "/share-state" && request.method === "GET") {
      return new Response(JSON.stringify(this.buildShareState(url.searchParams.get("device") ?? "")), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Diagnostic probe (reachable only via the Worker's /api/debug/notify):
    // reports this instance's build marker and exactly what it has cached,
    // so we can tell "stale code" from "stale config" without a live tail.
    if (url.pathname === "/debug-notify" && request.method === "GET") {
      const cfg = await this.getNotifyConfig();
      return new Response(
        JSON.stringify(
          {
            // Bump this ENTIRE line list whenever the DO's own code changes.
            // A deploy does shut Durable Objects down, but eventually
            // consistently: an instance can keep serving old code until the
            // rollout reaches it (or it goes idle and is evicted after 70-140
            // s), so "did my DO change actually take effect?" is a real
            // question -- especially at cutover. GET /way/api/debug/notify
            // answers it; a settings save does NOT (that only reloads this
            // instance's notify cache).
            // v3 = accepts /system-chat (Sompitra's activity in the chat).
            // v4 = splits that into expense/income so they read differently.
            // v5 = tracking events publish to the TRACKING channel
            //      (home-db users.way_topic), not the money feed.
            // v6 = approach thresholds also drive the dashboard's badge pulse.
            // v7 = the same approach decision also writes the chat row.
            // v8 = an exit starts only from a witnessed departure, and an
            //      unwitnessed crossing is silent (rule 28).
            // v9 = the intake gates on receiver accuracy before anything else
            //      (rule 29).
            // v10 = the ingest gate ledger: every gate counts what it did and
            //       samples what it dropped (rule 30).
            // v11 = those counters are scoped to the build that wrote them, so
            //       the two sums stay true across a deploy (rule 30).
            // v12 = POST /reset-gates, so a test can start from a clean zero
            //       without changing any code (rule 30).
            // v13 = the paused branch stops double-counting an unwitnessed ping,
            //       so `accepted = drawn + collapsed + unwitnessed + paused`
            //       holds in every combination (rule 30).
            // v14 = /share-state: ONE device's live position + today's track,
            //       for the public live-share view (rule 31). A stale instance
            //       answers 404 here, which is how "the share is blank" and
            //       "the share is running old code" stay distinguishable.
            build: DO_BUILD,
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
            // The TRACKING topic each person's events would be published to
            // (home-db users.way_topic). Named in full because "topic" stopped
            // being unambiguous the day there were two of them.
            users: cfg.users.map((u) => ({
              id: u.id, username: u.username,
              trackingTopic: u.topic, quiet: `${u.quietStart}-${u.quietEnd}`,
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
            // Every gate in handleIngest drops a ping silently on purpose, so
            // without this "the phone was correctly filtered" and "the phone
            // never uploaded" are the same observable. Durable counters plus a
            // bounded sample of the drops themselves.
            ingest: this.readGateLedger(),
            // The map's in-flight badge pulses. Reported here because a pulse is
            // deliberately never persisted and expires on the client's clock: if
            // the badge is not sweeping, this is the only way to tell "the DO
            // never armed it" from "the browser dropped it".
            approachPulses: Array.from(this.approachPulses.entries()).map(([deviceId, p]) => ({
              deviceId, fence: p.fence, threshold: p.threshold,
              ageMs: Math.max(0, Date.now() - p.at),
            })),
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
    /** In-flight badge pulses (see approachPulses). Additive: a client that
     * does not know the key just ignores it. */
    approaches: Record<string, unknown>;
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

    // `ageMs` is computed against THIS clock and shipped with the pulse, so the
    // client never has to subtract its own clock from the server's (a phone can
    // be minutes off; that comparison would silently eat the whole window).
    const now = Date.now();
    const approaches = Object.fromEntries(
      Array.from(this.approachPulses.entries()).map(([devId, p]) => [devId, { ...p, ageMs: Math.max(0, now - p.at) }])
    );

    return { type: "snapshot", devices, tracks, chat, approaches };
  }

  /**
   * ONE device's live position + TODAY's track, for the public live-share view
   * (reached only through the Worker's /live/api/state). A deliberately narrow
   * slice of buildSnapshot(), and every narrowing is the point:
   *
   *   * ONE device, by id. Never a list, so a grant cannot widen into one;
   *   * no chat, no other device, no distance totals, no battery, no accuracy;
   *   * today only, out of pending_sync -- which IS today's unflushed track (the
   *     nightly flush empties it) and is exactly what the household's own map
   *     draws. The outsider sees the SAME record, not a second opinion;
   *   * bounded. Above SHARE_TRACK_MAX the track is strided, and trackTotal
   *     still reports the real count so the page can be honest about it rather
   *     than quietly showing a subset;
   *   * and it starts at a real fix: with no `device_state` row yet there is no
   *     position at all, which the viewer renders as "hasn't reported yet"
   *     rather than pinning a marker on a default coordinate.
   */
  private buildShareState(deviceId: string): ShareState {
    if (!deviceId) return { position: null, track: [], trackTotal: 0, now: Date.now() };

    let position: ShareState["position"] = null;
    try {
      const row = this.sql
        .exec<{ state_json: string }>(`SELECT state_json FROM device_state WHERE device_id = ?`, deviceId)
        .toArray()[0];
      const last = row ? ((JSON.parse(row.state_json) as Partial<StoredDeviceState>).lastStatus ?? null) : null;
      if (last) {
        position = {
          lat: last.latitude,
          lng: last.longitude,
          at: last.timestamp ?? null,
          // Same fallback the HUD uses: the reported speed when there is one,
          // else what the positions imply (a parked phone reports none).
          speed: typeof last.speed === "number" ? Math.round(last.speed) : Math.round(last.speedAvg ?? 0),
          driving: last.isDriving === true,
          stationary: last.isStationary === true,
          place: last.isInside ? last.geofenceName ?? null : null,
        };
      }
    } catch {
      position = null;
    }

    let rows: Array<{ latitude: number; longitude: number; timestamp: string }> = [];
    try {
      rows = this.sql
        .exec<{ latitude: number; longitude: number; timestamp: string }>(
          `SELECT latitude, longitude, timestamp FROM pending_sync WHERE device_id = ? ORDER BY id`,
          deviceId
        )
        .toArray();
    } catch {
      rows = [];
    }

    const stride = Math.max(1, Math.ceil(rows.length / SHARE_TRACK_MAX));
    const track: Array<[number, number, string]> = [];
    for (let i = 0; i < rows.length; i += stride) {
      track.push([rows[i].latitude, rows[i].longitude, rows[i].timestamp]);
    }
    // Always end at the newest point: a strided track that stops short of where
    // the device actually is would draw the live marker off the end of its own
    // line, which reads as two different stories on one screen.
    const newest = rows[rows.length - 1];
    if (newest && (track.length === 0 || track[track.length - 1][2] !== newest.timestamp)) {
      track.push([newest.latitude, newest.longitude, newest.timestamp]);
    }

    return { position, track, trackTotal: rows.length, now: Date.now() };
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

    // The denominator for every gate below. Counted, never sampled: this fires
    // on every ping, and the sample window belongs to the anomalies.
    this.countGate("received", ping.deviceId, "arrived at the intake", false);

    // ---- Accuracy pre-filter ---------------------------------------------
    // The household's phones filter this client-side (µlogger's "minimum
    // accuracy"), so this gate should never fire for them -- and it exists
    // because that filter is a PHONE setting, one config change (or a
    // different client) away from off. A fix its own receiver rates worse
    // than the limit is not a measurement of where the phone is, so it is
    // dropped whole, silently, exactly like the glitch filter below. It runs
    // BEFORE the speed filters on purpose: a nonexistent measurement cannot
    // be asked what it implies about speed.
    if (!accuracyIsAcceptable(accuracy)) {
      this.countGate(
        "accuracy", ping.deviceId,
        `accuracy ${accuracy} m is beyond the ${WAY_CONFIG.PRE_FILTER_MAX_ACCURACY_M} m limit`
      );
      return; // dropped silently, same as the glitch filter
    }

    // ---- Reported-speed pre-filter ---------------------------------------
    // The position check below catches a ping that MOVED impossibly far, but
    // μlogger's speed field travels with the ping and is independent of the
    // coordinates it was captured at -- so a device reporting 250 km/h while
    // moving plausibly slips past it, and that number then reaches the state
    // machine's classification, the rolling average, the live HUD, the stored
    // row, pending_sync and the approach ETA. Above the limit the report is
    // jitter by the same rule, so it is DISCARDED rather than clamped: null
    // means "not reported", which is the case every consumer already handles
    // (`ping.vel ?? result.speedAvg`), and the position-derived speed then
    // serves it.
    const reportedVel = ping.vel;
    if (
      reportedVel !== null && reportedVel !== undefined &&
      (!Number.isFinite(reportedVel) || reportedVel > PRE_FILTER_SPEED_LIMIT)
    ) {
      ping.vel = null;
    }

    // ---- Reported-speed pre-filter, the other half: corroboration --------
    // A report claiming movement the coordinates do not show is noise -- a
    // parked phone indoors reports 5-30 km/h from its GNSS chip while its fixes
    // stay inside a few metres -- and believing it is what makes a device on a
    // table look like it is driving: the point is persisted as a track dot, its
    // distance lands in the driven totals, and the approach ETA is built from
    // it. It is the one lie the position checks cannot see, because the field
    // travels with the ping independently of the coordinates. REPLACED by what
    // the positions imply, not nulled: the device is real and merely parked, and
    // a null prints "-- No signal" in the HUD's speed readout.
    const prev = stored.motion;
    if (
      ping.vel !== null &&
      prev.lastLat !== null && prev.lastLon !== null && prev.lastTs !== null &&
      !reportedSpeedIsCredible(
        prev.lastLat, prev.lastLon, prev.lastTs,
        ping.latitude, ping.longitude, ping.timestamp
      )
    ) {
      this.countGate(
        "report-unbelievable", ping.deviceId,
        `the device reported ${reportedVel} km/h where its own coordinates imply ${speedFromPositions(
          prev.lastLat, prev.lastLon, prev.lastTs,
          ping.latitude, ping.longitude, ping.timestamp
        )} km/h -- the report was replaced by the positions`
      );
      ping.vel = speedFromPositions(
        prev.lastLat, prev.lastLon, prev.lastTs,
        ping.latitude, ping.longitude, ping.timestamp
      );
    }

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
      this.countGate(
        "glitch", ping.deviceId,
        `impossible jump: ${distanceM(
          stored.motion.lastLat, stored.motion.lastLon, ping.latitude, ping.longitude
        ).toFixed(0)} m in ${(
          (Date.parse(ping.timestamp) - Date.parse(stored.motion.lastTs)) / 1000
        ).toFixed(0)} s implies over ${PRE_FILTER_SPEED_LIMIT} km/h`
      );
      return; // dropped silently, same as the Python receiver
    }

    // Everything down to here reached the state machine: no gate will drop it
    // from now on, so this is the number the drops above should account for.
    this.countGate("accepted", ping.deviceId, "reached the state machine", false);

    const geofences = await this.getGeofences();
    const { state: newMotion, result } = processPing(stored.motion, ping, geofences, stored.forcedMode);

    // An UNWITNESSED ping: the device was found outside its fence, but it was
    // last heard from so long ago that nobody watched it leave (see
    // EXIT_WITNESS_GAP_S). The position is real, the crossing is not -- so it
    // moves the live dot and nothing else: no history row, no distance, no
    // event, no push. The fence state resolved to UNKNOWN, and the next ping
    // re-anchors with zero distance (settlePending).
    const unwitnessed = result.unwitnessed === true;
    if (unwitnessed) {
      this.countGate(
        "unwitnessed", ping.deviceId,
        `found outside its fence after ${(
          (Date.parse(ping.timestamp) - Date.parse(stored.motion.lastTs ?? ping.timestamp)) / 1000
        ).toFixed(0)} s of silence (limit ${WAY_CONFIG.EXIT_WITNESS_GAP_S} s): the position is real but the crossing was not watched, so it moves the live dot only`
      );
    }

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
    } else if (unwitnessed) {
      exitBuffer = []; // unseen crossing: nothing held, nothing to flush later
    }

    // ---- stationary / moving events (push notification only, never chat) ----
    // Only fires outside a geofence: inside one the status is "at <place>",
    // which is what the entry/exit events already cover.
    if (stored.lastStatus && !unwitnessed) {
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
    if (!unwitnessed) this.maybeNotifyApproach(ping, stored.motion, result, geofences);

    // recordingPaused overrides everything else -- no history writes at all
    // while paused.
    const shouldPersist = !stored.recordingPaused && !unwitnessed && this.shouldPersistTrackPoint(result);

    // The persistence decision, counted. "0 drawn" has to be readable as "the
    // phone was parked and every point was collapsed on purpose" rather than as
    // "the pipeline is broken" -- those are the two stories this whole ledger
    // exists to tell apart.
    // The branches are exhaustive on purpose: every accepted ping lands in
    // exactly one of them, so `accepted = drawn + collapsed + unwitnessed +
    // paused` has to hold. A pause is counted rather than skipped because an
    // uncounted branch is indistinguishable from a broken one later.
    //
    // The `!unwitnessed` on the paused branch is what MAKES that exhaustive: an
    // unwitnessed ping on a paused device was already counted, and sampled with
    // its reason, as `unwitnessed` above — counting it as `paused` too would
    // make the sum exceed `accepted`, which the page prints as a warning saying
    // a gate nobody counts exists. It does not; one ping was counted twice.
    if (shouldPersist) {
      this.countGate("drawn", ping.deviceId, "written as a track point", false);
    } else if (stored.recordingPaused && !unwitnessed) {
      this.countGate("paused", ping.deviceId, "recording is paused for this device", false);
    } else if (!unwitnessed) {
      // Not a failure and not an anomaly: the deliberate noise collapse (a phone
      // on a desk indoors pings every few seconds all day, and storing those
      // would bury the real journeys). Counted all the same, because "0 drawn"
      // and "the pipeline is broken" must not look alike.
      this.countGate("collapsed", ping.deviceId, "no track information: stationary or inside a fence", false);
    }

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
      accuracy,
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
      accuracy,
      // The frontend must move the live dot but NOT add this to the track --
      // during the guard the point is held in exitBuffer and drawn later, and
      // an unwitnessed point (the `...result` carries the flag) is no track
      // point at all: no leg, no distance, no event.
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
        accuracy: p.accuracy,
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
      accuracy,
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
    // "arrived" only on a CONFIRMED entry, and "left" only on a CONFIRMED exit
    // -- and a confirmed exit means the full three-phase walk, EXITING ->
    // OUTSIDE. A single ping can never move a device from "in" to "out":
    // OUTSIDE has exactly one assignment in the state machine and it sits
    // behind both the witness test and the exit guard. The intermediate
    // CONFIRMED_INSIDE <-> EXITING transitions are just hysteresis wiggle and
    // must NOT emit events -- that was what caused ghost "left"/"arrived"
    // pairs from GPS jitter near the fence boundary.
    //
    // The arrival test is "was NOT inside", not the literal OUTSIDE name: an
    // UNWITNESSED crossing (EXIT_WITNESS_GAP_S) resolves to UNKNOWN, and that
    // device is genuinely not at home -- the ping which resolved it measured a
    // position outside the exit radius. Keying on OUTSIDE alone would let one
    // silent crossing also swallow the NEXT real arrival, and with it the push
    // that opens the gate.
    const wasInside =
      prior.geoState === "CONFIRMED_INSIDE" || prior.geoState === "EXITING";
    if (!wasInside && next.geoState === "CONFIRMED_INSIDE") {
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
      .prepare("SELECT id, username, ntfy_topic AS legacy_topic, quiet_start, quiet_end FROM users")
      .all<{ id: number; username: string; legacy_topic: string | null; quiet_start: number | null; quiet_end: number | null }>();
    const { results: subs } = await this.env.WAY_DB
      .prepare("SELECT subscriber_id, source_id, event_type FROM notification_subs")
      .all<{ subscriber_id: number; source_id: number; event_type: string }>();

    // The TRACKING channel belongs to the person and lives in home-db
    // (users.way_topic) — see migrations-home/0002 and 0004. W.A.Y decides
    // WHICH events go into it (the recipient grid below, minus the person whose
    // action it was); identity owns the address, so one phone follows one topic
    // no matter which module publishes. way-db's own column is the pre-merge
    // copy and is now only a FALLBACK, so a deployment that has not adopted the
    // channels yet still notifies. Reading home-db here is what keeps the two
    // halves apart: without it, tracking events would keep landing in the FEED
    // channel and the person could not switch one off without the other.
    //
    // Keyed for EVERY active home user, including those with no channel: a
    // person who TURNED THEIR CHANNEL OFF must stay off, so the way-db fallback
    // below is only for people home-db has never heard of (i.e. the migration
    // has not run), never for an explicit "no channel".
    const homeChannels = new Map<string, string | null>();
    let homeServerUrl: string | null = null;
    try {
      const { results: channels } = await this.env.HOME_DB
        .prepare("SELECT lower(username) AS u, way_topic FROM users WHERE is_active = 1")
        .all<{ u: string; way_topic: string | null }>();
      for (const row of channels ?? []) homeChannels.set(row.u, row.way_topic || null);
      const setting = await this.env.HOME_DB
        .prepare("SELECT value FROM home_settings WHERE key = ?")
        .bind(NTFY_SERVER_HOME_KEY)
        .first<{ value: string }>();
      homeServerUrl = setting?.value ? normalizeNtfyServer(setting.value) : null;
    } catch {
      // No home-db yet (or migration 0004 not applied): fall back to way-db.
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
          : u.legacy_topic,
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
      this.clearApproachPulse(ping.deviceId);
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
        this.clearApproachPulse(ping.deviceId, f.name);
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
        // The VISUAL half of the same moment: the dashboard pulses this
        // device's badge, so a notification that is missed still reads as
        // "someone is arriving, open the gate". Sent from here rather than
        // worked out in the browser so the pulse can never disagree with the
        // push about whether a threshold was crossed.
        this.setApproachPulse(ping.deviceId, f.name, place, threshold);
        // And into the CHAT, which is the household's activity record. The push
        // reaches whoever subscribed and can be missed, muted or eaten by quiet
        // hours; the chat row is what the family reads afterwards and is why
        // entry/exit have always been written here too. Same rule as those:
        // written unconditionally, independent of subscriptions.
        this.handleChatMessage(null, `${ping.deviceId} is ~${threshold}s from ${place}`, {
          deviceId: ping.deviceId, isAuto: true, eventType: "approach", gpsTimestamp: ping.timestamp,
        });
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

  /** Broadcast the badge pulse one crossed threshold turns on. `threshold` is
   * what the DASHBOARD scales by (60 -> yellow, 30 -> red); the client owns the
   * expiry, because the rules are about wall time ("no 30s within 60s of the
   * 60s -> stop") rather than about further pings. */
  private setApproachPulse(deviceId: string, fence: string, place: string, threshold: number) {
    const pulse = { fence, place, threshold, at: Date.now() };
    this.approachPulses.set(deviceId, pulse);
    this.broadcast({ type: "approach", deviceId, ...pulse, cleared: false });
  }

  /** Stop pulsing a device, because it arrived, turned away, or is too far out
   * to matter. `fence` scopes the clear to the pulse that fence owns, so a
   * device drifting past a SECOND home fence cannot cancel the countdown the
   * first one started. */
  private clearApproachPulse(deviceId: string, fence?: string) {
    const pulse = this.approachPulses.get(deviceId);
    if (!pulse) return;
    if (fence && pulse.fence !== fence) return;
    this.approachPulses.delete(deviceId);
    this.broadcast({ type: "approach", deviceId, fence: pulse.fence, cleared: true });
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
