-- Each Generate press produces one candidate week, and the counter is what
-- names it: Wishlist 1, Wishlist 2, and so on. It lives on the week so the
-- numbering survives the previous candidate being replaced.
ALTER TABLE weeks ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
