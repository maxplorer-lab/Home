-- ═══════════════════════════════════════════════════════════════
-- Home — live share links (home-db)
--
-- ONE grant, made by an admin, that lets somebody OUTSIDE the household watch
-- ONE device for the rest of the day. The scenario it exists for: a long
-- commute, and a close one who wants to know whether the car is still moving.
--
-- WHY THIS LIVES IN home-db AND NOT IN way-db:
--   * it is an ACCESS GRANT, not module data: created by an admin, revocable,
--     and its subject is just a device id (a key, like `laoka_imports.week_id`,
--     the other cross-module reference this database already holds);
--   * the viewer endpoint has to resolve a PIN without any module session, and
--     home-db is the one database that is not behind a module's auth;
--   * the module migration folders mirror the standalone module repos and are
--     treated as read-only (project.md, "Databases") — a table added there
--     would fork that history. Nothing in way-db is touched by this feature:
--     the live position and today's track come from the FleetDO, and the
--     module's own dashboard is unchanged.
--
-- The PIN is stored the way every other secret here is: the peppered
-- Laoka-format hash (HMAC(AUTH_PEPPER) → PBKDF2), never the pin itself — the
-- pepper lives only in the Worker's secrets, so a dump of this table cannot be
-- brute-forced back to six digits offline. The pin is shown to the admin ONCE,
-- at creation; "regenerate" is one click away by design.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS share_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- What is being shared. 'way-live' today; the column exists so a future
  -- grant (a Sompitra summary to an accountant, say) does not need a new table.
  kind           TEXT NOT NULL,
  -- The thing the grant points AT: a W.A.Y device_id for 'way-live'.
  subject        TEXT NOT NULL,
  -- What the outsider sees on the page. The admin decides it, because the
  -- viewer has no vocabulary of their own to interpret a device id with.
  label          TEXT NOT NULL,
  -- Who created it. Not consent (there is none, by design: an admin acts for
  -- the household) but ACCOUNTABILITY — an unattributed grant to a person's
  -- location is the thing this column exists to prevent.
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  -- Wall-clock expiry, always the NEXT 00:00 UTC (see nextUtcMidnight in
  -- src/lib/share.ts). Deliberately not extendable: a share that quietly
  -- renews is a subscription nobody agreed to.
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,
  -- Last time the viewer actually resolved a state (so the admin can see the
  -- link was opened, and whether it still is).
  last_used_at   TEXT,
  -- Peppered hash + its per-row salt and cost, exactly like users.password_*.
  pin_hash       TEXT NOT NULL,
  pin_salt       TEXT NOT NULL,
  pin_iterations INTEGER NOT NULL
);

-- The resolve path reads the recent grants and verifies the pin against each;
-- the admin card reads them newest-first.
CREATE INDEX IF NOT EXISTS idx_share_created ON share_links(created_at);
-- Expiry is the filter every read applies, and the cleanup query walks it.
CREATE INDEX IF NOT EXISTS idx_share_expires ON share_links(expires_at);
