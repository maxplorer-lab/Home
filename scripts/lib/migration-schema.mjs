// What a set of migration files PROMISES a database should look like — and which
// file each piece of that promise came from.
//
// Two consumers, one implementation: `scripts/schema-audit.mjs` asks "is every
// migration applied?" of the real databases, and `scripts/db-migrate.mjs` asks
// "which files does THIS database still lack?" before applying anything. D1 keeps
// no record of what has run, so this replay IS the record — it is the only reason
// either script can answer at all, which is why the two must not grow separate
// copies of it.
//
// Reading these files naively lies in five ways, each hit while writing this:
//   1. COMMENTS. `-- every statement is CREATE TABLE IF NOT EXISTS, so…` is prose,
//      but a regex that does not strip comments reads it as DDL and reports a
//      table named "IF". Stripped below, both `--` and `/* */`.
//   2. DROPS. Laoka's 0004 drops the column 0002 added. A union of every ADD/DROP
//      ever written is not the schema — so files are replayed IN ORDER and a drop
//      removes its column again.
//   3. DROPPED TABLES. `migrations-way/0002_settings.sql` drops the `devices`
//      table `0001_init.sql` created (the FK-parent story in that file's comment).
//      A replay that only tracked columns kept expecting `devices` forever, which
//      made `audit:remote` report a gap on a correct database and made
//      `db:local` call `0001_init.sql` half-applied.
//   4. RENAMES. Laoka's 0005 builds `users_new` and renames it to `users`. The
//      intermediate name never exists in a finished database, so it is not
//      expected either — and the credit for creating the table follows the rename.
//   5. INDEXES. A `CREATE INDEX` declares no table and no column, so a file whose
//      only statement it is looked like a seed: `db-migrate.mjs` filed it under
//      "data-only" (never applied to a live database) and `audit:remote` could not
//      see it missing. `migrations-way/0008_way_indexes.sql` is the first file of
//      that shape, which is what surfaced this.
import { readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Strip SQL comments, so prose about DDL is never read as DDL. */
export function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** A migrations directory: an absolute path used as given, a bare name under `root`. */
export function resolveDir(root, dir) {
  return isAbsolute(dir) ? dir : join(root, dir)
}

const key = (table, column) => `${table}\u0000${column}`

/**
 * Replay a list of SQL files, in order, into the schema they promise.
 *
 * `createdBy` / `addedBy` carry the same entries as `tables` / `added` and say
 * which file put them there — that is what lets the per-file attribution below
 * exist, and therefore lets `db:local` decide which files a database is missing.
 */
function replay(entries) {
  const tables = new Set()
  /** table → Set(column) for columns added by migrations (never the base ones). */
  const added = new Map()
  const dropped = new Map()
  const createdBy = new Map()
  const addedBy = new Map()
  const indexes = new Set()
  const indexedBy = new Map()

  for (const { path, key: display } of entries) {
    const sql = stripComments(readFileSync(path, 'utf8'))
    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+["'`]?(\w+)["'`]?/gi)) {
      tables.add(m[1])
      if (!createdBy.has(m[1])) createdBy.set(m[1], display)
    }
    for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+["'`]?(\w+)["'`]?/gi)) {
      indexes.add(m[1])
      if (!indexedBy.has(m[1])) indexedBy.set(m[1], display)
    }
    for (const m of sql.matchAll(/ALTER TABLE\s+["'`]?(\w+)["'`]?\s+ADD COLUMN\s+["'`]?(\w+)["'`]?/gi)) {
      if (!added.has(m[1])) added.set(m[1], new Set())
      added.get(m[1]).add(m[2])
      dropped.get(m[1])?.delete(m[2])
      if (!addedBy.has(key(m[1], m[2]))) addedBy.set(key(m[1], m[2]), display)
    }
    // A dropped column is not part of the finished schema, even though a later
    // file may never mention it again.
    for (const m of sql.matchAll(/ALTER TABLE\s+["'`]?(\w+)["'`]?\s+DROP COLUMN\s+["'`]?(\w+)["'`]?/gi)) {
      if (!dropped.has(m[1])) dropped.set(m[1], new Set())
      dropped.get(m[1]).add(m[2])
      added.get(m[1])?.delete(m[2])
      addedBy.delete(key(m[1], m[2]))
    }
    // A dropped table takes its creator's credit and any columns added to it with
    // it — and nobody's database has it afterwards.
    for (const m of sql.matchAll(/DROP TABLE(?:\s+IF EXISTS)?\s+["'`]?(\w+)["'`]?/gi)) {
      tables.delete(m[1])
      createdBy.delete(m[1])
      for (const column of added.get(m[1]) ?? []) addedBy.delete(key(m[1], column))
      added.delete(m[1])
    }
    for (const m of sql.matchAll(/DROP\s+INDEX(?:\s+IF\s+EXISTS)?\s+["'`]?(\w+)["'`]?/gi)) {
      indexes.delete(m[1])
      indexedBy.delete(m[1])
    }
    // A rename means the source name was an intermediate: nobody's database has
    // `users_new` in it once the migration finishes — and whoever created the old
    // name created the new one.
    for (const m of sql.matchAll(/ALTER TABLE\s+["'`]?(\w+)["'`]?\s+RENAME TO\s+["'`]?(\w+)["'`]?/gi)) {
      tables.delete(m[1])
      tables.add(m[2])
      if (createdBy.has(m[1])) {
        createdBy.set(m[2], createdBy.get(m[1]))
        createdBy.delete(m[1])
      }
    }
  }

  return { tables, added, createdBy, addedBy, indexes, indexedBy }
}

/** Every `.sql` in a directory, in the order the prefix says to apply it. */
function filesIn(absDir) {
  return readdirSync(absDir).filter((f) => f.endsWith('.sql')).sort()
}

/** Replay a directory's migrations in order into the schema they promise. */
export function expectedSchema(root, dir) {
  const at = resolveDir(root, dir)
  const { tables, added, createdBy, addedBy, indexes } = replay(filesIn(at).map((f) => ({ path: join(at, f), key: f })))
  return { tables, added, createdBy, addedBy, indexes }
}

/**
 * Per file, the objects in the FINISHED schema it is responsible for.
 *
 * Files with no entry declare no schema objects at all — a seed, a rename, a
 * settings default. Nothing in `sqlite_master` can say whether those have run, so
 * `db-migrate.mjs` treats them as a separate case instead of guessing.
 */
export function objectsByFile(root, dir) {
  const at = resolveDir(root, dir)
  return objectsFrom(replay(filesIn(at).map((f) => ({ path: join(at, f), key: f }))))
}

/**
 * The same attribution for an explicit list of paths, keyed by the path given.
 * Used for SQL that is not a migration chain step — WAY's `devices` FK repair,
 * which a database built from `migrations-way/` needs because 0002 drops the
 * table 0001 created.
 */
export function objectsForPaths(root, paths) {
  return objectsFrom(replay(paths.map((p) => ({ path: isAbsolute(p) ? p : join(root, p), key: p }))))
}

function objectsFrom({ tables, added, createdBy, addedBy, indexes, indexedBy }) {
  const byFile = new Map()
  const bucket = (display) => {
    if (!display) return null
    if (!byFile.has(display)) byFile.set(display, { tables: [], columns: [], indexes: [] })
    return byFile.get(display)
  }
  for (const table of tables) bucket(createdBy.get(table))?.tables.push(table)
  for (const [table, columns] of added) {
    for (const column of columns) bucket(addedBy.get(key(table, column)))?.columns.push([table, column])
  }
  for (const name of indexes) bucket(indexedBy.get(name))?.indexes.push(name)
  return byFile
}

/**
 * The one read-only query that reports a database's actual schema.
 *
 * Built from the per-file objects so that a single round trip answers for every
 * file; `(SELECT group_concat(name) FROM pragma_table_info('t'))` yields NULL
 * rather than erroring for a table that does not exist, which is what makes one
 * query enough.
 */
export function buildSchemaQuery(byFile) {
  const tables = new Set()
  const added = new Map()
  const indexes = new Set()
  for (const { tables: t, columns, indexes: ix } of byFile.values()) {
    for (const table of t) tables.add(table)
    for (const [table, column] of columns) {
      if (!added.has(table)) added.set(table, new Set())
      added.get(table).add(column)
    }
    for (const name of ix) indexes.add(name)
  }
  return schemaQueryFor({ tables, added, indexes })
}

/** The same query from a replayed promise ({ tables, added, indexes } as expectedSchema returns). */
export function schemaQueryFor({ tables, added, indexes = new Set() }) {
  const cols = [...added.keys()].map((t) => `(SELECT group_concat(name) FROM pragma_table_info('${t}')) AS ${columnAlias(t)}`)
  // A second one-off subquery, and only when the files declare an index: it is
  // how a `CREATE INDEX` file's work becomes visible to both callers.
  const ix = indexes.size ? ", (SELECT group_concat(name) FROM sqlite_master WHERE type='index') AS indexes" : ''
  return {
    tables: [...tables],
    added,
    indexes,
    sql: `SELECT (SELECT group_concat(name) FROM sqlite_master WHERE type='table') AS tables${cols.length ? ', ' + cols.join(', ') : ''}${ix}`,
  }
}

/** The result alias a table's column list arrives under (`t` → `c_t`). */
export function columnAlias(table) {
  return `c_${table}`
}
