-- Pantry stock: how much of an item is at home, and when to reorder it.
--
-- NULL stock means the item is NOT counted: nobody tracks it, so it never joins
-- a list on its own and nothing about it changes. stock_min is per item on
-- purpose -- milk reorders at 1, rice at 5 -- and defaults to 2, which is the
-- household's own rule: anything under two.
--
-- ⚠ SUPERSEDED, in part, by 0010_pantry.sql. This migration was written for a
-- first iteration in which a low item joined the WEEK's shopping list, as the
-- pantry branch of syncShoppingLines. That is no longer the model: 0010 splits
-- the catalogue into two domains (meals vs pantry), the week's list is the plan
-- and nothing else, and a pantry item below its level goes on the PANTRY's own
-- to-buy list with its own trip and its own expense. What survives here is the
-- storage and the rule's arithmetic; the "joins the week" half is history, kept
-- only so this file still describes what it did on the day it ran.
--
-- The columns stay exactly as they are: additive and nullable, so the standalone
-- Laoka app ignores them and still works.
ALTER TABLE items ADD COLUMN stock REAL;
ALTER TABLE items ADD COLUMN stock_min REAL NOT NULL DEFAULT 2;
