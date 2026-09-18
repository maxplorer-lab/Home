-- A week's plan now has a middle stage. Saving a draft makes it the template
-- for the week, which is what the shopping list is drawn from; confirming it
-- afterwards is what finally settles the week and locks the days that have
-- passed. Before confirmation every day is still changeable, because that is
-- the point of going shopping with it.
--
-- A column rather than a new status value, since status carries a CHECK
-- constraint that would mean rebuilding the table to widen.
ALTER TABLE weeks ADD COLUMN confirmed_at TEXT;
