-- Laoka initial schema.
-- Soft delete is used at every catalog level so that plans, shopping lists and
-- history never break when a group, subgroup or item is removed.
-- Prices are integers in local currency, stored only on a week shopping line.

PRAGMA foreign_keys = ON;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Level 1: Type (Protein, Sides, Pantry)
CREATE TABLE groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  is_pantry  INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_groups_name ON groups(lower(name)) WHERE deleted_at IS NULL;

-- Level 2: Group (chicken, beef, Raw Salad, spices ...)
CREATE TABLE subgroups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL REFERENCES groups(id),
  name       TEXT NOT NULL,
  slot_role  TEXT NOT NULL DEFAULT 'none' CHECK (slot_role IN ('protein','side','salad','none')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_subgroups_group ON subgroups(group_id);
CREATE UNIQUE INDEX idx_subgroups_name ON subgroups(group_id, lower(name)) WHERE deleted_at IS NULL;

-- Level 3: Item (chicken thighs, potatoes, olive oil ...)
CREATE TABLE items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subgroup_id INTEGER NOT NULL REFERENCES subgroups(id),
  name        TEXT NOT NULL,
  selected    INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_items_subgroup ON items(subgroup_id);
CREATE UNIQUE INDEX idx_items_name ON items(subgroup_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE gourmet (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  link       TEXT,
  notes      TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE weeks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','active','archived')),
  budget      INTEGER,
  exported_at TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_weeks_start ON weeks(start_date);

-- Wishlist candidates. Row survives only between generate and save.
CREATE TABLE plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id     INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  is_selected INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_plans_week ON plans(week_id);

CREATE TABLE plan_days (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id    INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  day_date   TEXT NOT NULL,
  day_type   TEXT NOT NULL CHECK (day_type IN ('normal','gourmet')),
  gourmet_id INTEGER REFERENCES gourmet(id),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_plan_days_plan ON plan_days(plan_id);
CREATE UNIQUE INDEX idx_plan_days_unique ON plan_days(plan_id, day_date);

CREATE TABLE plan_day_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_day_id INTEGER NOT NULL REFERENCES plan_days(id) ON DELETE CASCADE,
  slot       TEXT NOT NULL CHECK (slot IN ('protein','side','salad')),
  item_id    INTEGER REFERENCES items(id)
);
CREATE INDEX idx_pdi_day ON plan_day_items(plan_day_id);
CREATE UNIQUE INDEX idx_pdi_unique ON plan_day_items(plan_day_id, slot);

CREATE TABLE shopping_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id    INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  origin     TEXT NOT NULL CHECK (origin IN ('plan','pantry')),
  price      INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_lines_week ON shopping_lines(week_id);
CREATE UNIQUE INDEX idx_lines_unique ON shopping_lines(week_id, item_id);

-- Snapshots. Names, not ids, so history is never bound to the catalog.
CREATE TABLE history_weeks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source_week_id INTEGER NOT NULL,
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  budget         INTEGER,
  exported_at    TEXT,
  archived_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_hist_weeks_source ON history_weeks(source_week_id);

CREATE TABLE history_days (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  history_week_id  INTEGER NOT NULL REFERENCES history_weeks(id) ON DELETE CASCADE,
  day_date         TEXT NOT NULL,
  day_type         TEXT NOT NULL,
  gourmet_title    TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_hist_days_week ON history_days(history_week_id);

CREATE TABLE history_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  history_week_id INTEGER NOT NULL REFERENCES history_weeks(id) ON DELETE CASCADE,
  day_date        TEXT,
  slot            TEXT,
  item_name       TEXT NOT NULL,
  origin          TEXT NOT NULL,
  price           INTEGER
);
CREATE INDEX idx_hist_lines_week ON history_lines(history_week_id);

-- Settings
INSERT INTO settings (key, value) VALUES
  ('timezone', 'Africa/Nairobi'),
  ('default_budget', ''),
  ('wishlist_count', '3'),
  ('max_active_weeks', '2');

-- Level 1
INSERT INTO groups (name, is_pantry, sort_order) VALUES
  ('Protein', 0, 1),
  ('Sides',   0, 2),
  ('Pantry',  1, 3);

-- Level 2
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'chicken',  'protein', 1 FROM groups WHERE name = 'Protein';
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'beef',     'protein', 2 FROM groups WHERE name = 'Protein';
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'pork',     'protein', 3 FROM groups WHERE name = 'Protein';
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'fish',     'protein', 4 FROM groups WHERE name = 'Protein';

INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'vegetables', 'side', 1 FROM groups WHERE name = 'Sides';
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'greens',     'side', 2 FROM groups WHERE name = 'Sides';
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'grains',     'side', 3 FROM groups WHERE name = 'Sides';
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'legumes',    'side', 4 FROM groups WHERE name = 'Sides';
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'Raw Salad',  'salad', 5 FROM groups WHERE name = 'Sides';

INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'spices',       'none', 1 FROM groups WHERE name = 'Pantry';
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'oils',         'none', 2 FROM groups WHERE name = 'Pantry';
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'condiments',   'none', 3 FROM groups WHERE name = 'Pantry';
INSERT INTO subgroups (group_id, name, slot_role, sort_order)
SELECT id, 'dry staples',  'none', 4 FROM groups WHERE name = 'Pantry';

-- Level 3
INSERT INTO items (subgroup_id, name) SELECT id, 'chicken thighs' FROM subgroups WHERE name = 'chicken';
INSERT INTO items (subgroup_id, name) SELECT id, 'chicken breast' FROM subgroups WHERE name = 'chicken';
INSERT INTO items (subgroup_id, name) SELECT id, 'whole chicken'  FROM subgroups WHERE name = 'chicken';
INSERT INTO items (subgroup_id, name) SELECT id, 'beef steak'     FROM subgroups WHERE name = 'beef';
INSERT INTO items (subgroup_id, name) SELECT id, 'ground beef'    FROM subgroups WHERE name = 'beef';
INSERT INTO items (subgroup_id, name) SELECT id, 'beef ribs'      FROM subgroups WHERE name = 'beef';
INSERT INTO items (subgroup_id, name) SELECT id, 'pork belly'     FROM subgroups WHERE name = 'pork';
INSERT INTO items (subgroup_id, name) SELECT id, 'pork chops'     FROM subgroups WHERE name = 'pork';
INSERT INTO items (subgroup_id, name) SELECT id, 'pork ribs'      FROM subgroups WHERE name = 'pork';
INSERT INTO items (subgroup_id, name) SELECT id, 'salmon'         FROM subgroups WHERE name = 'fish';
INSERT INTO items (subgroup_id, name) SELECT id, 'tilapia'        FROM subgroups WHERE name = 'fish';
INSERT INTO items (subgroup_id, name) SELECT id, 'tuna'           FROM subgroups WHERE name = 'fish';

INSERT INTO items (subgroup_id, name) SELECT id, 'potatoes'    FROM subgroups WHERE name = 'vegetables';
INSERT INTO items (subgroup_id, name) SELECT id, 'tomatoes'    FROM subgroups WHERE name = 'vegetables';
INSERT INTO items (subgroup_id, name) SELECT id, 'carrots'     FROM subgroups WHERE name = 'vegetables';
INSERT INTO items (subgroup_id, name) SELECT id, 'cabbage'     FROM subgroups WHERE name = 'vegetables';
INSERT INTO items (subgroup_id, name) SELECT id, 'green beans' FROM subgroups WHERE name = 'vegetables';
INSERT INTO items (subgroup_id, name) SELECT id, 'spinach'      FROM subgroups WHERE name = 'greens';
INSERT INTO items (subgroup_id, name) SELECT id, 'kale'         FROM subgroups WHERE name = 'greens';
INSERT INTO items (subgroup_id, name) SELECT id, 'sukuma wiki'  FROM subgroups WHERE name = 'greens';
INSERT INTO items (subgroup_id, name) SELECT id, 'managu'       FROM subgroups WHERE name = 'greens';
INSERT INTO items (subgroup_id, name) SELECT id, 'rice'         FROM subgroups WHERE name = 'grains';
INSERT INTO items (subgroup_id, name) SELECT id, 'ugali flour'  FROM subgroups WHERE name = 'grains';
INSERT INTO items (subgroup_id, name) SELECT id, 'pasta'        FROM subgroups WHERE name = 'grains';
INSERT INTO items (subgroup_id, name) SELECT id, 'chapati'      FROM subgroups WHERE name = 'grains';
INSERT INTO items (subgroup_id, name) SELECT id, 'dry beans'    FROM subgroups WHERE name = 'legumes';
INSERT INTO items (subgroup_id, name) SELECT id, 'lentils'      FROM subgroups WHERE name = 'legumes';
INSERT INTO items (subgroup_id, name) SELECT id, 'green grams'  FROM subgroups WHERE name = 'legumes';
INSERT INTO items (subgroup_id, name) SELECT id, 'peas'         FROM subgroups WHERE name = 'legumes';

INSERT INTO items (subgroup_id, name) SELECT id, 'lettuce'    FROM subgroups WHERE name = 'Raw Salad';
INSERT INTO items (subgroup_id, name) SELECT id, 'cucumber'   FROM subgroups WHERE name = 'Raw Salad';
INSERT INTO items (subgroup_id, name) SELECT id, 'red onion'  FROM subgroups WHERE name = 'Raw Salad';
INSERT INTO items (subgroup_id, name) SELECT id, 'avocado'    FROM subgroups WHERE name = 'Raw Salad';

INSERT INTO items (subgroup_id, name) SELECT id, 'salt'          FROM subgroups WHERE name = 'spices';
INSERT INTO items (subgroup_id, name) SELECT id, 'black pepper'  FROM subgroups WHERE name = 'spices';
INSERT INTO items (subgroup_id, name) SELECT id, 'curry powder'  FROM subgroups WHERE name = 'spices';
INSERT INTO items (subgroup_id, name) SELECT id, 'chilli'        FROM subgroups WHERE name = 'spices';
INSERT INTO items (subgroup_id, name) SELECT id, 'olive oil'     FROM subgroups WHERE name = 'oils';
INSERT INTO items (subgroup_id, name) SELECT id, 'palm oil'      FROM subgroups WHERE name = 'oils';
INSERT INTO items (subgroup_id, name) SELECT id, 'cooking oil'   FROM subgroups WHERE name = 'oils';
INSERT INTO items (subgroup_id, name) SELECT id, 'soy sauce'     FROM subgroups WHERE name = 'condiments';
INSERT INTO items (subgroup_id, name) SELECT id, 'vinegar'       FROM subgroups WHERE name = 'condiments';
INSERT INTO items (subgroup_id, name) SELECT id, 'tomato sauce'  FROM subgroups WHERE name = 'condiments';
INSERT INTO items (subgroup_id, name) SELECT id, 'wheat flour'   FROM subgroups WHERE name = 'dry staples';
INSERT INTO items (subgroup_id, name) SELECT id, 'sugar'         FROM subgroups WHERE name = 'dry staples';
INSERT INTO items (subgroup_id, name) SELECT id, 'baking powder' FROM subgroups WHERE name = 'dry staples';

-- Gourmet titles
INSERT INTO gourmet (title) VALUES
  ('Sunday roast'),
  ('Family barbecue'),
  ('Pizza night'),
  ('Nyama choma'),
  ('Leftovers and salad');
