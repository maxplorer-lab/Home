-- ============================================================
-- Sompitra – Envelopes
-- A budgeted category can hold money of its own.
-- ============================================================
-- Two columns, because an envelope needs two facts that the ledger must be
-- able to tell apart for ever:
--
--   categories.envelope_from        when this category became an envelope.
--                                   NULL = a plain category, so nothing that
--                                   happened before today is re-interpreted:
--                                   history keeps the cash balance it had.
--
--   transactions.is_envelope_transfer
--                                   1 = this expense is FUNDING, not spending.
--                                   It leaves the main pot once; the purchases
--                                   inside the envelope are counted there as
--                                   spending and nowhere else. Without the
--                                   flag a funded envelope would charge the
--                                   household twice for one bag of rice.
--
-- Both default to "not an envelope", so every existing row and every existing
-- form keeps exactly the meaning it had. A category becomes an envelope the
-- first time money is moved into it (the route stamps envelope_from then).

ALTER TABLE transactions ADD COLUMN is_envelope_transfer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE categories ADD COLUMN envelope_from TEXT;

-- The two sums an envelope asks for on every page: what was funded into this
-- category, and what was spent out of it since it opened.
CREATE INDEX IF NOT EXISTS idx_transactions_envelope ON transactions(category_id, date);
