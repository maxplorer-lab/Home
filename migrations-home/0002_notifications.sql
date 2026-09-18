-- ═══════════════════════════════════════════════════════════════
-- Home — per-person notification channels (home-db, 0002)
--
-- ONE ntfy channel per PERSON, owned by the identity database — not
-- by any module. Before this, each app had its own idea:
--
--   Sompitra  one topic for the whole household (sompitra-db app_settings)
--   W.A.Y     one topic per person (way-db users.ntfy_topic)
--
-- A person's phone follows exactly one topic, so the topic has to be
-- an identity fact. From here on, every module pushes to the channels
-- listed in home-db (`users.ntfy_topic`), and the household-wide
-- server URL lives in `home_settings`.
--
-- W.A.Y's existing topics are NOT thrown away: `adoptWayTopics()` copies
-- each one onto the matching home-db account (by username) the first
-- time notifications are configured, so a phone that already follows a
-- topic keeps working. way-db's copy stays as the μlogger-era record.
--
-- The topic is a bearer secret (anyone who knows it can subscribe), so it
-- is generated server-side from crypto randomness — never chosen by hand.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN ntfy_topic TEXT;
ALTER TABLE users ADD COLUMN ntfy_topic_set_at TEXT;

-- A topic identifies exactly one person; two accounts sharing one would
-- cross-deliver each other's notifications.
CREATE UNIQUE INDEX IF NOT EXISTS idx_home_users_ntfy_topic
  ON users(ntfy_topic) WHERE ntfy_topic IS NOT NULL;

-- Household-wide key/value settings (ntfy server URL, and anything that
-- later belongs to the app as a whole rather than a person or a module).
-- Modules keep their OWN app_settings tables for module-only knobs.
CREATE TABLE IF NOT EXISTS home_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
