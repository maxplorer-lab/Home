-- ═══════════════════════════════════════════════════════════════
-- Home — the central identity database (home-db)
--
-- ONE user directory for the whole super app. The login is
-- username + password; an admin creates every account. Each module
-- (Sompitra, WAY, Laoka) keeps its own database and its own session
-- mechanism — home-db only decides WHO may sign in, not what they
-- can do inside a module.
--
-- Password hashing mirrors Laoka's scheme exactly (HMAC pepper +
-- PBKDF2-SHA-256, base64 columns, per-row iteration count) so the
-- same crypto code can verify logins and provision Laoka accounts
-- without any conversion.
--
-- Columns password_hash / password_salt are intentionally NULL-able:
-- an account may exist before the user picks a password (see admin
-- console "reset" flow).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL,
  display_name        TEXT,
  role                TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  password_hash       TEXT,
  password_salt       TEXT,
  password_iterations INTEGER NOT NULL DEFAULT 5000,
  is_active           INTEGER NOT NULL DEFAULT 1,
  last_login_at       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_home_users_username ON users(lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_seen  TEXT
);
CREATE INDEX IF NOT EXISTS idx_home_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_home_sessions_expires ON sessions(expires_at);

-- Failed sign-ins, to blunt password guessing.
CREATE TABLE IF NOT EXISTS attempts (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);
