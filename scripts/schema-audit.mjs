#!/usr/bin/env node
// ─── Remote schema audit ─────────────────────────────────────────
//   node scripts/schema-audit.mjs        (or: npm run audit:remote)
//
// Answers ONE question, against the REAL Cloudflare databases: **is every
// migration in this repo actually applied to every environment?**
//
// Why this exists. `migrations-*/*.sql` is applied BY HAND, per environment, and
// nothing in the build, the check command or the deploy touches it. So the code
// can be live and correct while the table it writes does not exist, and the
// absence is invisible: no error, no log line, no failed check — the reads on the
// live-share path are designed to swallow a missing table (the console has to keep
// working), so on 2026-09-20 production answered `{"canShare":true,"open":[]}`
// perfectly happily while `share_links` was missing, and only pressing Generate
// revealed it. AGENTS.md rule 32.
//
// It is a table/column audit, not a diff: it tells you a migration is MISSING,
// which is the failure that happens in practice. It is READ-ONLY — SELECT only,
// nothing is written, so it is safe to point at production — and it exits 1 on a
// gap so it can gate a release.
//
// Reading the migration files properly is most of the work, and the naive
// version of it lies in three ways that were each hit while writing this:
//   1. COMMENTS. `-- every statement is CREATE TABLE IF NOT EXISTS, so…` is
//      prose, but a regex that does not strip comments reads it as DDL and
//      reports a table named "IF". Stripped below, both `--` and `/* */`.
//   2. DROPS. Laoka's 0004 drops the column 0002 added. A union of every
//      ADD/DROP ever written is not the schema — so files are replayed IN ORDER
//      and a drop removes its column again.
//   3. RENAMES. Laoka's 0005 builds `users_new` and renames it to `users`. The
//      intermediate name never exists in a finished database, so it is not
//      expected either.

import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

/** Each migrations directory and the binding whose real database it describes. */
const DATABASES = [
  ['migrations-home', 'HOME_DB'],
  ['migrations-sompitra', 'DB'],
  ['migrations-way', 'WAY_DB'],
  ['migrations-laoka', 'LAOKA_DB'],
]

// `--dir <path> [--binding <BINDING>]` audits ONE directory instead of all four.
// It exists so this tool can be FALSIFIED: point it at a directory containing a
// table no database has and it must report it, which is the only way to know the
// "all applied" answer above is a fact rather than a script that cannot fail.
const argv = process.argv.slice(2)
const oneDir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : null
const oneBinding = argv.includes('--binding') ? argv[argv.indexOf('--binding') + 1] : 'HOME_DB'
const TARGETS = oneDir ? [[oneDir, oneBinding]] : DATABASES

/** Strip SQL comments, so prose about DDL is never read as DDL. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** Replay a directory's migrations in order into the schema they promise. */
function expectedSchema(dir) {
  const tables = new Set()
  /** table → Set(column) for columns added by migrations (never the base ones). */
  const added = new Map()
  const dropped = new Map()
  // An absolute --dir path is used as given; a bare name is a repo directory.
  const at = (f) => (isAbsolute(dir) ? join(dir, f) : join(ROOT, dir, f))
  for (const file of readdirSync(isAbsolute(dir) ? dir : join(ROOT, dir)).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = stripComments(readFileSync(at(file), 'utf8'))
    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+["'`]?(\w+)["'`]?/gi)) tables.add(m[1])
    for (const m of sql.matchAll(/ALTER TABLE\s+["'`]?(\w+)["'`]?\s+ADD COLUMN\s+["'`]?(\w+)["'`]?/gi)) {
      if (!added.has(m[1])) added.set(m[1], new Set())
      added.get(m[1]).add(m[2])
      dropped.get(m[1])?.delete(m[2])
    }
    // A dropped column is not part of the finished schema, even though a later
    // file may never mention it again.
    for (const m of sql.matchAll(/ALTER TABLE\s+["'`]?(\w+)["'`]?\s+DROP COLUMN\s+["'`]?(\w+)["'`]?/gi)) {
      if (!dropped.has(m[1])) dropped.set(m[1], new Set())
      dropped.get(m[1]).add(m[2])
      added.get(m[1])?.delete(m[2])
    }
    // A rename means the source name was an intermediate: nobody's database has
    // `users_new` in it once the migration finishes.
    for (const m of sql.matchAll(/ALTER TABLE\s+["'`]?(\w+)["'`]?\s+RENAME TO\s+["'`]?(\w+)["'`]?/gi)) {
      tables.delete(m[1])
      tables.add(m[2])
    }
  }
  return { tables, added }
}

/** One read-only query against a REMOTE database. */
function askRemote(binding, command) {
  // Through node itself, not `npx`: on Windows the npx shim is not spawnable
  // without a shell (ENOENT), and a shell would then have to survive the
  // quoting of the SQL below.
  const out = execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', binding, '--remote', '--json', '--command', command], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000,
  })
  return JSON.parse(out.slice(out.indexOf('[')))[0].results[0]
}

let gaps = 0
for (const [dir, binding] of TARGETS) {
  const { tables, added } = expectedSchema(dir)
  const cols = [...added.keys()].map((t) => `(SELECT group_concat(name) FROM pragma_table_info('${t}')) AS c_${t}`).join(', ')
  const row = askRemote(
    binding,
    `SELECT (SELECT group_concat(name) FROM sqlite_master WHERE type='table') AS tables${cols ? ', ' + cols : ''}`
  )

  const have = new Set(String(row.tables || '').split(',').filter(Boolean))
  const missingTables = [...tables].filter((t) => !have.has(t))
  const missingCols = []
  for (const [table, columns] of added) {
    const present = new Set(String(row[`c_${table}`] || '').split(',').filter(Boolean))
    if (!present.size) continue // the table is already reported missing above
    for (const c of columns) if (!present.has(c)) missingCols.push(`${table}.${c}`)
  }

  const bad = missingTables.length + missingCols.length
  gaps += bad
  console.log(`${binding.padEnd(9)} ${String(have.size).padStart(3)} tables on remote · ${tables.size} promised by ${dir}`)
  if (missingTables.length) console.log(`  \x1b[31mMISSING TABLES:  ${missingTables.join(', ')}\x1b[0m`)
  if (missingCols.length) console.log(`  \x1b[31mMISSING COLUMNS: ${missingCols.join(', ')}\x1b[0m`)
  if (!bad) console.log('  \x1b[32m✓ every migration is applied here\x1b[0m')
}

if (gaps === 0) {
  console.log('\n\x1b[32m\x1b[1mAll four remote databases match their migration files.\x1b[0m\n')
  process.exit(0)
}
console.log(`\n\x1b[31m\x1b[1m${gaps} gap(s). Apply the missing file(s) to that database:\x1b[0m`)
console.log('  npx wrangler d1 execute <BINDING> --remote --file=<migrations-dir>/<file>.sql\n')
process.exit(1)
