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
// It is a table/column/index audit, not a diff: it tells you a migration is MISSING,
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

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DATABASES } from './lib/migration-targets.mjs'
import { expectedSchema, schemaQueryFor } from './lib/migration-schema.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

// The migrations-directory → binding map lives in scripts/lib/migration-targets.mjs,
// shared with scripts/db-migrate.mjs so that a database can never be audited against
// one set of files and built from another.

// `--dir <path> [--binding <BINDING>]` audits ONE directory instead of all four.
// It exists so this tool can be FALSIFIED: point it at a directory containing a
// table no database has and it must report it, which is the only way to know the
// "all applied" answer above is a fact rather than a script that cannot fail.
const argv = process.argv.slice(2)
const oneDir = argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : null
const oneBinding = argv.includes('--binding') ? argv[argv.indexOf('--binding') + 1] : 'HOME_DB'
const TARGETS = oneDir ? [[oneDir, oneBinding]] : DATABASES

// `--local [--persist-to <dir>]` audits the local D1 instead of the real one. The
// npm script audits PRODUCTION, so this is opt-in and never the default — it
// exists so the replay below can be checked against a database whose state you
// built yourself (`npm run db:local -- --persist-to <dir>`), which is how the
// dropped-`devices` rule was falsified.
const local = argv.includes('--local')
const persistTo = argv.includes('--persist-to') ? argv[argv.indexOf('--persist-to') + 1] : null

// The SQL replay lives in scripts/lib/migration-schema.mjs, shared with
// scripts/db-migrate.mjs — the same files decide both what to audit and what to
// apply. See that file for the four ways reading SQL naively lies (comments,
// dropped columns, dropped tables, renames).

/** One read-only query against a real (or, with --local, a local) database. */
function askRemote(binding, command) {
  // Through node itself, not `npx`: on Windows the npx shim is not spawnable
  // without a shell (ENOENT), and a shell would then have to survive the
  // quoting of the SQL below.
  const args = [WRANGLER, 'd1', 'execute', binding, local ? '--local' : '--remote', '--json', `--command=${command}`]
  if (persistTo) args.push('--persist-to', persistTo)
  const out = execFileSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000,
  })
  return JSON.parse(out.slice(out.indexOf('[')))[0].results[0]
}

let gaps = 0
for (const [dir, binding] of TARGETS) {
  const { tables, added, indexes } = expectedSchema(ROOT, dir)
  const row = askRemote(binding, schemaQueryFor({ tables, added, indexes }).sql)

  const have = new Set(String(row.tables || '').split(',').filter(Boolean))
  const missingTables = [...tables].filter((t) => !have.has(t))
  const missingCols = []
  for (const [table, columns] of added) {
    const present = new Set(String(row[`c_${table}`] || '').split(',').filter(Boolean))
    if (!present.size) continue // the table is already reported missing above
    for (const c of columns) if (!present.has(c)) missingCols.push(`${table}.${c}`)
  }

  // Indexes are checked for the same reason the tables are: a `CREATE INDEX`
  // file declares no table, so without this a migration that never ran would
  // audit as "applied" — which is exactly how the W.A.Y history indexes stayed
  // missing while every binding reported green (DB-REDESIGN.md §1a).
  const haveIndexes = new Set(String(row.indexes || '').split(',').filter(Boolean))
  const missingIndexes = [...indexes].filter((n) => !haveIndexes.has(n))

  const bad = missingTables.length + missingCols.length + missingIndexes.length
  gaps += bad
  console.log(`${binding.padEnd(9)} ${String(have.size).padStart(3)} tables on ${local ? 'local ' : 'remote'} · ${tables.size} promised by ${dir}`)
  if (missingTables.length) console.log(`  \x1b[31mMISSING TABLES:  ${missingTables.join(', ')}\x1b[0m`)
  if (missingCols.length) console.log(`  \x1b[31mMISSING COLUMNS: ${missingCols.join(', ')}\x1b[0m`)
  if (missingIndexes.length) console.log(`  \x1b[31mMISSING INDEXES: ${missingIndexes.join(', ')}\x1b[0m`)
  if (!bad) console.log('  \x1b[32m✓ every migration is applied here\x1b[0m')
}

if (gaps === 0) {
  // FOUR BINDINGS, TWO DATABASES (2026-10-06): each binding is judged against
  // its own directory, and a pair resolving to one database is what the merge is.
  console.log(`\n\x1b[32m\x1b[1mEvery ${local ? 'local' : 'remote'} binding matches its migration files.\x1b[0m\n`)
  process.exit(0)
}
console.log(`\n\x1b[31m\x1b[1m${gaps} gap(s). Apply the missing file(s) to that database:\x1b[0m`)
console.log(`  npx wrangler d1 execute <BINDING> ${local ? '--local' : '--remote'} --file=<migrations-dir>/<file>.sql`)
console.log('  ...or let it work out what is missing: npm run db:local' + (local ? '' : ' / db:remote -- --yes') + '\n')
process.exit(1)
