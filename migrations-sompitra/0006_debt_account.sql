-- ============================================================
-- Sompitra – Neutral "Debt" income account for borrowed money
-- ============================================================

-- A non-login "system" user so the account is not tied to MaxX or Niri.
INSERT OR IGNORE INTO users (id, username, display_name, pin_hash)
VALUES ('usr_system', 'system', 'System', 'SYSTEM_NO_LOGIN');

-- Neutral "Debt" income account (protected from deletion).
INSERT OR IGNORE INTO income_accounts (id, user_id, name, is_protected)
VALUES ('inc_debt', 'usr_system', 'Debt', 1);
