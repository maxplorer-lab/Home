/**
 * The nightly flush's chunk loop, out of the Durable Object.
 *
 * The loop itself (chunk at 100, insert, then delete only what landed) is
 * correct and must not be rewritten: deleting first would lose a chunk D1
 * refused, and D1's `batch()` is a transaction, so a rejected chunk commits
 * nothing. What it cannot fix by ordering is the other side of the same
 * statement pair — D1 has committed the chunk and the DO's own DELETE has not
 * landed yet (eviction, a storage error, the isolate going away mid-await). The
 * DO's SQLite and D1 have no shared transaction, so the retry re-inserts rows
 * D1 already holds.
 *
 * So the insert carries an identity: `sync_id`. The ping's is the UUID the DO
 * stamped on the buffered row; a message's is the id the DO already gave it.
 * `INSERT OR IGNORE` against the unique index in
 * `migrations-way/0009_flush_idempotency.sql` turns a retry into a no-op, which
 * is what makes "insert, then delete" safe instead of merely least-bad.
 *
 * The identity is NOT (device_id, timestamp): production has 253 pairs sharing a
 * second that are two different GPS fixes. See that migration's header.
 *
 * `idempotent: false` is the bridge for a database that has not had 0009 applied
 * yet — the DO probes for the column and passes the answer, so shipping this
 * code before the schema loses nothing, only the guarantee.
 *
 * Tested by `scripts/flush-idempotency.test.mjs`, which runs THIS loop against a
 * real SQLite built from `migrations-way/*.sql` and kills it between the batch
 * and the delete.
 */

/** One buffered track point, as `SELECT * FROM pending_sync` returns it. */
export interface PendingTrackRow {
  id: number
  device_id: string
  timestamp: string
  latitude: number
  longitude: number
  altitude: number | null
  speed: number | null
  speed_avg_30s: number | null
  is_inside_geofence: number | null
  geofence_name: string | null
  is_driving: number | null
  distance_km: number | null
  is_stationary: number | null
  is_keep_alive: number | null
  battery: number | null
  accuracy: number | null
  leg_id: number | null
  /** The DO's UUID for this row. Missing on rows buffered before 2026-10-21. */
  sync_id?: string | null
}

/** One buffered chat/auto event, as `SELECT * FROM chat_messages` returns it. */
export interface PendingMessageRow {
  /** A UUID the DO minted when the message was created — the row's identity. */
  id: string
  sender: string | null
  device_id: string | null
  message: string
  is_auto: number
  event_type: string | null
  gps_timestamp: string | null
  created_at: string
  reply_to_id?: string | null
  reply_to_sender?: string | null
  reply_to_snippet?: string | null
  reactions?: string | null
  reaction_users?: string | null
  reaction_updated_at?: string | null
}

/** What the loop needs D1 to do. The DO passes `env.WAY_DB`; the test passes
 *  the same three methods over a real SQLite file. */
export interface FlushTarget {
  prepare(sql: string, ...params: unknown[]): unknown
  batch(statements: unknown[]): Promise<{ meta?: { changes?: number } }[] | unknown>
  /** Drops the buffered rows this chunk covered, and nothing newer. */
  deletePendingThrough(maxId: number): void
  markMessageSynced(id: string): void
}

export interface FlushResult {
  /** Rows D1 now holds from this run (ignored duplicates included). */
  pingsFlushed: number
  /** Rows the retry found already inserted — the point of the whole exercise. */
  pingsSkipped: number
  messagesFlushed: number
}

/** D1 caps `batch()` at 100 statements. A busy day exceeds that, which is what
 *  made a single-batch flush fail silently once. */
export const FLUSH_CHUNK = 100

const PING_COLUMNS = [
  'device_id', 'timestamp', 'latitude', 'longitude', 'altitude', 'speed', 'speed_avg_30s',
  'is_inside_geofence', 'geofence_name', 'is_driving', 'distance_km', 'is_stationary',
  'is_keep_alive', 'battery', 'accuracy', 'leg_id',
]

const MESSAGE_COLUMNS = [
  'sender', 'message', 'gps_timestamp', 'is_auto', 'event_type', 'device_id', 'created_at',
  'reply_to_id', 'reply_to_sender', 'reply_to_snippet',
  'reactions', 'reaction_users', 'reaction_updated_at',
]

const placeholders = (n: number) => new Array(n).fill('?').join(', ')

const pingParams = (p: PendingTrackRow): unknown[] => [
  p.device_id, p.timestamp, p.latitude, p.longitude, p.altitude, p.speed,
  p.speed_avg_30s, p.is_inside_geofence, p.geofence_name, p.is_driving,
  p.distance_km, p.is_stationary, p.is_keep_alive, p.battery, p.accuracy,
  p.leg_id ?? null,
]

// Auto geofence events have sender = null in the DO, but D1's messages.sender is
// NOT NULL. Map to "System" (the dashboard renders a null sender that way). This
// NOT NULL violation is what made the whole flush fail before.
const messageParams = (m: PendingMessageRow): unknown[] => [
  m.sender ?? 'System', m.message, m.gps_timestamp, m.is_auto, m.event_type, m.device_id,
  m.created_at,
  // Rows written before migration 0006 have no reply columns on the DO side
  // either; `?? null` keeps them out of the NOT NULL path.
  m.reply_to_id ?? null, m.reply_to_sender ?? null, m.reply_to_snippet ?? null,
  // Chat reactions (0007), stored as the raw JSON strings the DO already holds.
  m.reactions ?? null, m.reaction_users ?? null, m.reaction_updated_at ?? null,
]

/**
 * Copy the DO's buffers into D1, chunk by chunk, deleting each chunk from the
 * buffer only once it is committed. Safe to re-run from the top after any
 * failure: chunks already inserted are ignored by their `sync_id`, and chunks
 * not yet attempted are simply retried.
 */
export async function flushBuffers(
  pendingPings: PendingTrackRow[],
  pendingMessages: PendingMessageRow[],
  target: FlushTarget,
  opts: { chunk?: number; idempotent?: boolean } = {}
): Promise<FlushResult> {
  const chunkSize = opts.chunk ?? FLUSH_CHUNK
  const idempotent = opts.idempotent !== false
  const insert = idempotent ? 'INSERT OR IGNORE' : 'INSERT'

  const pingSql =
    `${insert} INTO gps_pings (${PING_COLUMNS.join(', ')}${idempotent ? ', sync_id' : ''})
     VALUES (${placeholders(PING_COLUMNS.length)}${idempotent ? ', ?' : ''})`
  const messageSql =
    `${insert} INTO messages (${MESSAGE_COLUMNS.join(', ')}${idempotent ? ', sync_id' : ''})
     VALUES (${placeholders(MESSAGE_COLUMNS.length)}${idempotent ? ', ?' : ''})`

  let inserted = 0
  let skipped = 0

  for (let i = 0; i < pendingPings.length; i += chunkSize) {
    const chunk = pendingPings.slice(i, i + chunkSize)
    const statements = chunk.map((p) =>
      target.prepare(pingSql, ...pingParams(p), ...(idempotent ? [p.sync_id ?? null] : []))
    )
    const results = await target.batch(statements)
    // `meta.changes` is what says whether a row was really written; wrangler
    // builds have not always reported it, so a missing count is read as "one
    // insert" rather than making the receipt lie in the other direction.
    const changed = countChanges(results, chunk.length)
    inserted += changed
    skipped += chunk.length - changed
    // Only THIS chunk's rows. A ping landing during the awaits above gets a
    // higher AUTOINCREMENT id, so it is left for the next flush.
    target.deletePendingThrough(chunk[chunk.length - 1].id)
  }

  let messagesFlushed = 0
  for (let i = 0; i < pendingMessages.length; i += chunkSize) {
    const chunk = pendingMessages.slice(i, i + chunkSize)
    const statements = chunk.map((m) =>
      target.prepare(messageSql, ...messageParams(m), ...(idempotent ? [m.id] : []))
    )
    await target.batch(statements)
    // Mark synced rather than delete -- scrollback stays available to a
    // freshly-connecting dashboard client even after the flush.
    for (const m of chunk) target.markMessageSynced(m.id)
    messagesFlushed += chunk.length
  }

  return { pingsFlushed: inserted, pingsSkipped: skipped, messagesFlushed }
}

/** Sum of `meta.changes`, or `expected` when the runtime does not report it. */
function countChanges(results: unknown, expected: number): number {
  if (!Array.isArray(results) || results.length !== expected) return expected
  let total = 0
  for (const r of results as { meta?: { changes?: number } }[]) {
    const changes = r?.meta?.changes
    if (typeof changes !== 'number') return expected
    total += changes
  }
  return total
}
