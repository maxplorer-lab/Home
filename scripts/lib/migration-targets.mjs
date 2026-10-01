// The ONE place that pairs a migrations directory with the database it describes.
//
// `scripts/schema-audit.mjs` judges the real databases against these files, and
// `scripts/db-migrate.mjs` builds a database from them. If the two ever picked
// different directories, a database would be audited against one set of files and
// created from another — which is exactly the trap Home audit H-A1 describes:
// Laoka's repo stopped at migration 0008 while `migrations-laoka/` carries the
// three pantry files Home actually serves, so the module repo's own directory
// produced a database the app could not use.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * [migrations directory, binding, SQL that must follow that chain] — the four
 * databases Home serves, in build order.
 *
 * The third element is for statements a database built from the chain still
 * needs. WAY has exactly one: `0002_settings.sql` DROPS the `devices` table
 * `0001_init.sql` created, and `messages.device_id` still carries
 * `REFERENCES devices(device_id)`, so D1 resolves the FK parent when a `messages`
 * insert is prepared — with no `devices` table EVERY chat-flush insert fails
 * (rule 19, `CUTOVER.md`). The repair file is idempotent and derives its rows, so
 * it is applied only when the table it creates is absent.
 */
export const DATABASES = [
  ['migrations-home', 'HOME_DB', []],
  ['migrations-sompitra', 'DB', []],
  ['migrations-way', 'WAY_DB', ['scripts/repair-way-messages-fk.sql']],
  ['migrations-laoka', 'LAOKA_DB', []],
]

/**
 * Every `.sql` in `root/dir`, in the order it must be applied.
 *
 * The filenames carry a zero-padded 4-digit prefix (`0000_baseline.sql` …
 * `0011_default_ntfy_server.sql`), so a plain lexicographic sort IS the numeric
 * order — including `0000_baseline.sql`, which a `0001`+ filter would drop.
 */
export function migrationFiles(root, dir) {
  return readdirSync(join(root, dir))
    .filter((name) => name.endsWith('.sql'))
    .sort()
}
