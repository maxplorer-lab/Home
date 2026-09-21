-- ═══════════════════════════════════════════════════════════════
-- Pantry — the second shopping list, and its own purchase
--
-- The catalog is now TWO domains in one table set, split by `groups.is_pantry`:
--
--   meal     Protein · Sides (incl. Raw Salad)   → planned weekly by the planner,
--                                                 never counted, never stock-tracked
--   pantry   spices · oils · condiments ·        → NOT planned, NOT in the week's
--            dry staples (+ whatever the          list; managed from the Pantry tab,
--            household adds: toilet paper,        counted by hand, and it is what
--            soap, batteries…)                    decides when to buy more
--
-- Nothing here moves a row: the pantry items are already in the catalog under
-- their own group, and the separation is enforced at the two places that could
-- else mix them — `syncShoppingLines` (which no longer adds pantry items to a
-- week) and the screens (Catalog/Plan/Shop never look at is_pantry groups; the
-- Pantry tab never looks at meal groups). That keeps ONE item identity, so a
-- pantry item cannot exist twice with two spellings and two histories.
--
-- A pantry purchase is a TRIP, because it is not a week: you go when the
-- shelves say so, not on a schedule, and two trips must never collapse into one
-- expense. The trip is the expense's identity, exactly as a week is for Laoka's
-- hand-off:
--
--   pantry_trips   one row per shopping trip. `transaction_id`, `pushed_at`,
--                  `amount` and `item_count` are the cross-module fact (written
--                  back by Sompitra when the trip becomes an expense), so a
--                  second push corrects that expense instead of creating a
--                  second charge -- and the Pantry screen can still say what the
--                  last trip cost after its prices are gone.
--   pantry_lines   the price typed for an item ON THE CURRENT TRIP. A price is a
--                  statement about this shopping, not about the item, which is
--                  why it lives here and not on `items`. `trips.line` is the
--                  whole to-buy list; a new trip starts empty, so a pushed
--                  purchase cannot be sent twice by leaving prices behind.
--
-- The to-buy list itself is NOT stored: it is `stock < stock_min`, the same rule
-- the Pantry screen shows. Prices are the only thing a trip adds.

-- A count on a MEAL item is not a small mistake, it is a contradiction: chicken
-- thighs are planned, bought and cooked, so no shelf of them exists to count.
-- Any number migration 0009 recorded for the meal side is cleared here, in the
-- same migration that splits the domains, rather than left behind for a screen
-- to find later. (A no-op on any database where nobody ever counted a meal.)
UPDATE items SET stock = NULL WHERE subgroup_id IN (
  SELECT s.id FROM subgroups s
  JOIN groups g ON g.id = s.group_id
  WHERE g.is_pantry = 0
);

CREATE TABLE IF NOT EXISTS pantry_trips (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set when the trip became a Sompitra expense: which one, how much, how many
  -- lines, and when. item_count has to live HERE rather than be counted from
  -- pantry_lines, because pushing the trip deletes those rows on purpose -- the
  -- record of what was bought is the expense, and this row is how the Pantry
  -- screen can still say "last trip: Ar 6,000, 2 items".
  transaction_id TEXT,
  pushed_at      TEXT,
  amount         REAL,
  item_count     INTEGER
);

CREATE TABLE IF NOT EXISTS pantry_lines (
  item_id    INTEGER PRIMARY KEY,
  trip_id    INTEGER NOT NULL,
  price      REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Looking up "the current trip" (the newest unpushed one) on every render.
CREATE INDEX IF NOT EXISTS idx_pantry_lines_trip ON pantry_lines(trip_id);

-- Its own settings row namespace is not needed: the pantry has no schedule, no
-- generation and no confirmation. A trip begins when the first price is typed
-- and ends when it is pushed.
