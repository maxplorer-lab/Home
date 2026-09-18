-- ============================================================
-- Sompitra – Liability category for debt/credit transactions
-- ============================================================

INSERT OR IGNORE INTO category_groups (id, name, sort_order) VALUES ('cg_liabilities', 'Liabilities', 5);

INSERT OR IGNORE INTO categories (id, group_id, name, target_budget, sort_order) VALUES ('cat_liability', 'cg_liabilities', 'Liability', 0, 1);
