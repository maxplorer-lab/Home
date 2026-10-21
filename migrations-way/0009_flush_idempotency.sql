-- WAY (Where Are You) - migration 0009: make the nightly flush idempotent
-- Run with:
--   wrangler d1 execute home-db --remote --file=migrations-way/0009_flush_idempotency.sql
--
-- The flush copies the Fleet DO's buffers (pending_sync, chat_messages) into
-- these two tables and THEN deletes/marks the rows it copied. That order is
-- deliberate -- deleting first would lose a chunk if D1 refused the insert --
-- but it makes the copy at-least-once: D1's batch() is a transaction, so the
-- insert commits, and if the DO dies before its own DELETE lands (eviction,
-- storage error, the process going away mid-await) the retry inserts the same
-- chunk again. The DO's storage and D1 have no common transaction, so ordering
-- alone can never fix it; the insert has to be able to say "I already have this
-- row" and be ignored.
--
-- `sync_id` is that identity: the DO's UUID for a buffered ping
-- (pending_sync.sync_id) or, for a message, the id the DO already gives it
-- (chat_messages.id -- a UUID). It is NOT (device_id, timestamp): production
-- holds 253 pairs that share a second and are genuinely different fixes (both
-- are kept, and their altitudes and accuracies differ), so a unique index on the
-- timestamp would have dropped real samples.
--
-- NULL stays legal and unique-tolerant (SQLite treats NULLs as distinct), which
-- is what lets this land on the rows that are already there: every existing row
-- gets NULL and keeps its place. Only rows written after this migration carry
-- an id, so a re-flushed chunk from before it is not deduped -- there is nothing
-- left in the buffer by now but the day the fix went live, and waiting one flush
-- costs nothing.
--
-- The DO does not depend on these columns existing: it probes for them and falls
-- back to the old plain INSERT when this migration has not been applied, so the
-- code can ship before the schema does. See src/way/do/flush.ts.
ALTER TABLE gps_pings ADD COLUMN sync_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pings_sync_id ON gps_pings(sync_id);

ALTER TABLE messages ADD COLUMN sync_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sync_id ON messages(sync_id);
