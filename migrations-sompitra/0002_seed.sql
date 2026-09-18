-- ============================================================
-- Sompitra – Seed Data
-- Inserts default users, income accounts, and category groups
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- USERS  (PINs are set via the app's first-run setup screen)
-- ────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO users (id, username, display_name, pin_hash)
VALUES
  ('usr_maxx', 'maxx', 'MaxX', 'SETUP_REQUIRED'),
  ('usr_niri', 'niri', 'Niri', 'SETUP_REQUIRED');

-- ────────────────────────────────────────────────────────────
-- INCOME ACCOUNTS
-- ────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO income_accounts (id, user_id, name) VALUES
  ('inc_maxx_salary',      'usr_maxx', 'Salary'),
  ('inc_maxx_sales',       'usr_maxx', 'Sales'),
  ('inc_niri_salary',      'usr_niri', 'Salary'),
  ('inc_niri_miniservice', 'usr_niri', 'Kiné Privée');

-- ────────────────────────────────────────────────────────────
-- CATEGORY GROUPS
-- ────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO category_groups (id, name, sort_order) VALUES
  ('cg_fixed',   'Fixed Expenses',   1),
  ('cg_bike1',   'Bike 1',           2),
  ('cg_living',  'Living Expenses',  3),
  ('cg_health',  'Health & Fitness', 4);

-- ────────────────────────────────────────────────────────────
-- CATEGORIES (SUBCATEGORIES)
-- ────────────────────────────────────────────────────────────

-- Fixed Expenses
INSERT OR IGNORE INTO categories (id, group_id, name, sort_order) VALUES
  ('cat_rent',        'cg_fixed',  'Rent',            1),
  ('cat_gas',         'cg_fixed',  'Gas',             2),
  ('cat_electricity', 'cg_fixed',  'Electricity',     3),
  ('cat_water',       'cg_fixed',  'Water',           4),
  ('cat_internet',    'cg_fixed',  'Internet / Wifi', 5);

-- Bike 1
INSERT OR IGNORE INTO categories (id, group_id, name, sort_order) VALUES
  ('cat_fuel',        'cg_bike1',  'Fuel',                   1),
  ('cat_oil',         'cg_bike1',  'Oil Change',             2),
  ('cat_maintenance', 'cg_bike1',  'Maintenance & Repairs',  3),
  ('cat_insurance',   'cg_bike1',  'Insurance / Taxes',      4);

-- Living Expenses
INSERT OR IGNORE INTO categories (id, group_id, name, sort_order) VALUES
  ('cat_groceries',   'cg_living', 'Groceries',      1),
  ('cat_dining',      'cg_living', 'Dining Out',     2),
  ('cat_snacks',      'cg_living', 'Snacks',         3),
  ('cat_household',   'cg_living', 'House Supplies', 4),
  ('cat_personal',    'cg_living', 'Personal Care',  5);

-- Health & Fitness
INSERT OR IGNORE INTO categories (id, group_id, name, sort_order) VALUES
  ('cat_medical',  'cg_health', 'Medical / Pharmacy', 1),
  ('cat_fitness',  'cg_health', 'Fitness',            2);
