-- WAY (Where Are You) - migration 0004: ntfy.sh push notifications
-- Run with:
--   wrangler d1 execute way-db --remote --file=migrations/0004_notifications.sql
--
-- SINGLE-USE: SQLite's ALTER TABLE ADD COLUMN is not idempotent, so running
-- this file twice fails with "duplicate column name: ntfy_topic". That error
-- means the migration ALREADY applied -- it does not mean it half-applied.
-- (Check with: PRAGMA table_info(users); and look for notification_subs.)
--
-- Model: each user owns ONE ntfy topic (their "inbox"); their phone's ntfy
-- app follows only their own topic. The recipients' checkbox grid decides
-- what gets routed into that topic, so the BACKEND sorts every event by the
-- receiving users' preferences and publishes to those specific topics.
-- Nobody subscribes to anyone else's topic directly, and nobody is
-- notified about their own events.
--
-- Topics are random (way-<20 chars>) because a public ntfy.sh topic name is
-- the ONLY thing protecting its messages -- a guessable name would expose
-- the household's location events to anyone.

ALTER TABLE users ADD COLUMN ntfy_topic TEXT;
-- Quiet hours: hours in the household timezone (Africa/Nairobi, UTC+3).
-- During the window only chat notifications are delivered.
ALTER TABLE users ADD COLUMN quiet_start INTEGER NOT NULL DEFAULT 22;
ALTER TABLE users ADD COLUMN quiet_end INTEGER NOT NULL DEFAULT 6;

-- Subscription grid: "subscriber wants <event_type> events about <source>".
-- Grew naturally as users join -- every user simply appears as a new row for
-- everyone else.
CREATE TABLE notification_subs (
  subscriber_id INTEGER NOT NULL,   -- the user who wants to be notified
  source_id     INTEGER NOT NULL,   -- the user whose events they want
  event_type    TEXT NOT NULL,      -- 'entry' | 'exit' | 'chat' | 'stationary' | 'moving'
  PRIMARY KEY (subscriber_id, source_id, event_type)
);

-- Backfill: users created before this migration have no topic yet. Give them
-- one now (same shape as lib/notify.ts generateNtfyTopic: "way-" + 20 chars).
-- Any of these can be regenerated from Settings -> Users & topics.
UPDATE users SET ntfy_topic = 'way-' || lower(hex(randomblob(10))) WHERE ntfy_topic IS NULL;
