-- ============================================================
-- Sompitra – Enhancements
-- 1. Protect service-synced income accounts from deletion
-- 2. Track contract end_date
-- 3. Link debt/credit accounts to income account + expense category
-- ============================================================

ALTER TABLE income_accounts ADD COLUMN is_protected INTEGER DEFAULT 0;
UPDATE income_accounts SET is_protected = 1 WHERE name IN ('Mini Service Income', 'Kiné Privée');

ALTER TABLE service_contracts ADD COLUMN end_date TEXT;

ALTER TABLE debt_credit_accounts ADD COLUMN income_account_id TEXT;
ALTER TABLE debt_credit_accounts ADD COLUMN category_id TEXT;
