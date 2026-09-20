-- ═══════════════════════════════════════════════════════════════════
-- Laoka (LAOKA_DB) — her login name: niri → Niri
--
-- Laoka keeps its own accounts and its own sessions; the name is looked up
-- case-insensitively, so her sign-in is unaffected either way.
--
-- `gourmet.image` also "contains" the string, and is NOT touched on purpose: it
-- is a base64 JPEG whose bytes happen to spell it.
--
-- IDEMPOTENT: a second run matches no row.
-- ═══════════════════════════════════════════════════════════════════

UPDATE users SET username = 'Niri' WHERE username = 'niri';
