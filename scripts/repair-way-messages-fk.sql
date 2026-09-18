-- Local dev repair: the `devices` FK parent was missing from this workspace's
-- WAY_DB, which silently broke the ENTIRE chat flush.
--
-- WHY THIS MATTERS (the symptom is misleading):
--   messages.device_id carries `REFERENCES devices(device_id)` (added by
--   migrations-way/0001_init.sql). SQLite/D1 resolves FK parents at DML time,
--   so if `devices` does not exist EVERY insert into `messages` fails -- even
--   rows whose device_id is NULL. The DO's flushToD1 then aborts, which looks
--   nothing like a schema problem from the outside:
--     * POST /way/api/flush returns {"error":true,"message":"D1_ERROR: no such
--       table: main.devices"}
--     * /way/api/chat/history stays permanently empty
--     * map history/tracks stay empty
--     * chat_messages rows pile up in the DO with synced = 0
--
-- The table also needs a row per device_id used in auto events (WAY's arrivals
-- and departures set device_id = 'MaxX'/'Niri'), or those inserts violate the FK
-- even once the table exists. A fresh `0001_init.sql` seeds both; this script
-- just restores what a fresh setup would produce.
--
-- Nothing in src/ reads this table any more (it is a legacy μlogger artifact and
-- an FK parent only), so the credential values below are inert placeholders.
-- IDEMPOTENT: safe to run repeatedly, and safe on a database that already has
-- the table and its rows.

CREATE TABLE IF NOT EXISTS devices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id       TEXT NOT NULL UNIQUE,   -- e.g. "MaxX", "Niri"
  tid             TEXT,                   -- short tracker id, e.g. "M1"
  display_name    TEXT NOT NULL,
  emoji           TEXT,
  color           TEXT,
  username        TEXT NOT NULL UNIQUE,   -- μlogger Basic Auth username
  password_hash   TEXT NOT NULL,          -- μlogger Basic Auth password (hashed)
  owner_user_id   INTEGER REFERENCES users(id),
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO devices (device_id, tid, display_name, emoji, color, username, password_hash) VALUES
  ('MaxX', 'M1', 'MaxX', '🏍️', '#3498db', 'CHANGE_ME_maxx_device_user', 'CHANGE_ME_hash'),
  ('Niri', 'M2', 'Niri', '🛵', '#e67e22', 'CHANGE_ME_niri_device_user', 'CHANGE_ME_hash');
