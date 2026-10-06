#!/usr/bin/env node
// ─── Fold `way-db` into `home-db`, and `laoka` into `sompitra-db` ──────────
//
//   node scripts/one-off/2026-10-06-merge-databases/merge-databases.mjs core
//        → export + rewrite + write ./out/*.sql, touch NO database
//   node scripts/one-off/2026-10-06-merge-databases/merge-databases.mjs core --apply
//        → the same, then EXECUTE the rewritten files against the real target
//   ... same for `household`, or `all` for both (schema then data, in order).
//
// WHY THIS IS A ONE-OFF AND NOT A MIGRATION.
// The four databases became two by POINTING TWO BINDING PAIRS AT ONE ID EACH
// (wrangler.jsonc) and renaming the three tables that would have collided:
//
//   HOME_DB + WAY_DB   → home-db     (W.A.Y's `users` is `way_users`)
//   DB      + LAOKA_DB → sompitra-db (Laoka's `users`/`sessions` are
//                                    `laoka_users`/`laoka_sessions`)
//
// A migration can BUILD that schema (migrations-way/ and migrations-laoka/ now
// declare the prefixed names, and `npm run db:local` proves it), but it cannot
// MOVE the rows: D1 has no cross-database query, so the only way to copy is
// through a file. This script is that file path, and it reads the SOURCE by
// DATABASE NAME — not by binding — because after the merge no binding points at
// `way-db` or `laoka` any more (they are kept as rollback copies).
//
// The rewrite is `\b<name>\b`, which is deliberately narrow: W.A.Y's `messages`
// carries a COLUMN called `reaction_users`, and `_` is a word character in every
// regex engine this runs on, so `\busers\b` cannot reach inside it. The index
// renames are listed separately for the same reason — `idx_users_username` has
// no word boundary before `users` either, so it needs its own entry.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
// Through node itself, not `npx`: on Windows the npx shim is not spawnable without
// a shell (ENOENT). Same reason and same pattern as scripts/db-migrate.mjs.
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

/**
 * One merge: the database being folded in, the binding it lands in, and every
 * identifier that has to change on the way. `source` is a NAME, not a binding —
 * `wrangler d1 export <name>` resolves it against the account, which is exactly
 * what is needed for a database no binding mentions any more.
 */
const MERGES = {
  core: {
    source: 'way-db',
    target: 'HOME_DB',
    why: 'W.A.Y (way_users + tracking tables) into the identity database',
    identifiers: { users: 'way_users' },
  },
  household: {
    source: 'laoka',
    target: 'DB',
    why: "Laoka (laoka_users, laoka_sessions, weeks, plans, items…) into Sompitra's",
    identifiers: {
      idx_users_username: 'idx_laoka_users_username',
      idx_sessions_user: 'idx_laoka_sessions_user',
      idx_sessions_expiry: 'idx_laoka_sessions_expiry',
      users: 'laoka_users',
      sessions: 'laoka_sessions',
    },
  },
}

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const which = argv.find((a) => !a.startsWith('--')) || null
const apply = has('--apply')
const onlySchema = has('--schema')
const onlyData = has('--data')

if (!which || (which !== 'all' && !MERGES[which])) {
  console.error(`merge-databases: pick a merge — ${Object.keys(MERGES).join(', ')}, or all.`)
  console.error('  (dry run by default; add --apply to write to the real databases)')
  process.exit(2)
}

const chosen = which === 'all' ? Object.keys(MERGES) : [which]

function wrangler(args, { quiet = false } = {}) {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
    // The export prints a one-hour R2 link; keep it out of the way but visible.
    ...(quiet ? {} : {}),
  })
}

/** Every identifier in `map` as a whole word, longest first so a rename can never
 *  eat another rule's source (`idx_users_username` before `users`). */
function rewrite(sql, map) {
  let out = sql
  for (const [from, to] of Object.entries(map).sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to)
  }
  return out
}

/** A count of the rows the target would end up with, per table, so the plan can
 *  be read rather than trusted. */
function rowCounts(identifier, tables) {
  const sql = `SELECT ${tables
    .map((t) => `(SELECT COUNT(*) FROM "${t}") AS c_${t}`)
    .join(', ')}`
  const out = wrangler(['d1', 'execute', identifier, '--remote', '--json', '--yes', `--command=${sql}`])
  return JSON.parse(out.slice(out.indexOf('[')))[0].results[0]
}

/** The tables an exported SQL file creates (or inserts into). */
function tablesIn(sql) {
  const names = new Set()
  for (const m of sql.matchAll(/(?:CREATE TABLE|INSERT INTO|INSERT OR IGNORE INTO)\s+(?:IF NOT EXISTS\s+)?["'`[]?(\w+)/gi)) {
    names.add(m[1])
  }
  return [...names]
}

/** Split a schema dump into `table name → CREATE TABLE body` — the one place the
 *  schema's text is parsed, for both foreign keys and primary keys. */
function tableBodies(schemaSql) {
  const bodies = new Map()
  for (const part of schemaSql.split(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+/i).slice(1)) {
    const name = (part.match(/^"?(\w+)/) || [])[1]
    if (!name) continue
    const end = part.indexOf(');')
    bodies.set(name, end === -1 ? part : part.slice(0, end))
  }
  return bodies
}

/** The tables of a (rewritten) schema, each mapped to the tables it REFERENCES. */
function foreignKeyOrder(schemaSql, tables) {
  const deps = new Map()
  for (const [name, body] of tableBodies(schemaSql)) {
    const refs = [...body.matchAll(/REFERENCES\s+"?([\w]+)/gi)].map((r) => r[1])
    deps.set(name, [...new Set(refs)])
  }
  // Kahn, but scanning the file's own order each pass so unrelated tables keep it.
  const present = new Set(tables)
  const remaining = [...tables]
  const placed = new Set()
  const out = []
  while (remaining.length) {
    let moved = false
    for (let i = 0; i < remaining.length; ) {
      const need = (deps.get(remaining[i]) || []).filter((d) => d !== remaining[i] && present.has(d))
      if (need.every((d) => placed.has(d))) {
        out.push(remaining[i]); placed.add(remaining[i]); remaining.splice(i, 1); moved = true
      } else i += 1
    }
    if (!moved) { out.push(...remaining); break } // a cycle: leave it in file order
  }
  return out
}

/** Put a dumped data file's row blocks in dependency order: every table after the
 *  tables it points at. D1 runs a `--file` statement by statement and does NOT
 *  defer foreign keys, so `PRAGMA defer_foreign_keys=TRUE` (which the export
 *  writes) buys nothing there — a child row before its parent is refused. The
 *  dump happens to emit way-db's `messages` (FK → devices.device_id) several
 *  blocks ahead of `devices`, so the order has to be fixed on the way out. */
function reorderByForeignKeys(dataSql, schemaSql) {
  const prelude = []
  const blocks = new Map()
  for (const line of dataSql.split('\n')) {
    const m = line.match(/^INSERT INTO\s+"?(\w+)/i)
    if (!m) { prelude.push(line); continue }
    const rows = blocks.get(m[1]) || []
    rows.push(line)
    blocks.set(m[1], rows)
  }
  const out = [...prelude]
  for (const t of foreignKeyOrder(schemaSql, [...blocks.keys()])) out.push(...blocks.get(t))
  return out.join('\n')
}

/** A table's INTEGER PRIMARY KEY column — the only handle a chunked UPDATE has. */
function pkColumns(schemaSql) {
  const pk = new Map()
  for (const [name, body] of tableBodies(schemaSql)) {
    const m = body.match(/(\w+)\s+INTEGER\s+PRIMARY\s+KEY/i)
    if (m) pk.set(name, m[1])
  }
  return pk
}

/** One `VALUES (…)` list split into its top-level comma-separated literals. */
function splitValues(list) {
  const out = []
  let cur = ''
  let inStr = false
  let depth = 0
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i]
    if (inStr) {
      cur += ch
      if (ch === "'") {
        if (list[i + 1] === "'") cur += list[(i += 1)]
        else inStr = false
      }
      continue
    }
    if (ch === "'") { inStr = true; cur += ch; continue }
    if (ch === '(') { depth += 1; cur += ch; continue }
    if (ch === ')') { depth -= 1; cur += ch; continue }
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

/** D1 refuses a single statement much past 100 KB (`SQLITE_TOOBIG`), and Laoka
 *  keeps a recipe photo inline as a base64 data URL — one `gourmet` row is
 *  177 KB on its own. Such a row becomes a short INSERT (the big column set to
 *  empty) followed by UPDATEs that append the value in pieces, each well under
 *  the wire limit. Only plain single-quoted TEXT literals are ever this long. */
function chunkLongInserts(sql, schemaSql, maxLiteral = 16_000) {
  const pk = pkColumns(schemaSql)
  const out = []
  for (const line of sql.split('\n')) {
    if (line.length <= maxLiteral || !/^INSERT INTO/i.test(line)) { out.push(line); continue }
    const m = line.match(/^INSERT INTO\s+"?(\w+)"?\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\);\s*$/i)
    if (!m) { out.push(line); continue }
    const [, table, colList, valList] = m
    const cols = colList.split(',').map((c) => c.trim().replace(/^"/, '').replace(/"$/, ''))
    const vals = splitValues(valList)
    const key = pk.get(table)
    const at = key ? cols.indexOf(key) : -1
    if (at === -1 || vals.length !== cols.length) { out.push(line); continue }
    const big = vals.map((v, i) => i).filter((i) => vals[i].length > maxLiteral && /^'[^']*'$/.test(vals[i]))
    if (!big.length) { out.push(line); continue }
    const short = vals.map((v, i) => (big.includes(i) ? "''" : v))
    out.push(`INSERT INTO "${table}" (${colList}) VALUES (${short.join(',')});`)
    for (const i of big) {
      const inner = vals[i].slice(1, -1)
      for (let p = 0; p < inner.length; p += maxLiteral) {
        const piece = inner.slice(p, p + maxLiteral)
        out.push(`UPDATE "${table}" SET "${cols[i]}" = "${cols[i]}" || '${piece}' WHERE "${key}" = ${vals[at]};`)
      }
    }
  }
  return out.join('\n')
}

console.log(`\n  2026-10-06 database merge${apply ? '   ⚠ APPLY — the real databases are written' : '   (dry run — nothing is written)'}\n`)

for (const key of chosen) {
  const merge = MERGES[key]
  const outDir = join(HERE, 'out')
  mkdirSync(outDir, { recursive: true })

  console.log(`  ${key.padEnd(9)} ${merge.source} → ${merge.target}   (${merge.why})`)

  for (const phase of onlySchema ? ['schema'] : onlyData ? ['data'] : ['schema', 'data']) {
    const file = join(outDir, `${key}-${phase}.sql`)
    const flag = phase === 'schema' ? '--no-data' : '--no-schema'
    rmSync(file, { force: true })
    // The export is READ-ONLY on the source; the rewrite happens on the file.
    wrangler(['d1', 'export', merge.source, '--remote', flag, `--output=${file}`])
    let rewritten = rewrite(readFileSync(file, 'utf8'), merge.identifiers)
    // AUTOINCREMENT bookkeeping, dropped on purpose. The export reports
    // `sqlite_sequence` verbatim — a `DELETE FROM sqlite_sequence;` at the end of
    // the schema file, and one INSERT per table at the end of the data file —
    // and NEITHER is wanted here: the target is not a fresh database, so the
    // DELETE would zero the sequences of ITS OWN tables, and an INSERT whose
    // table name already exists there would be refused on the last line of a
    // 20 MB file (the worst place to stop halfway). It is all unnecessary
    // anyway: SQLite recomputes a sequence from the explicit ids the same file
    // inserts.
    rewritten = rewritten
      .replace(/^DELETE FROM sqlite_sequence;\r?\n?/gm, '')
      .replace(/^INSERT INTO "sqlite_sequence".*;\r?\n?/gm, '')
    if (phase === 'data') {
      const schemaFile = join(outDir, `${key}-schema.sql`)
      if (!existsSync(schemaFile)) {
        // Running `--data` on its own: the schema phase has not written it yet,
        // so pull one (and rewrite it the same way) just to read the FKs from.
        wrangler(['d1', 'export', merge.source, '--remote', '--no-data', `--output=${schemaFile}`])
        writeFileSync(schemaFile, rewrite(readFileSync(schemaFile, 'utf8'), merge.identifiers))
      }
      const schemaSql = readFileSync(schemaFile, 'utf8')
      rewritten = reorderByForeignKeys(rewritten, schemaSql)
      rewritten = chunkLongInserts(rewritten, schemaSql)
    }
    writeFileSync(file, rewritten)

    const touched = tablesIn(rewritten).filter((t) => t !== 'PRAGMA')
    console.log(`    ${phase.padEnd(6)} ${String(touched.length).padStart(2)} object(s)  ${file.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`)

    if (!apply) continue

    // The target is written LAST and only on request. `--yes` is the same
    // confirmation `db:remote` insists on, for the same reason: this cannot be
    // undone from here.
    wrangler(['d1', 'execute', merge.target, '--remote', '--yes', `--file=${file}`])
    console.log(`    ok     applied to ${merge.target}`)
  }

  if (apply) {
    // Prove it by counting both sides. A copy that stopped halfway leaves the
    // target SHORT, and a short table is invisible until something reads it.
    // The data file holds the REWRITTEN names, so the target is counted as-is;
    // the source still uses the original ones (`way_users` is `users` there).
    const rename = Object.fromEntries(Object.entries(merge.identifiers).map(([from, to]) => [to, from]))
    const tables = tablesIn(readFileSync(join(outDir, `${key}-data.sql`), 'utf8')).filter((t) => t !== 'PRAGMA')
    const before = rowCounts(merge.source, tables.map((t) => rename[t] || t))
    const after = rowCounts(merge.target, tables)
    let short = 0
    for (const t of tables) {
      const want = Number(before[`c_${rename[t] || t}`] ?? 0)
      const got = Number(after[`c_${t}`] ?? 0)
      if (want !== got) {
        short += 1
        console.log(`    \x1b[31m${t}: source ${want}, target ${got}\x1b[0m`)
      }
    }
    console.log(short ? `\n    \x1b[31m${short} table(s) do not match — do NOT deploy\x1b[0m\n` : '\n    \x1b[32mevery table matches the source\x1b[0m\n')
  }
}

console.log('  Next: `npm run audit:remote` (all four bindings must be green), then deploy.')
console.log('  The old databases are deliberately untouched — they are the rollback.\n')
