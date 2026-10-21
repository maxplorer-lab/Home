/**
 * The nightly flush, killed halfway.
 *
 * `src/way/do/flush.ts` copies the DO's buffers into D1 in chunks of 100 and
 * deletes each chunk only after D1 commits it. The dangerous instant is the gap
 * between those two statements: D1 has the rows, the DO has not dropped them,
 * and nothing shares a transaction across the two, so the retry copies the same
 * chunk again. Production is where that shows up as 253 pings that share a
 * second and 37 chat lines that appear twice.
 *
 * This file drives the REAL loop against a REAL SQLite database built from
 * `migrations-way/*.sql` — not a mock — and kills it in that gap. The harness's
 * `batch()` wraps the statements in BEGIN/COMMIT, as D1's batch is documented to
 * be a transaction, and only then throws: that is the DO going away after D1
 * committed. The next call is the retry, with the buffer still holding the chunk.
 *
 * What each case pins:
 *   - a kill AFTER the commit duplicates nothing (the sync_id index + OR IGNORE)
 *   - a kill BEFORE the commit loses nothing (the rows are still buffered)
 *   - the same for chat: an insert-then-mark-synced split cannot double a line
 *   - the fallback for a database without migration 0009 still flushes, which is
 *     what lets the code ship before the schema does
 *
 * Run: `npm test`. Needs node:sqlite (Node 22.5+), hence the ExperimentalWarning
 * in the output — the database itself is real.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FLUSH_CHUNK, flushBuffers } from '../src/way/do/flush.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS = join(ROOT, 'migrations-way')
// `messages.device_id` carries `REFERENCES devices(device_id)`, and migration
// 0002 DROPS that table -- so on a database built from migrations alone every
// message insert fails with "no such table: main.devices", which is the outage
// scripts/repair-way-messages-fk.sql exists to undo. `db:local`/`db:remote`
// apply it after the migrations (scripts/lib/migration-targets.mjs), and this
// fixture does the same: without it the chat half of the flush cannot run at all.
const FK_REPAIR = join(ROOT, 'scripts', 'repair-way-messages-fk.sql')

/** The production WAY schema, built by replaying the real migrations in order.
 *  A migration that will not apply to plain SQLite fails this test, not the
 *  deploy. `skip` leaves a file out (the "schema is behind the code" case). */
function schemaDb(skip = []) {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (skip.some((s) => file.includes(s))) continue
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  db.exec(readFileSync(FK_REPAIR, 'utf8'))
  return db
}

/**
 * The D1 side of `FlushTarget` over a real database, with a way to die at a
 * chosen batch call. `afterBatch` runs once the statements are COMMITTED, so a
 * throw there is exactly the DO-vanishing window; `beforeBatch` is the batch
 * never reaching D1 at all.
 */
function d1(db, { beforeBatch, afterBatch } = {}) {
  let calls = 0
  return {
    calls: () => calls,
    prepare(sql, ...params) {
      return { sql, params }
    },
    async batch(statements) {
      calls += 1
      beforeBatch?.(calls, statements.length)
      // D1's batch() is one transaction: a statement that fails rolls the whole
      // batch back, which is why the only duplicate window is AFTER this.
      db.exec('BEGIN')
      let results
      try {
        results = statements.map((s) => {
          const r = db.prepare(s.sql).run(...s.params)
          return { meta: { changes: Number(r.changes) } }
        })
        db.exec('COMMIT')
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* already rolled back */
        }
        throw e
      }
      afterBatch?.(calls, statements.length)
      return results
    },
  }
}

/** The DO side: the buffered rows, deleted only once their chunk is acknowledged. */
function buffer(pings, messages = []) {
  const pending = new Map(pings.map((p) => [p.id, p]))
  const unsynced = new Map(messages.map((m) => [m.id, m]))
  return {
    pending,
    unsynced,
    /** What `SELECT * FROM pending_sync ORDER BY id` would return now. */
    rows: () => [...pending.values()].sort((a, b) => a.id - b.id),
    messageRows: () => [...unsynced.values()],
    deletePendingThrough(maxId) {
      for (const id of [...pending.keys()]) if (id <= maxId) pending.delete(id)
    },
    markMessageSynced(id) {
      unsynced.delete(id)
    },
  }
}

const ping = (id, over = {}) => ({
  id,
  device_id: 'Niri',
  timestamp: new Date(Date.UTC(2026, 9, 21, 6, 0, id)).toISOString(),
  latitude: -18.9 + id * 0.0001,
  longitude: 47.5 + id * 0.0001,
  altitude: 1400 + id,
  speed: 12,
  speed_avg_30s: 14,
  is_inside_geofence: 0,
  geofence_name: null,
  is_driving: 1,
  distance_km: 0.02,
  is_stationary: 0,
  is_keep_alive: 0,
  battery: null,
  accuracy: 1.5,
  leg_id: Math.ceil(id / 5),
  sync_id: `ping-${id}`,
  ...over,
})

const message = (n) => ({
  id: `msg-${n}`,
  sender: n % 2 ? 'MaxX' : null, // null = an auto geofence event
  device_id: 'Niri',
  message: `event ${n}`,
  is_auto: n % 2 ? 0 : 1,
  event_type: n % 2 ? null : 'arrive',
  gps_timestamp: null,
  created_at: `2026-10-21T06:00:0${n}.000Z`,
})

const count = (db, sql) => db.prepare(sql).get().n

test('a flush killed after D1 commits re-runs without duplicating or losing a ping', async () => {
  const db = schemaDb()
  const pings = Array.from({ length: 250 }, (_, i) => ping(i + 1))
  const store = buffer(pings)
  const target = d1(db, {
    // The second ping chunk commits, then the DO dies before it can DELETE.
    afterBatch: (call) => {
      if (call === 2) throw new Error('DO evicted after the batch committed')
    },
  })

  await assert.rejects(
    () =>
      flushBuffers(store.rows(), store.messageRows(), {
        ...target,
        deletePendingThrough: store.deletePendingThrough,
        markMessageSynced: store.markMessageSynced,
      }),
    /evicted/
  )

  // Chunk 1 is done; chunk 2 is in D1 AND still buffered -- the gap.
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM gps_pings'), 200)
  assert.equal(store.pending.size, 150)
  assert.equal(
    count(db, "SELECT COUNT(*) AS n FROM gps_pings WHERE sync_id LIKE 'ping-%'"),
    200
  )

  // The retry: same buffer, chunks 2 and 3 again.
  const result = await flushBuffers(store.rows(), store.messageRows(), {
    ...target,
    deletePendingThrough: store.deletePendingThrough,
    markMessageSynced: store.markMessageSynced,
  })

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM gps_pings'), 250, 'no row lost')
  assert.equal(
    count(db, 'SELECT COUNT(DISTINCT sync_id) AS n FROM gps_pings'),
    250,
    'no row duplicated'
  )
  assert.equal(store.pending.size, 0, 'the buffer is empty once every chunk landed')
  // The retry only had to WRITE chunk 3 (50 rows): chunk 2 was re-sent and
  // ignored, which is the number that proves the duplicate was recognised
  // rather than prevented by luck.
  assert.equal(result.pingsSkipped, 100, 'the re-sent chunk is reported as skipped')
  assert.equal(result.pingsFlushed, 50)

  // Two batches in the run that died (chunk 1, then chunk 2 that killed it) and
  // two in the retry (the 150 buffered rows go as 100 + 50), never more than
  // D1's 100-statement cap per call.
  assert.equal(target.calls(), 4)
})

test('a flush killed before D1 commits loses nothing: the chunk is still buffered', async () => {
  const db = schemaDb()
  const pings = Array.from({ length: 250 }, (_, i) => ping(i + 1))
  const store = buffer(pings)
  const target = d1(db, {
    beforeBatch: (call) => {
      if (call === 2) throw new Error('D1 rejected the batch')
    },
  })

  await assert.rejects(() =>
    flushBuffers(store.rows(), store.messageRows(), {
      ...target,
      deletePendingThrough: store.deletePendingThrough,
      markMessageSynced: store.markMessageSynced,
    })
  )

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM gps_pings'), 100)
  assert.equal(store.pending.size, 150, 'the failed chunk was never deleted')

  await flushBuffers(store.rows(), store.messageRows(), {
    ...target,
    deletePendingThrough: store.deletePendingThrough,
    markMessageSynced: store.markMessageSynced,
  })

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM gps_pings'), 250)
  assert.equal(store.pending.size, 0)
})

test('a chat flush killed between the insert and the synced mark does not double a line', async () => {
  const db = schemaDb()
  const pings = [ping(1)]
  const messages = [message(1), message(2), message(3)]
  const store = buffer(pings, messages)
  const target = d1(db, {
    // Call 1 is the single ping chunk, call 2 the messages. Both commit; the DO
    // dies before `markMessageSynced` runs.
    afterBatch: (call) => {
      if (call === 2) throw new Error('DO evicted before marking synced')
    },
  })

  await assert.rejects(() =>
    flushBuffers(store.rows(), store.messageRows(), {
      ...target,
      deletePendingThrough: store.deletePendingThrough,
      markMessageSynced: store.markMessageSynced,
    })
  )

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM messages'), 3)
  assert.equal(store.unsynced.size, 3, 'still unsynced, so the retry will re-send them')

  await flushBuffers(store.rows(), store.messageRows(), {
    ...target,
    deletePendingThrough: store.deletePendingThrough,
    markMessageSynced: store.markMessageSynced,
  })

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM messages'), 3, 'no duplicate line')
  assert.equal(count(db, 'SELECT COUNT(DISTINCT sync_id) AS n FROM messages'), 3)
  assert.equal(store.unsynced.size, 0)
  // The auto event kept the sender mapping the flush has always applied.
  assert.equal(
    count(db, `SELECT COUNT(*) AS n FROM messages WHERE sender = 'System'`),
    1
  )
})

test('a database without migration 0009 still flushes (the DO passes idempotent:false)', async () => {
  const db = schemaDb(['0009_flush_idempotency'])
  const store = buffer([ping(1), ping(2)])
  const target = d1(db)

  const result = await flushBuffers(
    store.rows(),
    [],
    {
      ...target,
      deletePendingThrough: store.deletePendingThrough,
      markMessageSynced: store.markMessageSynced,
    },
    { idempotent: false }
  )

  assert.equal(result.pingsFlushed, 2)
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM gps_pings'), 2)
  assert.equal(store.pending.size, 0)

  // …and the probe is what stands between that schema and a chunk it could not
  // dedupe: asking for the idempotent insert there fails loudly instead.
  await assert.rejects(
    () =>
      flushBuffers(
        [ping(3)],
        [],
        {
          ...target,
          deletePendingThrough: store.deletePendingThrough,
          markMessageSynced: store.markMessageSynced,
        },
        { idempotent: true }
      ),
    /sync_id/
  )
})

test('the chunk size is D1\'s 100-statement cap', async () => {
  const db = schemaDb()
  const store = buffer(Array.from({ length: 201 }, (_, i) => ping(i + 1)))
  const target = d1(db)

  await flushBuffers(store.rows(), [], {
    ...target,
    deletePendingThrough: store.deletePendingThrough,
    markMessageSynced: store.markMessageSynced,
  })

  assert.equal(FLUSH_CHUNK, 100)
  assert.equal(target.calls(), 3, '201 points must go in 100 + 100 + 1')
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM gps_pings'), 201)
})
