-- WAY (Where Are You) - initial migration
-- Applies on top of the existing way-db tables (gps_pings, messages, users
-- already exist from the earlier attempt and are left untouched except
-- where noted). Run with:
--   wrangler d1 execute way-db --remote --file=migrations/0001_init.sql
--
-- gps_pings: no changes, existing schema already matches what WAY needs.

-- ============================================================
--  devices
--  Replaces config.json's "devices" list. username/password_hash are
--  μlogger's HTTP Basic Auth credentials for that device's ping uploads
--  -- deliberately separate from the human users table, so revoking one
--  phone never touches a household member's login.
-- ============================================================
CREATE TABLE devices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id       TEXT NOT NULL UNIQUE,   -- e.g. "MaxX", "Niri"
  tid             TEXT,                   -- short tracker id, e.g. "M1"
  display_name    TEXT NOT NULL,
  emoji           TEXT,
  color           TEXT,
  username        TEXT NOT NULL UNIQUE,   -- uLogger Basic Auth username
  password_hash   TEXT NOT NULL,          -- uLogger Basic Auth password (hashed)
  owner_user_id   INTEGER REFERENCES users(id),
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
--  geofences
--  Replaces config.json's "geofences" list. exit_radius_m left NULL by
--  default -- app code falls back to radius_m + 40m, same behaviour as
--  EXIT_RADIUS_BUFFER_M in the original Python script.
-- ============================================================
CREATE TABLE geofences (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,   -- e.g. "Home1", "Office3"
  display_name    TEXT NOT NULL,          -- e.g. "Betongolo"
  category        TEXT,                   -- e.g. "Home", "Office"
  lat             REAL NOT NULL,
  lon             REAL NOT NULL,
  radius_m        REAL NOT NULL DEFAULT 60,
  exit_radius_m   REAL,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
--  Nullable -- populated for auto-generated geofence events (e.g. "Niri
--  arrived home"), left NULL for human-typed chat where `sender` (existing
--  column) already identifies who sent it.
-- ============================================================
ALTER TABLE messages ADD COLUMN device_id TEXT REFERENCES devices(device_id);

-- ============================================================
--  every ping upload, so they need to be real, unique, hashed values.
--  owner_user_id left NULL until the corresponding human user account
--  exists (set via signup) -- update these rows afterward if you want
--  device ownership tracked.
-- ============================================================
INSERT INTO devices (device_id, tid, display_name, emoji, color, username, password_hash, owner_user_id) VALUES
  ('MaxX', 'M1', 'MaxX', '🏍️', '#3498db', 'CHANGE_ME_maxx_device_user', 'CHANGE_ME_hash', NULL),
  ('Niri', 'M2', 'Niri', '🛵', '#e67e22', 'CHANGE_ME_niri_device_user', 'CHANGE_ME_hash', NULL);

-- ============================================================
--  Seed: geofences (from config.json, plus "Cours" added to Office)
-- ============================================================
INSERT INTO geofences (name, display_name, category, lat, lon) VALUES
  ('Home1',   'Home',          'Home',   -19.87962180226231,  47.03093237266988),
  ('Home2',   'Betongolo',     'Home',   -18.902539343647632, 47.54222936604051),
  ('Home3',   'Alasora',       'Home',   -18.95666022921309,  47.56871236215144),
  ('Home4',   'Ambohimiandra', 'Home',   -18.933051382374753, 47.545986107084),
  ('Home5',   'Ambatobe',      'Home',   -18.882272564852972, 47.55355667086235),
  ('Office1', 'Anjohy',        'Office', -18.91869931773052,  47.53449335351456),
  ('Office2', 'Ave Maria',     'Office', -19.858029282461022, 47.032875596213515),
  ('Office3', 'Centre',        'Office', -19.86771180664609,  47.03087084853575),
  ('Office4', 'Cours',         'Office', -18.91225123810911,  47.516130549465714);
--  Seed: devices (from config.json)
--  ⚠ username/password_hash are placeholders. Replace before going live --
--  these are what each phone's uLogger app will use for Basic Auth on

