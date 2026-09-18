-- WAY (Where Are You) - migration 0000: baseline tables
-- Run with:
--   wrangler d1 execute way-db --remote --file=migrations/0000_baseline.sql
--
-- ⚠ RUN THIS FIRST ON A FRESH DATABASE. Numbering is deliberate: this file
-- recreates the four tables that the live database already had before
-- migrations existed, so 0001 onwards can apply to a brand-new D1.
--
-- WHY THIS EXISTS
-- ---------------
-- Production `way-db` was not built from these files. `users`, `gps_pings`,
-- `messages` and `invite_codes` came from hand-run SQL during the original
-- (Python) project, and 0001_init.sql only ever says so in its own header:
--
--   "Applies on top of the existing way-db tables (gps_pings, messages, users
--    already exist from the earlier attempt and are left untouched ...)"
--
-- The consequence was that the documented fresh-install sequence could not
-- run at all: 0001 fails at its first ALTER with
--   X [ERROR] no such table: messages: SQLITE_ERROR
-- and D1 rolls the whole file back, so nothing is created. Any new
-- environment (or a restored/renamed database) needs this file first.
--
-- SAFE TO RUN ANYWHERE: every statement is CREATE TABLE IF NOT EXISTS, so on
-- the live database this is a complete no-op. That also makes it the only
-- migration besides 0005 that can be re-run.
--
-- SCOPE: base columns ONLY, exactly as they stood before 0001. Later
-- migrations add the rest, so nothing here may duplicate them:
--   0001 -> messages.device_id
--   0002 -> users.follow_zoom, users.home_fence; creates invite_codes
--   0003 -> gps_pings.leg_id
--   0004 -> users.ntfy_topic, users.quiet_start, users.quiet_end;
--           creates notification_subs
--   0005 -> app_settings
--   0006 -> messages.reply_to_id, messages.reply_to_sender,
--           messages.reply_to_snippet
-- Adding a column here that a later migration also adds will break that
-- migration with "duplicate column name".

-- ============================================================
--  users
--  The single credential table: a dashboard login AND the μlogger upload
--  credential (one person == one tracked device). The first admin is
--  inserted by hand -- see README "One-time setup" step 4.
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- "salt:hash", PBKDF2-SHA256 (lib/auth-crypto.ts)
  role          TEXT NOT NULL,          -- 'admin' | 'member'
  emoji         TEXT,
  color         TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
--  gps_pings
--  Long-term track history. Populated ONLY by the daily flush from the
--  Durable Object's pending_sync table -- never written directly per ping.
--  device_id is a USERNAME (see 0002's header), not a separate device id.
-- ============================================================
CREATE TABLE IF NOT EXISTS gps_pings (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id          TEXT NOT NULL,
  timestamp          TEXT NOT NULL,
  latitude           REAL NOT NULL,
  longitude          REAL NOT NULL,
  altitude           REAL,
  speed              REAL,
  speed_avg_30s      REAL,
  is_inside_geofence INTEGER,
  geofence_name      TEXT,
  is_driving         INTEGER,
  distance_km        REAL,
  is_stationary      INTEGER,
  is_keep_alive      INTEGER,
  battery            REAL,
  accuracy           REAL,
  created_at         TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
--  messages
--  Chat + auto geofence events. sender is NOT NULL -- auto events arrive
--  from the DO with sender = null and the flush maps them to "System".
--  That NOT NULL violation once made the entire flush fail silently; see
--  docs/OPERATIONS.md "Known failure modes".
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender        TEXT NOT NULL,
  message       TEXT NOT NULL,
  gps_timestamp TEXT,
  is_auto       INTEGER,
  event_type    TEXT,
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);
