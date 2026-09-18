-- A group can carry a short icon, which is shown in front of its items on the
-- plan. It is free text so any emoji works, and blank means no icon.
ALTER TABLE subgroups ADD COLUMN icon TEXT;

-- Sensible icons for the groups that ship with the app. Matching by name means
-- this only touches the seeded catalog.
UPDATE subgroups SET icon = '🐔' WHERE name = 'chicken';
UPDATE subgroups SET icon = '🐄' WHERE name = 'beef';
UPDATE subgroups SET icon = '🐖' WHERE name = 'pork';
UPDATE subgroups SET icon = '🐟' WHERE name = 'fish';
UPDATE subgroups SET icon = '🥕' WHERE name = 'vegetables';
UPDATE subgroups SET icon = '🥬' WHERE name = 'greens';
UPDATE subgroups SET icon = '🌾' WHERE name = 'grains';
UPDATE subgroups SET icon = '🫘' WHERE name = 'legumes';
UPDATE subgroups SET icon = '🥗' WHERE name = 'Raw Salad';
UPDATE subgroups SET icon = '🧂' WHERE name = 'spices';
UPDATE subgroups SET icon = '🫒' WHERE name = 'oils';
UPDATE subgroups SET icon = '🧴' WHERE name = 'condiments';
UPDATE subgroups SET icon = '🥫' WHERE name = 'dry staples';
