-- ============================================================
-- Sompitra – Normalise stored usernames to lowercase
-- ============================================================
-- Sompitra resolves a person by the username column in the login card and in
-- the admin PIN reset. Both now compare with lower(username), but the stored
-- value itself is also expected to be canonical lowercase: it is rendered as
-- the chat identity (`data-me`), it is the key the WAY bridge matches against
-- (`WAY_ME`), and it is the option value an admin's reset form submits.
--
-- A row edited by hand outside the repo can drift to 'Niri'/'MaxX'. SQLite's
-- default BINARY collation then makes that row unreachable for a lowercase
-- lookup. This migration repairs the stored data; the case-insensitive
-- lookups above are the second line of defence, not a substitute.
--
-- Idempotent: lower() on an already-lowercase value is a no-op.

UPDATE users SET username = lower(username);
