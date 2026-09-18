-- WAY (Where Are You) - migration 0007: chat reactions
-- Run with:
--   wrangler d1 execute way-db --remote --file=migrations/0007_chat_reactions.sql
--
-- SINGLE-USE: ALTER TABLE ADD COLUMN is not idempotent, so running this twice
-- fails with "duplicate column name: reactions". That error means it ALREADY
-- applied -- it does not mean it half-applied.
-- (Check with: PRAGMA table_info(messages);)
--
-- Chat reactions (👍🤣💖), mirrored from the FleetDO's chat_messages columns
-- (see ensureSchema in src/do/FleetDO.ts). Two JSON maps, deliberately split:
--   reactions      emoji -> count, e.g. {"👍":2} -- what the pill row renders
--   reaction_users username -> emoji -- who reacted, so a client can show
--                  "you reacted" and the server can keep toggling one-per-user
--   reaction_updated_at  ISO timestamp of the last reaction change
--
-- The DO is the live path: it holds the authoritative maps in its own
-- chat_messages table and broadcasts every toggle. This migration only gives
-- the D1 HISTORY rows somewhere to land during the daily flush
-- (flushToD1 snapshots reaction state at flush time; late toggles after a
-- message was flushed live on in the DO but do not rewrite history).
--
-- All three columns are nullable: rows written before this feature simply
-- have no reactions, and a client treats NULL as "none".

ALTER TABLE messages ADD COLUMN reactions TEXT;
ALTER TABLE messages ADD COLUMN reaction_users TEXT;
ALTER TABLE messages ADD COLUMN reaction_updated_at TEXT;
