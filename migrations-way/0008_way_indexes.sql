-- WAY (Where Are You) - migration 0008: the two indexes the history reads need
-- Run with:
--   wrangler d1 execute WAY_DB --remote --file=migrations-way/0008_way_indexes.sql
--
-- IDEMPOTENT: both statements are CREATE INDEX IF NOT EXISTS, so re-running this
-- file is a no-op (unlike the ALTER TABLE migrations on either side of it).
--
-- DB-REDESIGN.md §1a: `gps_pings` and `messages` shipped with NO index at all,
-- so SQLite planned every history window as
--   SCAN gps_pings / USE TEMP B-TREE FOR ORDER BY
-- and rows read = the WHOLE table no matter how small the window asked for. On
-- the D1 free plan that makes the 5M rows/day READ budget the first wall, ahead
-- of the 500 MB storage limit: ten history page loads against a ~500k-row table
-- exhaust the day, and every query after that fails until UTC midnight.
--
-- The columns follow the queries the app actually runs (src/way/db/queries.ts),
-- not a guess:
--   gps_pings  WHERE device_id = ? AND timestamp >= ? AND timestamp <= ?
--              ORDER BY timestamp ASC
--   messages   WHERE created_at >= ? AND created_at <= ?
--              ORDER BY created_at ASC
-- (device_id, timestamp) is the leftmost-prefix that serves both the range and
-- the ORDER BY, which is what also removes the temp B-tree.
--
-- Cost, stated plainly: every index adds a row written per insert, and the ping
-- flush is the largest write volume in the app. DB-REDESIGN §1c accepted that
-- trade already - a large read saving for a small write increase.

CREATE INDEX IF NOT EXISTS idx_pings_device_ts ON gps_pings(device_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
