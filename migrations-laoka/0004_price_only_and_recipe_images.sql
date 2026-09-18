-- Price is the only line state again: no separate bought flag with its own
-- checkbox. A line with a price above zero is bought.
ALTER TABLE shopping_lines DROP COLUMN bought;

-- Recipe pictures. Stored inline because a family keeps a handful of recipes,
-- the client downscales before upload, and this avoids adding an R2 bucket to
-- the deployment. image holds base64 without the data URL prefix.
ALTER TABLE gourmet ADD COLUMN image TEXT;
ALTER TABLE gourmet ADD COLUMN image_type TEXT;
ALTER TABLE gourmet ADD COLUMN image_updated_at TEXT;
