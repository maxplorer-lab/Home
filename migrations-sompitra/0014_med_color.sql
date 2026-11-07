-- ============================================================
-- Home – Medicine line colour
-- ============================================================
-- One optional tint, chosen when a medicine is added or edited, and only ever
-- red or yellow. The household decides what those two mean; the schema stores
-- the choice and nothing more. NULL is "no tint", which is why this is
-- nullable rather than defaulting to a colour nobody picked.
--
-- The CHECK is here as well as in the form because the column is the real
-- contract: a future screen, import or fix-up must not be able to write a
-- third colour into it.

ALTER TABLE medications ADD COLUMN color TEXT CHECK (color IN ('red', 'yellow'));
