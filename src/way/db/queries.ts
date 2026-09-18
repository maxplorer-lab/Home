// db/queries.ts
// Typed D1 helpers. Callers get back the *Row types from types.ts
// (snake_case, matching the DB columns directly) -- any camelCase
// conversion needed by app logic happens at the call site, not here.

import { D1Database } from "@cloudflare/workers-types";
import { UserRow, InviteCodeRow, GeofenceRow, GpsPingRow, MessageRow, NotificationSubRow, AppSettingRow } from "../types";
import { generateNtfyTopic } from "../lib/notify";

// ============================================================
//  Users (the single entity -- one person == one tracked device)
// ============================================================
export async function getUserByUsername(db: D1Database, username: string): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
}

export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

export async function getUsers(db: D1Database): Promise<UserRow[]> {
  const { results } = await db.prepare("SELECT * FROM users ORDER BY username").all<UserRow>();
  return results;
}

export async function createUser(
  db: D1Database,
  fields: { username: string; passwordHash: string; role: string; emoji?: string | null; color?: string | null }
): Promise<UserRow> {
  // Every user gets their own random ntfy topic at creation -- the admin
  // copies it out of the Users section and shares it with that person.
  await db
    .prepare("INSERT INTO users (username, password_hash, role, emoji, color, ntfy_topic) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(fields.username, fields.passwordHash, fields.role, fields.emoji ?? null, fields.color ?? null, generateNtfyTopic())
    .run();
  const created = await getUserByUsername(db, fields.username);
  if (!created) throw new Error("User insert succeeded but row could not be re-read");
  return created;
}

export async function updateUserTopic(db: D1Database, userId: number, topic: string): Promise<void> {
  await db.prepare("UPDATE users SET ntfy_topic = ? WHERE id = ?").bind(topic, userId).run();
}

export async function updateUserQuietHours(
  db: D1Database,
  userId: number,
  quietStart: number,
  quietEnd: number
): Promise<void> {
  await db
    .prepare("UPDATE users SET quiet_start = ?, quiet_end = ? WHERE id = ?")
    .bind(quietStart, quietEnd, userId)
    .run();
}

// ============================================================
//  Notification subscriptions (the per-user checkbox grid)
// ============================================================
export async function getNotificationSubs(db: D1Database, subscriberId: number): Promise<NotificationSubRow[]> {
  const { results } = await db
    .prepare("SELECT subscriber_id, source_id, event_type FROM notification_subs WHERE subscriber_id = ?")
    .bind(subscriberId)
    .all<NotificationSubRow>();
  return results;
}

/** Whole grid for one subscriber, replaced atomically-ish (delete + insert). */
export async function replaceNotificationSubs(
  db: D1Database,
  subscriberId: number,
  subs: Array<{ sourceId: number; eventType: string }>
): Promise<void> {
  const statements = [
    db.prepare("DELETE FROM notification_subs WHERE subscriber_id = ?").bind(subscriberId),
    ...subs.map((s) =>
      db
        .prepare("INSERT OR IGNORE INTO notification_subs (subscriber_id, source_id, event_type) VALUES (?, ?, ?)")
        .bind(subscriberId, s.sourceId, s.eventType)
    ),
  ];
  await db.batch(statements);
}

/** Every subscription, for the FleetDO's routing cache. */
export async function getAllNotificationSubs(db: D1Database): Promise<NotificationSubRow[]> {
  const { results } = await db
    .prepare("SELECT subscriber_id, source_id, event_type FROM notification_subs")
    .all<NotificationSubRow>();
  return results;
}

export async function updateUserProfile(
  db: D1Database,
  userId: number,
  fields: { emoji: string | null; color: string | null }
): Promise<void> {
  await db
    .prepare("UPDATE users SET emoji = ?, color = ? WHERE id = ?")
    .bind(fields.emoji, fields.color, userId)
    .run();
}

export async function updateUserPassword(db: D1Database, userId: number, passwordHash: string): Promise<void> {
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, userId).run();
}

export async function updateUserPrefs(
  db: D1Database,
  userId: number,
  fields: { followZoom: number; homeFence: string | null }
): Promise<void> {
  await db
    .prepare("UPDATE users SET follow_zoom = ?, home_fence = ? WHERE id = ?")
    .bind(fields.followZoom, fields.homeFence, userId)
    .run();
}

// ============================================================
//  Invite codes -- 6-digit numeric, single-use, 30-minute expiry
// ============================================================
export async function createInviteCode(
  db: D1Database,
  code: string,
  createdBy: number,
  expiresAt: string
): Promise<void> {
  await db
    .prepare("INSERT INTO invite_codes (code, created_by, expires_at) VALUES (?, ?, ?)")
    .bind(code, createdBy, expiresAt)
    .run();
}

export async function getInviteCodeByCode(db: D1Database, code: string): Promise<InviteCodeRow | null> {
  return db.prepare("SELECT * FROM invite_codes WHERE code = ?").bind(code).first<InviteCodeRow>();
}

export async function markInviteCodeUsed(db: D1Database, id: number, usedBy: number): Promise<void> {
  await db
    .prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE id = ?")
    .bind(usedBy, new Date().toISOString(), id)
    .run();
}

export async function listInviteCodes(db: D1Database): Promise<InviteCodeRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT 50")
    .all<InviteCodeRow>();
  return results;
}

// ============================================================
//  Geofences
// ============================================================
export interface GeofenceInput {
  name: string;
  displayName: string;
  category: string | null;
  lat: number;
  lon: number;
  radiusM: number;
  exitRadiusM: number | null;
}

export async function getGeofences(db: D1Database): Promise<GeofenceRow[]> {
  const { results } = await db.prepare("SELECT * FROM geofences ORDER BY category, display_name").all<GeofenceRow>();
  return results;
}

export async function getGeofenceByName(db: D1Database, name: string): Promise<GeofenceRow | null> {
  return db.prepare("SELECT * FROM geofences WHERE name = ?").bind(name).first<GeofenceRow>();
}

export async function createGeofence(db: D1Database, f: GeofenceInput): Promise<void> {
  await db
    .prepare(
      "INSERT INTO geofences (name, display_name, category, lat, lon, radius_m, exit_radius_m) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(f.name, f.displayName, f.category, f.lat, f.lon, f.radiusM, f.exitRadiusM)
    .run();
}

export async function updateGeofence(db: D1Database, name: string, f: GeofenceInput): Promise<void> {
  await db
    .prepare(
      "UPDATE geofences SET display_name = ?, category = ?, lat = ?, lon = ?, radius_m = ?, exit_radius_m = ? WHERE name = ?"
    )
    .bind(f.displayName, f.category, f.lat, f.lon, f.radiusM, f.exitRadiusM, name)
    .run();
}

export async function deleteGeofence(db: D1Database, name: string): Promise<void> {
  await db.prepare("DELETE FROM geofences WHERE name = ?").bind(name).run();
}

// ============================================================
//  GPS history (synced track points -- does not include whatever is
//  still sitting unflushed in the fleet DO's pending_sync table)
// ============================================================
export async function getPingsInRange(
  db: D1Database,
  deviceId: string,
  startIso: string,
  endIso: string
): Promise<GpsPingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM gps_pings
       WHERE device_id = ? AND timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC`
    )
    .bind(deviceId, startIso, endIso)
    .all<GpsPingRow>();
  return results;
}

export async function deletePingsOlderThan(db: D1Database, cutoffIso: string): Promise<number> {
  const res = await db.prepare("DELETE FROM gps_pings WHERE timestamp < ?").bind(cutoffIso).run();
  return res.meta?.changes ?? 0;
}

// ============================================================
//  Chat / event history (synced messages only -- see dashboard-api.ts
//  for how this is combined with the fleet DO's live/unsynced scrollback)
// ============================================================
export async function getMessagesInRange(
  db: D1Database,
  startIso: string,
  endIso: string
): Promise<MessageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM messages
       WHERE created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC`
    )
    .bind(startIso, endIso)
    .all<MessageRow>();
  return results;
}

export async function deleteMessagesOlderThan(db: D1Database, cutoffIso: string): Promise<number> {
  const res = await db.prepare("DELETE FROM messages WHERE created_at < ?").bind(cutoffIso).run();
  return res.meta?.changes ?? 0;
}

// ============================================================
//  Runtime app settings (migrations/0005_app_settings.sql)
//
//  An admin edits these in the dashboard; the FleetDO reads them through its
//  own cache. Every write MUST be followed by a reloadNotifications(env) call
//  (routes/dashboard-api.ts does this) or the DO keeps serving the old value
//  until it is evicted -- see docs/ARCHITECTURE.md invariant 12.
// ============================================================
export async function getAppSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setAppSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value, new Date().toISOString())
    .run();
}

/** Deletes an override so the built-in fallback applies again. */
export async function deleteAppSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM app_settings WHERE key = ?").bind(key).run();
}

export async function getAppSettings(db: D1Database): Promise<AppSettingRow[]> {
  const { results } = await db.prepare("SELECT * FROM app_settings ORDER BY key").all<AppSettingRow>();
  return results;
}
