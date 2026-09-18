-- WAY (Where Are You) - migration 0006: chat replies
-- Run with:
--   wrangler d1 execute way-db --remote --file=migrations/0006_chat_replies.sql
--
-- SINGLE-USE: ALTER TABLE ADD COLUMN is not idempotent, so running this twice
-- fails with "duplicate column name: reply_to_id". That error means it ALREADY
-- applied -- it does not mean it half-applied.
-- (Check with: PRAGMA table_info(messages);)
--
-- A reply stores a SNAPSHOT of the quoted message (sender + first ~120 chars),
-- not just a foreign key. Two reasons:
--   1. Chat history is fetched in a time window, so the original is very often
--      NOT in the loaded page -- a quote that must be resolved by lookup would
--      render as a dangling reference.
--   2. The id alone would have to survive the DO -> D1 id change: chat_messages
--      uses a UUID primary key, while messages here uses AUTOINCREMENT.
-- reply_to_id is kept anyway so the UI can scroll to the original when it does
-- happen to be on screen.
--
-- The snippet is built server-side in FleetDO.handleChatMessage() from the DO's
-- own scrollback, never from the client's copy -- otherwise a dashboard could
-- forge a quote attributed to the other person.

ALTER TABLE messages ADD COLUMN reply_to_id TEXT;
ALTER TABLE messages ADD COLUMN reply_to_sender TEXT;
ALTER TABLE messages ADD COLUMN reply_to_snippet TEXT;
