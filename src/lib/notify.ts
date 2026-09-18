// ─── Notifications ───────────────────────────────────────────
// Single source of truth for:
//   1. how an event is described (dashboard feed AND ntfy push)
//   2. key/value app settings
//   3. pushing to an ntfy server
//
// Wording rules (user-specified, keep them exactly):
//   Budget   →  line 1: "{User} - {Expense|Income} - {Category|Account}"
//               line 2: "{Ar 10 000} - {Description}"
//   Kiné     →  one line, e.g. "Rakoto (3) sessions logged", "Rakoto (Ar 60 000) paid",
//               "New client - Rakoto - Added", "Rakoto - Contract Finished"
// Everything is written in natural case and passed through verbatim — nothing is
// ever upper-cased. Money inside a notification is space-separated
// ("Ar 10 000"); the rest of the UI keeps mga()'s comma form ("Ar 10,000").

import type { Transaction } from '../db/schema'

export interface NotifLine {
  href: string
  accent: string
  line1: string
  line2: string
}

/**
 * Money as shown inside a notification: `Ar 10 000` (space thousands separator).
 * Deliberately NOT mga() — the space form was requested for notifications.
 */
export function notifAmount(amount: number): string {
  const n = Math.round(Number.isFinite(amount) ? amount : 0)
  return 'Ar ' + n.toLocaleString('en-US').replace(/,/g, ' ')
}

// ─── Kiné wording (shared by the feed and the push) ──────────
/** "Rakoto (Ar 60 000) paid" — also how a synced Kiné income transaction reads. */
export function kinePaidLine(client: string, amount: number): string {
  return `${client} (${notifAmount(amount)}) paid`
}
/** "Rakoto (3) sessions logged" — sessions is the client's delivered count. */
export function kineSessionLine(client: string, sessions: number): string {
  return `${client} (${sessions}) sessions logged`
}
/** "New client - Rakoto - Added" */
export function kineNewClientLine(client: string): string {
  return `New client - ${client} - Added`
}
/** "Rakoto - Contract Finished" */
export function kineContractEndLine(client: string): string {
  return `${client} - Contract Finished`
}

/** Description suffix kine.tsx puts on a budget-synced Kiné payment. */
const KINE_TXN_SUFFIX = /- Kiné Privée$/

/**
 * Describe a transaction exactly the way the Home "Today's Activity" feed shows it.
 * Used by both the dashboard and the ntfy push so the wording never diverges.
 */
export function classifyTransaction(t: Transaction): NotifLine {
  const desc = (t.description || '').trim()
  const who = t.added_by_display_name || '—'
  const amount = notifAmount(t.amount)

  // Kiné payment — a synced income transaction is described "{client} - Kiné Privée"
  if (KINE_TXN_SUFFIX.test(desc)) {
    const client = desc.replace(/\s*-\s*Kiné Privée$/, '').trim() || 'Kiné'
    return { href: '/kine', accent: 'orange', line1: kinePaidLine(client, t.amount), line2: '' }
  }

  if (t.type === 'expense') {
    return {
      href: '/budget',
      accent: 'red',
      line1: `${who} - Expense - ${t.category_name || t.group_name || '—'}`,
      line2: desc ? `${amount} - ${desc}` : amount,
    }
  }

  return {
    href: '/budget',
    accent: 'green',
    line1: `${who} - Income - ${t.income_account_name || '—'}`,
    line2: desc ? `${amount} - ${desc}` : amount,
  }
}

// ─── App settings (key/value) ────────────────────────────────
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>()
  return row?.value ?? null
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
    .bind(key, value)
    .run()
}

// ─── ntfy ────────────────────────────────────────────────────
// Emoji tag shown by the ntfy app, per notification kind.
const TAGS: Record<string, string[]> = {
  orange: ['orange_circle'],
  blue: ['handshake'],
  red: ['money_with_wings'],
  green: ['moneybag'],
}

/**
 * Push a notification to the configured ntfy server.
 * Silently no-ops when the server/topic settings are missing, and never throws —
 * a failed notification must never break a user action.
 *
 * With two lines: line 1 becomes the ntfy title and line 2 the message.
 * A one-line event (Kiné) has no second line, so the text is sent as the message
 * with no title — never as an empty message with only a title, which some ntfy
 * clients render as a blank body.
 */
export async function pushNtfy(db: D1Database, title: string, message: string, accent = 'green'): Promise<void> {
  try {
    const server = ((await getSetting(db, 'ntfy_server')) || '').trim()
    const topic = ((await getSetting(db, 'ntfy_topic')) || '').trim()
    if (!server || !topic) return

    const hasBody = message.trim().length > 0
    const payload: Record<string, unknown> = {
      topic,
      message: hasBody ? message : title,
      tags: TAGS[accent] || [],
    }
    if (hasBody && title.trim()) payload.title = title

    const base = server.replace(/\/+$/, '')
    await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    // ignore — notifications are best-effort
  }
}

/**
 * Load a transaction (with its category/group/account/user names) and push it to ntfy.
 * Call this right after inserting a transaction.
 */
export async function notifyTransaction(db: D1Database, txnId: string | null): Promise<void> {
  if (!txnId) return
  try {
    const t = await db
      .prepare(
        `SELECT t.*, c.name AS category_name, cg.name AS group_name,
                ia.name AS income_account_name, u.display_name AS added_by_display_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN category_groups cg ON c.group_id = cg.id
         LEFT JOIN income_accounts ia ON t.income_account_id = ia.id
         LEFT JOIN users u ON t.added_by_user_id = u.id
         WHERE t.id = ?`
      )
      .bind(txnId)
      .first<Transaction>()
    if (!t) return

    const n = classifyTransaction(t)
    await pushNtfy(db, n.line1, n.line2, n.accent)
  } catch {
    // ignore
  }
}

// ─── Kiné events that are NOT transactions ───────────────────
// A ticked session, a new client and a finished contract leave no transaction
// row, so they push directly. The wording lives here so the feed and the push
// can never drift apart (the same reason classifyTransaction exists).
export const kineNotify = {
  /** A session was ticked in the attendance grid. */
  sessionLogged(db: D1Database, client: string, sessions: number): Promise<void> {
    return pushNtfy(db, '', kineSessionLine(client, sessions), 'orange')
  },
  /** A payment recorded without a synced budget income (the synced case goes
   *  through notifyTransaction, which renders the same line). */
  paid(db: D1Database, client: string, amount: number): Promise<void> {
    return pushNtfy(db, '', kinePaidLine(client, amount), 'orange')
  },
  newClient(db: D1Database, client: string): Promise<void> {
    return pushNtfy(db, '', kineNewClientLine(client), 'orange')
  },
  contractFinished(db: D1Database, client: string): Promise<void> {
    return pushNtfy(db, '', kineContractEndLine(client), 'orange')
  },
}
