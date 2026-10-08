#!/usr/bin/env node
// ─── Does the archive in ./out still rebuild what the merge produced? ───────
//
//   node scripts/one-off/2026-10-06-merge-databases/verify-archive.mjs
//   node scripts/one-off/2026-10-06-merge-databases/verify-archive.mjs --fresh
//
// `merge-databases.mjs` writes `out/<key>-schema.sql` and `out/<key>-data.sql`
// and then applies them to the merged database. Those files are the only copy
// of the folded-in rows that is not a live database, so they are what the
// rollback promise actually rests on. This script stops ASSUMING that:
//
//   1. replay the archive into a scratch SQLite database, statement by statement
//      with foreign keys ON — exactly how D1 runs a `--file`;
//   2. compare every archive table, row for row, against the MERGED database,
//      proving the merge landed completely. This side is allowed to have GROWN
//      since the merge (the 21:00 UTC cron writes to it); growth is reported as
//      drift, because a table with new rows can no longer be hashed against a
//      snapshot of itself;
//   3. compare again against the SUPERSEDED original — strictly, no drift
//      allowance, because nothing writes to `way-db` or `laoka` any more. This
//      is the claim the delete rests on: the archive holds everything the
//      rollback copy holds;
//   4. list any table the LIVE databases have that the archive never covered.
//      If that list is ever non-empty for a superseded pair, the delete is not
//      safe and this says so.
//
// The live side is read with `wrangler d1 export` (one call per database, into
// `scratch/exports/`, cached between runs) rather than table by table: paging a
// remote table costs one wrangler start-up per page, and `gps_pings` alone is
// 43 k rows. Everything after the export is local, so the comparison is
// exhaustive instead of sampled.
//
// The replay uses `node:sqlite`, not `wrangler d1 execute --local`. Local D1 IS
// SQLite, and wrangler's `--file` path issues one round trip per statement —
// 43 k+ of them here, which does not finish. Foreign keys are switched on by
// hand, because SQLite's default is off and D1's is on: that difference is the
// whole reason `reorderByForeignKeys` exists, so the replay must preserve it.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
// Through node itself, not `npx`: on Windows the npx shim is not spawnable
// without a shell (ENOENT). Same reason and same pattern as the merge script.
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const EXPORTS = join(HERE, 'scratch', 'exports')
const fresh = process.argv.includes('--fresh')

const DRILLS = {
  core: {
    archive: ['core-schema.sql', 'core-data.sql'],
    mergedDatabase: 'home-db',
    sourceDatabase: 'way-db',
    // Archive table name → the name the source still uses. Everything else kept
    // its name on the way in, so this is the whole map.
    renamed: { way_users: 'users' },
  },
  household: {
    archive: ['household-schema.sql', 'household-data.sql'],
    mergedDatabase: 'sompitra-db',
    sourceDatabase: 'laoka',
    renamed: { laoka_users: 'users', laoka_sessions: 'sessions' },
  },
}

/** D1's own bookkeeping, plus the AUTOINCREMENT sequence the merge drops on
 *  purpose — none of it is part of the claim. */
const INTERNAL = (name) => /^sqlite_/.test(name) || name.endsWith('_cf_KV')

function throwWrangler(database, verb, err) {
  const detail = `${err.stdout || ''}${err.stderr || ''}`.trim().split('\n').slice(-4).join('\n')
  throw new Error(`d1 ${verb} ${database} failed: ${detail || err.message}`)
}

function wrangler(args, database, verb) {
  try {
    return execFileSync(process.execPath, [WRANGLER, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    })
  } catch (err) {
    throwWrangler(database, verb, err)
  }
}

/** One export per database per half, cached: re-running the drill only re-reads
 *  what is already on disk unless `--fresh` asks for a new snapshot. */
function exportLive(database) {
  mkdirSync(EXPORTS, { recursive: true })
  const schema = join(EXPORTS, `${database}-schema.sql`)
  const data = join(EXPORTS, `${database}-data.sql`)
  if (fresh) {
    rmSync(schema, { force: true })
    rmSync(data, { force: true })
  }
  // Written to `.part` and renamed, so a kill mid-download can never leave a
  // truncated file that the next run would happily treat as a cached export.
  for (const [target, flag] of [[schema, '--no-data'], [data, '--no-schema']]) {
    if (existsSync(target)) continue
    const part = `${target}.part`
    console.log(`         exporting ${database} (${flag.slice(2)}) …`)
    wrangler(['d1', 'export', database, '--remote', flag, `--output=${part}`], database, 'export')
    renameSync(part, target)
  }
  return { schema, data }
}

const tablesOf = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((n) => !INTERNAL(n))

const columnsOf = (db, table) =>
  db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name)

/** One row's contribution to a table digest: every column, in table order. */
function norm(v) {
  if (typeof v === 'bigint') return Number(v)
  if (v instanceof Uint8Array) return `blob:${Buffer.from(v).toString('hex')}`
  return v
}

/** A whole table as one hash. Both sides are read locally by the same code, so
 *  a hash mismatch is a content difference and never a representation one. */
function digest(db, table) {
  const cols = columnsOf(db, table)
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()
  const h = createHash('sha256')
  for (const row of rows) {
    h.update(cols.map((c) => JSON.stringify(norm(row[c]))).join('\u0001'))
    h.update('\u0002')
  }
  return { count: rows.length, hash: h.digest('hex') }
}

/** Replay a file pair into a scratch database.
 *
 *  The archive runs the way D1 runs a `--file`: statement by statement, with no
 *  surrounding transaction, so every statement commits alone. That matters twice
 *  over. Foreign keys are enforced IMMEDIATELY (D1's `defer_foreign_keys=TRUE`
 *  prelude is cleared at each implicit commit, which is why the merge README says
 *  it buys nothing and why `reorderByForeignKeys` had to exist), so a child row
 *  ahead of its parent still fails here exactly as it failed on D1. The journal
 *  is moved to memory and syncs are dropped only to avoid paying an fsync per row
 *  — on this filesystem that alone was the difference between seconds and a
 *  fifteen-minute stall, and neither pragma changes what is accepted or stored.
 *
 *  The live exports are inputs to a comparison, not subjects of it: their row
 *  order is not under test and D1's own export is not sorted for it, so they get
 *  one deferred transaction instead. */
function replay(file, files, { tolerateOrder = false } = {}) {
  rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys=ON;')
  if (tolerateOrder) db.exec('BEGIN; PRAGMA defer_foreign_keys=TRUE;')
  else db.exec('PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;')
  try {
    for (const f of files) {
      let sql = readFileSync(f, 'utf8')
      // An export's own BEGIN/COMMIT would close the transaction we are holding.
      if (tolerateOrder) sql = sql.replace(/^\s*(BEGIN|COMMIT)(\s+TRANSACTION)?;\s*$/gim, '')
      db.exec(sql)
    }
    if (tolerateOrder) db.exec('COMMIT;')
  } catch (err) {
    try { db.exec('ROLLBACK;') } catch { /* no transaction open */ }
    db.close()
    throw new Error(`${f.split(/[\\/]/).pop()}: ${err.message}`)
  }
  return db
}

const pad = (s, n) => String(s).padEnd(n)
let failures = 0

console.log('\n  archive replay — out/ vs the merged database and the superseded original\n')

for (const [key, drill] of Object.entries(DRILLS)) {
  const sourceName = (t) => drill.renamed[t] || t
  const archiveName = Object.fromEntries(Object.entries(drill.renamed).map(([a, s]) => [s, a]))

  console.log(`  ${key}   ${drill.archive.join(', ')}`)

  // ── 1. replay the archive, exactly as D1 would take it ───────────────────
  let db
  try {
    db = replay(join(HERE, 'scratch', `drill-${key}.sqlite`), drill.archive.map((f) => join(HERE, 'out', f)))
  } catch (err) {
    failures += 1
    console.log(`       \x1b[31mREPLAY FAILED — ${err.message}\x1b[0m`)
    continue
  }
  const archived = tablesOf(db)
  console.log(`       replayed ${archived.length} table(s), statement by statement, foreign keys on`)

  // ── 2/3. against the merged database, and against the superseded original ─
  for (const [label, database, otherName] of [
    ['merged', drill.mergedDatabase, (t) => t],
    ['original', drill.sourceDatabase, sourceName],
  ]) {
    const live = exportLive(database)
    let liveDb
    try {
      liveDb = replay(join(HERE, 'scratch', `live-${database}.sqlite`), [live.schema, live.data], { tolerateOrder: true })
    } catch (err) {
      failures += 1
      console.log(`       \x1b[31mcould not replay ${database}'s own export — ${err.message}\x1b[0m`)
      continue
    }

    const liveTables = tablesOf(liveDb)
    const liveSet = new Set(liveTables)
    let compared = 0
    let bad = 0
    let drift = 0

    for (const table of archived) {
      const name = otherName(table)
      if (!liveSet.has(name)) {
        failures += 1
        bad += 1
        console.log(`       \x1b[31m${label}: ${database} has no table ${name}\x1b[0m`)
        continue
      }
      if (columnsOf(db, table).join() !== columnsOf(liveDb, name).join()) {
        failures += 1
        bad += 1
        console.log(`       \x1b[31m${label}: ${table} has different columns in ${database}.${name}\x1b[0m`)
        continue
      }
      const mine = digest(db, table)
      const theirs = digest(liveDb, name)
      compared += 1
      if (mine.count === theirs.count && mine.hash === theirs.hash) continue

      // A merged database goes on taking writes — the 21:00 UTC cron flushes
      // pings into `home-db` — so a table that is merely BIGGER than the archive
      // is drift, not a broken copy. It also cannot be hashed against the
      // archive any more: new rows move every aggregate. That is exactly why the
      // deletion decision rests on the SUPERSEDED side, which nothing writes to
      // and which is compared strictly, with no drift allowance at all.
      if (label === 'merged' && theirs.count > mine.count) {
        drift += 1
        console.log(
          `       drift: ${table} has grown since the merge — ${theirs.count} live, ${mine.count} archived`,
        )
        continue
      }

      const why =
        mine.count !== theirs.count
          ? `rows ${mine.count} in the archive, ${theirs.count} live`
          : 'same row count, different content'
      failures += 1
      bad += 1
      console.log(`       \x1b[31m${label}: ${table} ≠ ${database}.${name} — ${why}\x1b[0m`)
    }

    const uncovered = liveTables.filter((t) => !archived.includes(t) && !archived.includes(archiveName[t]))
    const mark = bad ? `\x1b[31m${bad} MISMATCH\x1b[0m` : '\x1b[32mok\x1b[0m'
    console.log(
      `       ${pad(label, 9)} vs ${pad(database, 12)} ${mark}   ` +
        `${compared - drift} of ${compared} table(s) identical, row for row`,
    )
    if (uncovered.length) {
      const note = label === 'original' ? '\x1b[31mNOT COVERED BY THE ARCHIVE\x1b[0m' : 'outside the merge'
      if (label === 'original') failures += 1
      console.log(`         ${uncovered.length} table(s) the archive never had (${note}): ${uncovered.join(', ')}`)
    }
    liveDb.close()
  }
  db.close()
}

console.log(
  failures
    ? `\n  \x1b[31m${failures} problem(s) — the archive does not stand alone yet.\x1b[0m\n`
    : '\n  \x1b[32mEvery archived table reproduces, row for row, on both sides.\x1b[0m\n',
)
process.exit(failures ? 1 : 0)
