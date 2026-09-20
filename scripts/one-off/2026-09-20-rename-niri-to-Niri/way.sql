-- ═══════════════════════════════════════════════════════════════════
-- W.A.Y (WAY_DB) — one spelling for one person: niri → Niri
--
-- The state this fixes: `devices` holds THREE rows — MaxX, a cutover SEED
-- named `Niri` (tid M2, 🛵, #e67e22, credential CHANGE_ME_niri_device_user,
-- 0 pings ever) and the LIVE device `niri` (10,960 pings) — while the account,
-- and therefore every ping's device_id (`deviceId = user.username`,
-- src/way/routes/ingest.ts), is the lowercase one.
--
-- ORDER MATTERS and is not cosmetic: messages.device_id carries
-- `REFERENCES devices(device_id)` and D1 enforces it. So every child moves onto
-- the surviving row BEFORE that row's key changes, and the duplicate is deleted
-- while it is unreferenced. Doing it the other way round fails the whole batch
-- (which is safe — a `--file` run is transactional — but it does not do the job).
--
-- IDEMPOTENT: every statement is guarded by the data it looks for, so a second
-- run is a no-op. That is wanted: the Durable Object still holds today's pings
-- under `niri` and writes them to gps_pings at the 21:00 UTC flush, so this file
-- is meant to be re-run after that flush or after the phone re-authenticates.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Every message onto the surviving device row. The 108 rows stamped `niri`
--    retarget onto `Niri` (which exists: the seed), and the 5 already on `Niri`
--    stay put — one row, all of them.
UPDATE messages SET device_id = 'Niri' WHERE device_id = 'niri';

-- 2. The duplicate goes, once nothing references it. Guarded on the surviving row
--    existing, so a second run cannot delete the row the first run kept.
DELETE FROM devices
 WHERE device_id = 'niri'
   AND EXISTS (SELECT 1 FROM devices d WHERE d.device_id = 'Niri');

-- 3. The survivor carries the person's real identity: her NAME as the device, and
--    an honest credential field. tid/emoji/colour are already the family's
--    (M2, 🛵, #e67e22) — they came from the seed, and they are what the map and
--    the chat were meant to show for her all along.
UPDATE devices
   SET device_id = 'Niri', display_name = 'Niri', username = 'Niri'
 WHERE device_id = 'Niri';

-- 4. The ping history: 10,960 rows, no foreign key, the whole point of doing this
--    as a rename rather than a delete.
UPDATE gps_pings SET device_id = 'Niri' WHERE device_id = 'niri';

-- 5. The chat's own name columns. `sender` and `reply_to_sender` are free text
--    (no FK), and `reaction_users` is a JSON-ish list, so the name inside it is
--    replaced in place — quoted, to avoid touching a longer word that contains it.
UPDATE messages SET sender = 'Niri' WHERE sender = 'niri';
UPDATE messages SET reply_to_sender = 'Niri' WHERE reply_to_sender = 'niri';
UPDATE messages SET reaction_users = replace(reaction_users, '"niri"', '"Niri"')
 WHERE reaction_users LIKE '%"niri"%';

-- 6. The account last, and this is the line that changes what her phone must
--    send: the μlogger ingest authenticates with a case-SENSITIVE lookup, so the
--    phone's username field has to become `Niri` (password unchanged). Her data
--    does not move — this is the same row, same id, same password hash.
UPDATE users SET username = 'Niri' WHERE username = 'niri';
