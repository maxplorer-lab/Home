-- ============================================================
-- Sompitra – Retarget the seeded ntfy default
-- ============================================================
-- 0009 seeded `ntfy_server` with a Cloud Run host that has since been retired
-- (both of its URLs answer 404). The live deployment was pointed at the
-- replacement by hand in Settings, so only a database built from the
-- migrations alone — a fresh local dev DB, or a rebuild — still gets the dead
-- host. A dead default stays invisible until a notification is expected:
-- pushes fail silently, which is the worst failure mode this app has.
--
-- The replacement is the self-hosted instance behind its DuckDNS name, the
-- same value home-db's `home_settings.ntfy_server` carries.
--
-- Guarded on purpose: a database that has deliberately been pointed somewhere
-- else keeps its value — only the two known-dead seeds are replaced.

UPDATE app_settings
   SET value = 'https://maxxntfy.duckdns.org'
 WHERE key = 'ntfy_server'
   AND value IN (
     'https://ntfy-424942506653.africa-south1.run.app',
     'https://ntfy-424942506653.us-central1.run.app'
   );
