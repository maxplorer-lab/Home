-- ═══════════════════════════════════════════════════════════════
-- Home — the second channel per person (home-db, 0004)
--
-- ONE topic per person turned out to be half right. A person really
-- follows TWO, because the two halves of the app are filtered
-- differently and one of them must never be filtered at all:
--
--   users.ntfy_topic   the FEED      money (Sompitra) + Kiné, in the
--                                    same wording the chat shows.
--                                    Delivered to EVERY active person,
--                                    including whoever recorded it —
--                                    the household sees its own money.
--   users.way_topic    TRACKING      W.A.Y's activity: chat, entry,
--                                    exit, stationary, moving, approach.
--                                    Routed by the RECIPIENT's grid in
--                                    way-db (notification_subs), never
--                                    to the person whose action it was,
--                                    and subject to their quiet hours.
--
-- Both live here, in the identity database, for the same reason the
-- first one does: a phone's subscriptions are an identity fact, not a
-- module's. W.A.Y still DECIDES what goes into the tracking channel
-- (its grid is its own), it just no longer owns the address.
--
-- The naming is asymmetric on purpose. `ntfy_topic` predates the split
-- and is the channel every module already pushed to; renaming a live
-- column to make the pair look tidy would be a migration with no
-- benefit. Read it as "the feed channel".
--
-- A topic adopted from W.A.Y *before* this migration landed sits in
-- `ntfy_topic` (that was the only column there was). Nothing breaks —
-- names are arbitrary and that phone keeps receiving both kinds — but
-- such a person is still following one topic where the design says two.
-- Rotating their feed channel in Settings splits them apart.
--
-- Topics are bearer secrets: anyone who knows one can subscribe, so both
-- are generated from crypto randomness and never chosen by hand.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN way_topic TEXT;
ALTER TABLE users ADD COLUMN way_topic_set_at TEXT;

-- A tracking topic identifies exactly one person's device feed; two
-- accounts sharing one would cross-deliver location events.
CREATE UNIQUE INDEX IF NOT EXISTS idx_home_users_way_topic
  ON users(way_topic) WHERE way_topic IS NOT NULL;
