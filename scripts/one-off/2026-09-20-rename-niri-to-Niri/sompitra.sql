-- ═══════════════════════════════════════════════════════════════════
-- sompitra-db (DB) — her login name: niri → Niri
--
-- DELIBERATELY NOT TOUCHED: `users.id = 'usr_niri'` and every column that
-- references it — `sessions.user_id` (32 rows), `income_accounts.user_id` (3),
-- `transactions.added_by_user_id` (39 — the money).
--
-- That id is derived from the OLD username and is an internal primary key. It is
-- invisible everywhere in the app, and the provisioning path finds the account by
-- NAME, case-insensitively (`SELECT id, username FROM users WHERE lower(username) =
-- lower(?1)`, src/identity.ts), so renaming the username keeps her linked to
-- every row she owns. Rewriting a primary key underneath the finance data would
-- buy nothing anybody can see, and every referencing table would have to be
-- perfect in the same transaction — 39 transactions is not where a cosmetic fix
-- belongs. Recorded here so the next person does not "finish the job" by accident.
--
-- IDEMPOTENT: a second run matches no row.
-- ═══════════════════════════════════════════════════════════════════

UPDATE users SET username = 'Niri' WHERE username = 'niri';
