-- ============================================================
-- Home – Medicine stock
-- What is in the cupboard, when it was opened and when it expires.
-- ============================================================
-- This table belongs to the HOUSEHOLD, not to Sompitra's money screens; it
-- lives in this database because that is the binding Home's own pages read
-- (`c.env.DB`) and it holds no finance rows of its own.
--
-- `quantity` is REAL because a bottle is measured in mL and part-used, not
-- only in whole tablets. `unit` is the dropdown's answer, stored canonically
-- ('units' | 'ml') so the label ("Units" / "mL") can change without a data
-- migration.
--
-- Dates are 'YYYY-MM-DD' or NULL:
--   opened_on   NULL = not opened yet (or unknown)
--   expires_on  NULL = no date on the box
-- A NULL expiry is deliberately NOT a default date: "no date" and "expires
-- today" are different facts, and the list sorts the undated ones last.

CREATE TABLE IF NOT EXISTS medications (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  opened_on  TEXT,
  expires_on TEXT,
  quantity   REAL NOT NULL DEFAULT 0,
  unit       TEXT NOT NULL DEFAULT 'units' CHECK (unit IN ('units', 'ml')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The list's own order is soonest-expiry first, so that is the index.
CREATE INDEX IF NOT EXISTS idx_medications_expiry ON medications(expires_on);
