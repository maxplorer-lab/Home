#!/usr/bin/env node
// ─── Bring a database up to date from migrations-*/ ─────────────
//   npm run db:local                 apply what this database is MISSING
//   npm run db:local -- --dry-run    print the plan, touch nothing
//   npm run db:local -- --only laoka one database (module, directory or binding)
//   npm run db:local -- --persist-to <dir>   a scratch local state directory
//   npm run db:local -- --all        apply every file, in order (a brand-new database)
//   npm run db:remote -- --yes       the REAL databases
//
// `migrations-*/` is the source of truth for the schema: it is the set
// `npm run audit:remote` judges, and the set this command applies. The module
// repos keep their own `migrations/` directories as HISTORY and they are not
// interchangeable — Laoka's stops at 0008 while `migrations-laoka/` carries the
// three pantry files Home actually serves, so building from the Laoka repo's own
// directory left a database the app could not use (Home audit H-A1, 2026-10-01).
// Sompitra's copy survives only because it is byte-identical.
//
// D1 keeps NO record of which migration ran, so "missing" is read from the
// database itself: every file's schema objects are extracted from the SQL
// (scripts/lib/migration-schema.mjs, shared with `npm run audit:remote`), the
// database's actual tables and columns are read in ONE query, and a file is
// applied only when the objects it introduces are absent. That makes the command
// idempotent — run it twice and the second run applies nothing — so it is safe on
// a database of any age, and `--all` is only for a truly empty one.
//
// The one thing the schema cannot answer is a file with NO objects: a seed, a
// settings default, a rename. Those run on an empty database or with `--all`, and
// every one of the four sets' is idempotent (`INSERT OR IGNORE`, or an UPDATE
// guarded by the old value) — keep any new one that way.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DATABASES, migrationFiles } from './lib/migration-targets.mjs'
import { buildSchemaQuery, columnAlias, objectsByFile, objectsForPaths } from './lib/migration-schema.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Through node itself, not `npx`: on Windows the npx shim is not spawnable without
// a shell (ENOENT). Same reason and same pattern as scripts/schema-audit.mjs.
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

const argv = process.argv.slice(2)
const has = (name) => argv.includes(name)
const valueOf = (name) => (has(name) ? argv[argv.indexOf(name) + 1] : null)

const remote = has('--remote')
const dryRun = has('--dry-run')
const forceAll = has('--all')
const persistTo = valueOf('--persist-to')
const only = valueOf('--only')

if (has('--local') && remote) {
  console.error('db-migrate: pass either --local or --remote, not both.')
  process.exit(2)
}
if (has('--persist-to') && remote) {
  console.error('db-migrate: --persist-to applies to --local only.')
  process.exit(2)
}

// A remote run rewrites production and cannot be undone, so it has to be asked
// for twice: `npm run db:remote -- --yes`. The plain command only explains
// itself and exits non-zero, so a stray invocation cannot reach the real DBs.
if (remote && !has('--yes')) {
  console.log('\n  db:remote would bring the REAL databases up to date:\n')
  for (const [dir, binding] of DATABASES) {
    console.log(`    ${binding.padEnd(9)} ${String(migrationFiles(ROOT, dir).length).padStart(2)} file(s)  ${dir}/`)
  }
  console.log('\n  It cannot be undone, so read CUTOVER.md first. Re-run with the')
  console.log('  confirmation flag to proceed:\n')
  console.log('    npm run db:remote -- --yes\n')
  process.exit(1)
}

// `--only` takes a module name, a directory or a binding, case-insensitively
// (`laoka`, `migrations-laoka`, `LAOKA_DB` all mean the same database), because
// the thing a person wants is "just rebuild Laoka" and the binding is the one
// name they are least likely to have in their head.
const needle = (only || '').toLowerCase()
const targets = only
  ? DATABASES.filter(([dir, binding]) => dir.toLowerCase().includes(needle) || binding.toLowerCase().includes(needle))
  : DATABASES
if (only && targets.length === 0) {
  console.error(`db-migrate: --only ${only} matches no database. Known: ${DATABASES.map(([d, b]) => `${d} (${b})`).join(', ')}`)
  process.exit(2)
}

function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000,
  })
}

/** One read-only query, so the whole plan costs a single wrangler start. */
function readSchema(binding, sql) {
  const args = ['d1', 'execute', binding, remote ? '--remote' : '--local', '--json', `--command=${sql}`, '--yes']
  if (persistTo) args.push('--persist-to', persistTo)
  const out = wrangler(args)
  return JSON.parse(out.slice(out.indexOf('[')))[0].results[0]
}

/**
 * What state each file is in, judged from the database's own schema.
 *
 * `applied`   — every object it introduces is there.
 * `missing`   — none of them are.
 * `partial`   — some are: applying it again would fail on the statements that DID
 *               run, so the run stops and says so rather than guessing.
 * `data-only` — it declares no objects, so the schema cannot say. Runs on an empty
 *               database or with `--all`.
 */
function classify(byFile, key, read) {
  const objects = byFile.get(key)
  if (!objects) return { state: 'data-only', total: 0, found: 0 }
  const found =
    objects.tables.filter((t) => read.has(t)).length +
    objects.columns.filter(([t, c]) => read.columns(t).has(c)).length +
    objects.indexes.filter((n) => read.indexes.has(n)).length
  const total = objects.tables.length + objects.columns.length + objects.indexes.length
  return { state: found === total ? 'applied' : found === 0 ? 'missing' : 'partial', total, found }
}

function planFor(binding, dir, support) {
  // Keyed by the path as printed/split, so a file's state and its line in the
  // plan cannot disagree: `objectsByFile` reports basenames, the plan prints
  // `dir/file`.
  const byFile = new Map()
  for (const [file, objects] of objectsByFile(ROOT, dir)) byFile.set(`${dir}/${file}`, objects)
  for (const [path, objects] of objectsForPaths(ROOT, support)) byFile.set(path, objects)
  const { tables: promised, sql } = buildSchemaQuery(byFile)
  const row = readSchema(binding, sql)

  const have = new Set(String(row.tables || '').split(',').filter(Boolean))
  const read = {
    has: (t) => have.has(t),
    columns: (t) => new Set(String(row[columnAlias(t)] || '').split(',').filter(Boolean)),
    // Index names arrive from sqlite_master alongside the tables, and only when
    // the files declare one — a `CREATE INDEX` file has nothing else to go on.
    indexes: new Set(String(row.indexes || '').split(',').filter(Boolean)),
  }
  // "Empty" is judged on the migrations' own tables: a state file created by the
  // first `d1 execute` (or `_cf_METADATA`) must not make a fresh database look used.
  const empty = promised.every((t) => !have.has(t))

  const entry = (rel) => ({ rel, ...classify(byFile, rel, read), empty })
  return {
    chain: migrationFiles(ROOT, dir).map((f) => entry(`${dir}/${f}`)),
    support: support.map((p) => entry(p)),
    empty,
  }
}

const place = remote ? 'REMOTE' : 'LOCAL'
console.log(`\n  ${place} databases from migrations-*/${dryRun ? '   (dry run — nothing will be applied)' : ''}`)
if (forceAll) console.log('  --all: every file, in order, whether or not it looks applied')
console.log('')

let applied = 0
let skipped = 0

for (const [dir, binding, support] of targets) {
  const plan = planFor(binding, dir, support)
  if (!plan.chain.length) {
    console.error(`  ${binding}: ${dir}/ has no .sql files — that directory cannot build this database`)
    process.exit(1)
  }

  const all = [...plan.chain, ...plan.support]
  const halfDone = all.filter((e) => e.state === 'partial')
  if (halfDone.length) {
    console.error(`  ${binding.padEnd(9)} ${dir}/`)
    for (const e of halfDone) console.error(`    !!  ${e.rel}  — ${e.found} of ${e.total} object(s) present`)
    console.error('\n  That file is HALF applied, so re-running it would fail on the statements that')
    console.error('  already ran. Finish it by hand, then run this again:\n')
    console.error(`    npx wrangler d1 execute ${binding} ${remote ? '--remote' : '--local'} --file=${halfDone[0].rel}\n`)
    process.exit(1)
  }

  // A data-only file is only ever run on a database that is being built from
  // nothing (or on request): nothing in the schema can say whether it has run.
  const wantRun = (e) => (forceAll ? true : e.state === 'missing' || (e.state === 'data-only' && plan.empty))
  const toRun = all.filter(wantRun)

  const dataOnly = all.filter((e) => e.state === 'data-only').length
  const note = !dataOnly ? '' : plan.empty ? ` · ${dataOnly} data-only (empty database, so they run)` : ` · ${dataOnly} data-only skipped (--all to run them)`
  console.log(`  ${binding.padEnd(9)} ${dir}/  ${plan.chain.length} file(s) — ${toRun.length} to apply, ${all.length - toRun.length} already satisfied${note}`)

  for (const e of all) {
    if (!wantRun(e)) {
      const why = e.state === 'data-only' ? 'data-only — apply with --all' : 'already present'
      console.log(`    skip  ${e.rel}   (${why})`)
      skipped += 1
      continue
    }
    if (dryRun) {
      console.log(`    todo  ${e.rel}${e.state === 'data-only' ? '   (data-only)' : ''}`)
      continue
    }
    // The third element of a target, applied after its chain: statements the chain
    // cannot carry (see scripts/lib/migration-targets.mjs).
    if (support.includes(e.rel)) console.log(`    ..    ${e.rel}   (post-chain step)`)

    const args = ['d1', 'execute', binding, remote ? '--remote' : '--local', '--yes', `--file=${join(ROOT, e.rel)}`]
    if (persistTo) args.push('--persist-to', persistTo)
    try {
      wrangler(args)
    } catch (err) {
      console.error(`\n  ✖ ${e.rel} failed.\n`)
      const detail = `${err.stdout || ''}${err.stderr || ''}`.trim()
      if (detail) console.error(detail.split('\n').map((l) => `      ${l}`).join('\n'))
      console.error('\n  Stopped: nothing after this file was applied. Re-run the command once the')
      console.error('  cause is fixed — it reads the schema again and skips what is already there.\n')
      process.exit(1)
    }
    applied += 1
    console.log(`    ok    ${e.rel}`)
  }
}

if (dryRun) {
  console.log('\n  Dry run: nothing was applied.\n')
} else if (applied === 0) {
  console.log(`\n  Already up to date — ${skipped} file(s) satisfied by the schema.`)
  console.log('  Nothing to apply. --all runs every file anyway.\n')
} else if (remote) {
  console.log(`\n  Applied ${applied} file(s); ${skipped} were already satisfied. PROVE it landed:\n`)
  console.log('    npm run audit:remote\n')
} else {
  console.log(`\n  Applied ${applied} file(s); ${skipped} were already satisfied.`)
  console.log('  `npm run dev` uses this state.\n')
}
