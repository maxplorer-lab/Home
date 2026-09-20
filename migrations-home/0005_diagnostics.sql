-- ═══════════════════════════════════════════════════════════════
-- Home — the cross-module diagnostics ledger (home-db)
--
-- Every module has a deliberate-silence contract: µlogger must never see an
-- error, and a notification must never break the action that triggered it. The
-- cost of that contract is that "silently fine" and "silently broken" look
-- identical from the outside — which is exactly how a real-world test becomes
-- unreadable.
--
-- This table is where the difference gets written down. It is deliberately NOT
-- a log of everything:
--
--   * HIGH-frequency facts stay out. Tracking pings arrive every few seconds
--     (14k+ rows already, and a parked phone produces thousands a night), so
--     W.A.Y counts its own gates in the FleetDO's SQLite — writing that volume
--     into D1 to say "the same parked phone was collapsed again" is how a
--     free-tier app dies. See FleetDO's ingest_gates/ingest_drops.
--
--   * What lands HERE is the opposite kind of fact: things that did NOT get
--     delivered, or did NOT get recorded. A handful of rows a day, which is
--     small enough to keep for months and to read in full.
--
-- Rows are append-only. Pruning is the daily cron's job (see pruneDiag), on the
-- same principle as W.A.Y's flush: retention that needs a human is not
-- retention.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS diag_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  -- Which module the fact belongs to. 'home' is the shell itself: login,
  -- admin, provisioning — facts that belong to no single module.
  module  TEXT NOT NULL,
  -- A short stable slug the page groups by, never prose: 'notify-refused',
  -- 'notify-skipped', 'notify-failed'.
  kind    TEXT NOT NULL,
  -- Who or what it was about: a username, a device id, a topic, a database.
  subject TEXT,
  -- Plain language, safe to show a person verbatim.
  detail  TEXT NOT NULL,
  -- One word: refused | skipped | dropped | failed.
  outcome TEXT NOT NULL
);

-- Newest-first reads and the cron's age-based prune both walk `at`, so this is
-- the one index that has to exist from birth rather than being added once the
-- table is already slow.
CREATE INDEX IF NOT EXISTS idx_diag_at          ON diag_events(at);
-- The page's grouped counters ("how many refusals per module?") read these two
-- together.
CREATE INDEX IF NOT EXISTS idx_diag_module_kind ON diag_events(module, kind);
