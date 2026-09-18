-- ═══════════════════════════════════════════════════════════════
-- Home — the Laoka → Sompitra hand-off ledger (home-db)
--
-- One row per Laoka week that has been turned into a Sompitra expense.
-- This is the ONLY thing that makes the "send to Sompitra" button safe to
-- press twice: the week id is the primary key, so a second send UPDATES the
-- expense it created rather than adding a second one. Without it, a
-- double-tap (or a re-send after fixing one price) silently double-charges
-- the household's budget — which the old CSV path could not guard against
-- at all, because a downloaded file carries no identity.
--
-- WHY home-db AND NOT sompitra-db: this table describes a relationship
-- BETWEEN two modules, and home-db is where cross-module facts already live
-- (identity, per-person ntfy channels, household settings). Keeping it here
-- also means sompitra-db needs no new migration at all, so the one database
-- whose loss is unacceptable is not touched. `transaction_id` is a soft
-- reference into sompitra-db (checked and repaired by the import endpoint if
-- the expense was deleted there).
--
-- The stored amount/item_count are a snapshot of what was sent, so a later
-- price change in Laoka is visible as a difference instead of silently
-- rewriting history.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS laoka_imports (
  laoka_week_id  INTEGER PRIMARY KEY,   -- weeks.id in laoka-db (one expense per week)
  transaction_id TEXT NOT NULL,         -- transactions.id in sompitra-db
  amount         INTEGER NOT NULL,      -- total as sent (MGA, whole units)
  item_count     INTEGER NOT NULL,      -- how many priced lines were in it
  category_id    TEXT,                  -- the category it was filed under, if any
  imported_at    TEXT NOT NULL,         -- first send
  updated_at     TEXT                   -- most recent re-send, NULL if never re-sent
);
