-- ═══════════════════════════════════════════════════════════════════
-- home-db (HOME_DB) — the LOGIN: niri → Niri
--
-- This is the account she signs in with, and the one every module is
-- provisioned against. The lookup is case-INSENSITIVE
-- (`WHERE lower(username) = lower(?1)`, src/identity.ts), so she can keep
-- typing `niri` if that is muscle memory — this only makes the stored,
-- displayed, and admin-console spelling `Niri`.
--
-- Her display_name is already `Niri`, which is the giveaway that the casing was
-- never deliberate: the name was right and the username was the typo.
--
-- Nothing else in this database holds the string (checked column by column
-- across every table): sessions key on the user's uuid, `attempts` keys carry an
-- IP, and `share_links.subject` holds device ids.
--
-- IDEMPOTENT: a second run matches no row.
-- ═══════════════════════════════════════════════════════════════════

UPDATE users SET username = 'Niri', display_name = 'Niri' WHERE username = 'niri';
