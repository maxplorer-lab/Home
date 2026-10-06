-- Accounts become local: a username and a password, no email or phone needed.
-- Access is granted either by a 6 digit invite code from an admin, or, for the
-- very first account, by the deployer's setup token.
--
-- users.email carries a UNIQUE constraint, and SQLite refuses to drop a column
-- that is indexed, so the table is rebuilt rather than altered.
--
-- 2026-10-06: the table is `laoka_users`, and its session table is
-- `laoka_sessions`. Laoka's tables now share a database with Sompitra's, which
-- already owns `users` and `sessions` -- so both are prefixed here.

CREATE TABLE laoka_users_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  display_name        TEXT,
  password_hash       TEXT,
  password_salt       TEXT,
  password_iterations INTEGER NOT NULL DEFAULT 5000,
  last_login_at       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Carry anyone who already existed over as a named account without a password.
-- They will need an invite, or the setup token, to set one.
INSERT INTO laoka_users_new (id, username, role, display_name, created_at)
SELECT
  id,
  CASE WHEN instr(email, '@') > 0 THEN substr(email, 1, instr(email, '@') - 1) ELSE email END,
  role,
  display_name,
  created_at
FROM laoka_users;

DROP TABLE laoka_users;
ALTER TABLE laoka_users_new RENAME TO laoka_users;

CREATE UNIQUE INDEX idx_laoka_users_username ON laoka_users(lower(username));

CREATE TABLE laoka_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES laoka_users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX idx_laoka_sessions_user ON laoka_sessions(user_id);
CREATE INDEX idx_laoka_sessions_expiry ON laoka_sessions(expires_at);

CREATE TABLE invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES laoka_users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_by    INTEGER REFERENCES laoka_users(id),
  used_at    TEXT
);

-- Failed sign-ins and sign-ups, to blunt guessing at a 6 digit code.
CREATE TABLE attempts (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);
