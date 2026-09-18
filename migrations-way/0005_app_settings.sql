-- WAY (Where Are You) - migration 0005: runtime app settings
-- Run with:
--   wrangler d1 execute way-db --remote --file=migrations/0005_app_settings.sql
--
-- This one IS re-runnable (CREATE TABLE IF NOT EXISTS), unlike 0001-0004, which
-- all use ALTER TABLE and therefore fail with "duplicate column name" on a
-- second run.
--
-- Why this table exists: the ntfy server root used to be hardcoded in
-- wrangler.jsonc's `vars` block, so moving to a different push server meant a
-- code change, a commit and a redeploy. It is now an admin setting edited in
-- Settings -> Users & topics. wrangler.jsonc's NTFY_URL is kept as the built-in
-- fallback, so the resolution order is:
--
--   app_settings.ntfy_url  ->  env.NTFY_URL (wrangler.jsonc)  ->  https://ntfy.sh
--
-- See src/lib/notify.ts (NTFY_URL_SETTING_KEY) and FleetDO.getNotifyConfig().

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
