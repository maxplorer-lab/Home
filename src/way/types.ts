// types.ts
// Shared shapes used across the Worker routes and the FleetDO.
// Domain-specific types (MotionState, RawPing, PingResult, Geofence)
// live next to the logic that owns them, in lib/state-machine.ts and
// lib/geofence.ts -- not duplicated here.

// ============================================================
//  Worker environment bindings (from wrangler.jsonc)
// ============================================================
export interface Env {
  WAY_DB: D1Database;
  FLEET_DO: DurableObjectNamespace;
  // The Home identity database. W.A.Y reads it for TWO things: each person's
  // TRACKING channel (users.way_topic — W.A.Y activity is the only thing it
  // pushes) and the household ntfy server (home_settings.ntfy_server). The
  // channel belongs to the person, not to this module — see
  // migrations-home/0002 and 0004, and src/identity.ts. Money and Kiné go to
  // the OTHER channel (users.ntfy_topic) from Sompitra, not from here.
  HOME_DB: D1Database;
  // Secret, NOT in wrangler.jsonc: set it in the Cloudflare dashboard
  // (Worker -> Settings -> Variables and Secrets), because deployment is via
  // Workers Builds rather than a local `wrangler deploy`. For `wrangler dev`,
  // put it in .dev.vars. See docs/OPERATIONS.md, "Secrets".
  SESSION_SECRET: string;
  // Base URL of the ntfy server -- a self-hosted instance (e.g. the Cloud Run
  // URL) or https://ntfy.sh. Set in wrangler.jsonc's `vars` block.
  NTFY_URL?: string;
  // Optional access token, only needed if the ntfy server has auth enabled.
  // Set with `wrangler secret put NTFY_TOKEN`.
  NTFY_TOKEN?: string;
}

// ============================================================
//  D1 row shapes -- one per table, matching migrations/0001_init.sql
//  exactly. snake_case here on purpose: these mirror the DB columns
//  directly, so a query result can be typed as one of these with no
//  field-name translation. Convert to camelCase app-side types (e.g.
//  lib/geofence.ts's Geofence) at the boundary where a row is read.
// ============================================================

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  emoji: string | null;
  color: string | null;
  follow_zoom: number;
  home_fence: string | null;
  // This user's TRACKING topic. The authority is home-db users.way_topic; this
  // column is kept in step with it because the standalone Worker still reads
  // it as a fallback (see src/identity.ts setWayTopic).
  ntfy_topic: string | null;
  quiet_start: number;       // quiet-hours window, household tz (hours 0-23)
  quiet_end: number;
  created_at: string;
}

/** One cell of the notification grid: `subscriber` wants `event_type` events
 * about `source`. */
export interface NotificationSubRow {
  subscriber_id: number;
  source_id: number;
  event_type: string;
}

export interface InviteCodeRow {
  id: number;
  code: string;
  created_by: number | null;
  created_at: string;
  expires_at: string;
  used_by: number | null;
  used_at: string | null;
}

/** A runtime app setting (migrations/0005_app_settings.sql), editable by an
 * admin in the dashboard. Currently just the ntfy server root -- see
 * lib/notify.ts's NTFY_URL_SETTING_KEY. Resolution order for that value is:
 * app_settings -> env.NTFY_URL (wrangler.jsonc) -> the built-in default. */
export interface AppSettingRow {
  key: string;
  value: string;
  updated_at: string;
}

export interface GeofenceRow {
  id: number;
  name: string;
  display_name: string;
  category: string | null;
  lat: number;
  lon: number;
  radius_m: number;
  exit_radius_m: number | null;
  created_at: string;
}

/** A track point already synced into D1's long-term history. */
export interface GpsPingRow {
  id: number;
  device_id: string;
  timestamp: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  speed: number | null;
  speed_avg_30s: number | null;
  is_inside_geofence: number | null; // SQLite boolean: 0/1
  geofence_name: string | null;
  is_driving: number | null;
  distance_km: number | null;
  is_stationary: number | null;
  is_keep_alive: number | null;
  battery: number | null;
  accuracy: number | null;
  leg_id: number | null; // backend leg this point belongs to (NULL on pre-legs rows)
  created_at: string;
}

/** A chat/event row already synced into D1's long-term history. */
export interface MessageRow {
  id: number;
  sender: string;
  message: string;

  gps_timestamp: string | null;
  is_auto: number | null; // SQLite boolean: 0/1
  event_type: string | null;
  device_id: string | null;
  // Reply linkage (migrations/0006_chat_replies.sql). The sender/snippet are a
  // SNAPSHOT taken when the reply was sent, so the quote still renders even
  // though the original is usually outside the fetched time window.
  reply_to_id: string | null;
  reply_to_sender: string | null;
  reply_to_snippet: string | null;
  created_at: string;
}

// ============================================================
//  Live chat message shape, as held in the FleetDO's own SQLite
//  storage (recent scrollback) and broadcast over WebSocket. Distinct
//  from MessageRow: this is the pre-sync, DO-local shape; the daily
//  cron flush is what turns these into MessageRow entries in D1.
// ============================================================
export interface ChatMessage {
  id: string;        // DO-local id (e.g. crypto.randomUUID()), not the D1 autoincrement id
  sender: string | null;   // null for auto-generated events
  deviceId: string | null; // set for auto-generated geofence events
  message: string;
  isAuto: boolean;
  eventType: string | null;
  gpsTimestamp: string | null;
  // Reply linkage, resolved server-side from the DO's own scrollback when the
  // message is sent (see FleetDO.handleChatMessage). Null on a normal message.
  replyToId: string | null;
  replyToSender: string | null;
  replyToSnippet: string | null;
  createdAt: string;
  synced: boolean; // false until the daily cron has flushed it to D1
}
