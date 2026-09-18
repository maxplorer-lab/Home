-- ============================================================
-- Sompitra – Initial Database Schema
-- Cloudflare D1 (SQLite dialect)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ────────────────────────────────────────────────────────────
-- USERS & SESSIONS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,        -- 'maxx', 'niri'
  display_name TEXT NOT NULL,             -- 'MaxX', 'Niri'
  pin_hash    TEXT NOT NULL,              -- bcrypt-like hash stored server-side
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL,
  expires_at  DATETIME NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────
-- SERVICE 1: BUDGET – INCOME ACCOUNTS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS income_accounts (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,              -- e.g. 'Salary', 'Sales', 'Mini Service Income'
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────
-- SERVICE 1: BUDGET – CATEGORY GROUPS & SUBCATEGORIES
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS category_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,              -- e.g. 'Fixed Expenses', 'Bike 1', 'Living Expenses'
  sort_order  INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES category_groups(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,            -- e.g. 'Rent', 'Fuel', 'Groceries'
  target_budget REAL DEFAULT 0.0,         -- Optional monthly spending target
  sort_order    INTEGER DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────
-- SERVICE 1: BUDGET – TRANSACTIONS (INCOME & EXPENSE)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id                  TEXT PRIMARY KEY,
  date                TEXT NOT NULL,            -- 'YYYY-MM-DD'
  amount              REAL NOT NULL,
  type                TEXT NOT NULL CHECK(type IN ('income','expense')),
  income_account_id   TEXT REFERENCES income_accounts(id) ON DELETE SET NULL,
  category_id         TEXT REFERENCES categories(id) ON DELETE SET NULL,
  description         TEXT,                     -- name / label (e.g. 'Groceries', 'Snack')
  notes               TEXT,                     -- itemised receipt details stored here
  added_by_user_id    TEXT NOT NULL REFERENCES users(id),
  is_recurring        INTEGER DEFAULT 0,        -- 1 = recurring template used for 1-click copy
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────
-- SERVICE 1: DEBTS & CREDITS (0 % interest)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS debt_credit_accounts (
  id              TEXT PRIMARY KEY,
  person_name     TEXT NOT NULL,                -- e.g. 'David'
  type            TEXT NOT NULL CHECK(type IN ('debt','credit')),
                                                -- debt  = we owe someone
                                                -- credit = someone owes us
  initial_amount  REAL NOT NULL,
  current_balance REAL NOT NULL,               -- decrements as payments are made
  notes           TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS debt_credit_payments (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES debt_credit_accounts(id) ON DELETE CASCADE,
  amount                REAL NOT NULL,
  payment_date          TEXT NOT NULL,
  synced_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  notes                 TEXT,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────
-- SERVICE 2: DELIVERY TRACKER – CUSTOMERS & CONTRACTS
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT,
  default_rate  REAL NOT NULL,              -- default per-session rate in MGA
  notes         TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_contracts (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,          -- e.g. '10-Session Package'
  session_rate      REAL NOT NULL,
  total_scheduled   INTEGER NOT NULL,       -- sessions agreed upon
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('active','completed','cancelled')),
  start_date        TEXT NOT NULL,          -- 'YYYY-MM-DD'
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────
-- SERVICE 2: TICK-MARK ATTENDANCE LOG
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_ticks (
  id              TEXT PRIMARY KEY,
  contract_id     TEXT NOT NULL REFERENCES service_contracts(id) ON DELETE CASCADE,
  tick_date       TEXT NOT NULL,            -- 'YYYY-MM-DD'
  is_delivered    INTEGER DEFAULT 1,        -- 1 = delivered
  UNIQUE(contract_id, tick_date)
);

-- ────────────────────────────────────────────────────────────
-- SERVICE 2: CLIENT PAYMENTS & BUDGET SYNC
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS client_payments (
  id                    TEXT PRIMARY KEY,
  contract_id           TEXT NOT NULL REFERENCES service_contracts(id) ON DELETE CASCADE,
  amount                REAL NOT NULL,
  payment_date          TEXT NOT NULL,
  synced_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  notes                 TEXT,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────
-- SERVICE 3: STOCK & SALES MANAGER (future expansion, schema ready)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  cost_price  REAL NOT NULL,
  sale_price  REAL NOT NULL,
  stock_qty   INTEGER DEFAULT 0,
  notes       TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_records (
  id                    TEXT PRIMARY KEY,
  item_id               TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  qty                   INTEGER NOT NULL,
  total_sale            REAL NOT NULL,
  total_cost            REAL NOT NULL,
  sale_date             TEXT NOT NULL,
  synced_income_txn_id  TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  synced_expense_txn_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  notes                 TEXT,
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ────────────────────────────────────────────────────────────
-- INDEXES for common query paths
-- ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_date       ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_type       ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_user       ON transactions(added_by_user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_contract     ON attendance_ticks(contract_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date         ON attendance_ticks(tick_date);
CREATE INDEX IF NOT EXISTS idx_client_payments_contract ON client_payments(contract_id);
CREATE INDEX IF NOT EXISTS idx_debt_payments_account   ON debt_credit_payments(account_id);
