-- ============================================================
-- Sompitra – App settings (key/value) + ntfy notification config
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Editable in Settings → Notifications (admin only).
-- Leave the topic empty to disable push notifications.
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('ntfy_server', 'https://ntfy-424942506653.africa-south1.run.app'),
  ('ntfy_topic',  '');
