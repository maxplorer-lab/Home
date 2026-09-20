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

-- The two rows a fresh 0001_init.sql seeds, for the names it assumed.
INSERT OR IGNORE INTO devices (device_id, tid, display_name, emoji, color, username, password_hash) VALUES
  ('MaxX', 'M1', 'MaxX', '🏍️', '#3498db', 'CHANGE_ME_maxx_device_user', 'CHANGE_ME_hash'),
  ('Niri', 'M2', 'Niri', '🛵', '#e67e22', 'CHANGE_ME_niri_device_user', 'CHANGE_ME_hash');

-- …and then the rows that actually MATTER, derived from the data rather than
-- guessed. A hardcoded list is only correct by accident: the DO stamps an auto
-- arrival/departure with the SAME device_id the ping carried, and the ingest
-- sets that from the username verbatim (`deviceId = user.username`,
-- src/way/routes/ingest.ts). Case counts. So on a database whose people were
-- spelled differently from these two seeds (`MaxX` and a lowercase `niri`, which
-- is how production stood until the 2026-09-20 merge, CUTOVER.md §1f), the row
-- named `Niri` above matched nothing: the FK was satisfied for MaxX's events and
-- still violated for hers, which read exactly like the original bug on one phone
-- only. Both sources are unioned
-- because a person's first ping is not in `gps_pings` until the 21:00 flush,
-- while their first arrival event happens the moment they move.
INSERT OR IGNORE INTO devices (device_id, display_name, username, password_hash)
SELECT device_id, device_id, device_id, 'CHANGE_ME_fk_parent_only'
FROM (
  SELECT DISTINCT device_id FROM gps_pings WHERE device_id IS NOT NULL AND device_id <> ''
  UNION
  SELECT DISTINCT username  FROM users      WHERE username  IS NOT NULL AND username  <> ''
);
