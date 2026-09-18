-- ============================================================
-- Sompitra – Link debt/credit accounts to their initial transaction
-- (so deleting a debt, or deleting that transaction, can clean up)
-- ============================================================

ALTER TABLE debt_credit_accounts ADD COLUMN synced_transaction_id TEXT;
