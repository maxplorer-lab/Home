-- Availability becomes opt-out: everything the household has entered is
-- buyable unless somebody marks it unavailable.
--
-- The original opt-in default meant a freshly deployed app had nothing ticked,
-- so the first Generate produced seven days of empty slots and looked broken.
-- New rows are inserted as available by the API; this catches everything that
-- already exists.
UPDATE items SET selected = 1;
