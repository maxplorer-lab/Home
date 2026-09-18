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
import type { Env } from '../env'
import { listNtfyChannels, getHomeSetting } from '../identity'
import { postSystemChat } from '../way/system-chat'

export interface NotifLine {
  href: string
  accent: string
  line1: string
  line2: string
  /** Which system-chat event type this describes. Kept here, next to the
   *  wording, so the dashboard feed, the ntfy push and the chat line can never
   *  disagree about what kind of thing just happened. Income and expense are
   *  deliberately SEPARATE types, not one "a transaction happened": money in
   *  and money out must never look alike in the chat. */
  kind: 'expense' | 'income' | 'kine'
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
    return { href: '/kine', accent: 'orange', kind: 'kine', line1: kinePaidLine(client, t.amount), line2: '' }
  }

  if (t.type === 'expense') {
    return {
      href: '/budget',
      accent: 'red',
      kind: 'expense',
      line1: `${who} - Expense - ${t.category_name || t.group_name || '—'}`,
      line2: desc ? `${amount} - ${desc}` : amount,
    }
  }

  return {
    href: '/budget',
    accent: 'green',
    kind: 'income',
    line1: `${who} - Income - ${t.income_account_name || '—'}`,
    line2: desc ? `${amount} - ${desc}` : amount,
  }
}

/**
 * The single-line form of a notification, used for the in-app chat where a
 * system row is one centred pill and has no room for a title/body split.
 * Derived from the same lines the ntfy push uses, so both always read alike.
 */
export function notifText(n: NotifLine): string {
  return n.line2 ? `${n.line1} · ${n.line2}` : n.line1
}

/**
 * Mirror an event into the household chat as a system message, so the chat is
 * the app's ONE activity feed -- WAY's arrivals and Sompitra's money events
 * land in the same scrollback, rendered the same way.
 *
 * Deliberately independent of ntfy: the chat works with no push server and no
 * per-person channel configured, because it is an in-app fact rather than a
 * delivery. Best-effort, never throws (postSystemChat swallows failures).
 */
async function mirrorToChat(env: Env, n: NotifLine): Promise<void> {
  await postSystemChat(env, notifText(n), n.kind)
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
 * The ntfy server root: household-wide, so it lives in home-db. Resolution
 * order is home-db -> Sompitra's old copy -> the deployment's NTFY_URL, so
 * notifications keep working on a deployment that has not moved the value yet,
 * and so both halves of the app publish to the SAME server (W.A.Y's Durable
 * Object runs the same chain).
 */
export async function ntfyServer(env: Env): Promise<string> {
  const fromHome = ((await getHomeSetting(env.HOME_DB, 'ntfy_server')) || '').trim()
  if (fromHome) return fromHome
  const legacy = ((await getSetting(env.DB, 'ntfy_server')) || '').trim()
  if (legacy) return legacy
  // Nothing in either database: fall back to the deployment's own NTFY_URL, which
  // is what W.A.Y's Durable Object has always resolved as its second layer
  // (setting -> env -> default). Without this step a deployment that never wrote
  // the setting pushes tracking events but silently drops money ones — two halves
  // of one household disagreeing about whether a server exists, which reads as a
  // bug in the money path rather than a missing setting.
  return (env.NTFY_URL || '').trim()
}

/**
 * Push one event to EVERY person's own ntfy channel.
 *
 * One channel per person is the whole point: each phone follows its own topic,
 * so the household's finance events and its tracking events all land in the
 * same place for each member. People with no channel set are simply skipped,
 * as is the whole push when there is no server — notifications are
 * best-effort and must never break a user action.
 *
 * With two lines: line 1 becomes the ntfy title and line 2 the message.
 * A one-line event (Kiné) has no second line, so the text is sent as the message
 * with no title — never as an empty message with only a title, which some ntfy
 * clients render as a blank body.
 */
export async function pushNtfy(env: Env, title: string, message: string, accent = 'green'): Promise<NtfyFanout> {
  const none: NtfyFanout = { sent: 0, failed: [] }
  try {
    const server = await ntfyServer(env)
    if (!server) return none

    const channels = (await listNtfyChannels(env.HOME_DB)).filter((u) => (u.ntfy_topic || '').trim())
    if (channels.length === 0) return none

    const hasBody = message.trim().length > 0
    const base = server.replace(/\/+$/, '')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`

    // Best-effort in parallel: one dead channel must not stop the others.
    const outcomes = await Promise.all(
      channels.map(async (u) => ({
        username: u.username,
        result: await pushTo(base, headers, u.ntfy_topic as string, title, message, hasBody, accent),
      }))
    )

    // Reported, not thrown: a push is never allowed to break the action that
    // triggered it. Each refusal is logged with the words the settings page
    // uses, so `wrangler tail` answers "did the household's money events go
    // out?" without needing anyone to reproduce it.
    const out: NtfyFanout = { sent: 0, failed: [] }
    for (const o of outcomes) {
      if (o.result.ok) out.sent += 1
      else {
        out.failed.push({ username: o.username, detail: o.result.detail })
        console.log(`ntfy feed push to ${o.username} refused: ${o.result.detail}`)
      }
    }
    return out
  } catch {
    // ignore — notifications are best-effort
    return none
  }
}

/**
 * The outcome of ONE publish.
 *
 * ntfy answers with a status code and refuses for reasons a person can act on
 * (401 when the server wants a token, 429 when a quota is exhausted), so the
 * answer is carried back instead of being discarded — "the test said sent but
 * nothing arrived" is not a diagnosable state.
 */
export interface NtfyPushResult {
  ok: boolean
  /** Plain-language outcome, safe to show in the UI. */
  detail: string
}

/** Every person's channel, and what happened to each. Money events reach the
 *  WHOLE household, so a partial failure is the normal shape of a problem. */
export interface NtfyFanout {
  sent: number
  failed: Array<{ username: string; detail: string }>
}

/** One channel, one event. Used by the fan-out above and by the "send test"
 *  button, which must reach the person's OWN channel and nobody else's. */
async function pushTo(
  base: string,
  headers: Record<string, string>,
  topic: string,
  title: string,
  message: string,
  hasBody: boolean,
  accent: string
): Promise<NtfyPushResult> {
  const payload: Record<string, unknown> = {
    topic,
    message: hasBody ? message : title,
    tags: TAGS[accent] || [],
  }
  if (hasBody && title.trim()) payload.title = title
  try {
    const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(payload) })
    if (res.ok) return { ok: true, detail: `ntfy accepted it (${res.status})` }
    // The body is where ntfy explains itself ("invalid access token", ...).
    const why = (await res.text().catch(() => '')).trim().slice(0, 120)
    return { ok: false, detail: `ntfy refused it (${res.status})${why ? `: ${why}` : ''}` }
  } catch (e) {
    // No response at all: wrong host, DNS, TLS, or the server is down.
    const why = e instanceof Error ? e.message : String(e)
    return { ok: false, detail: `could not reach ${base} (${why})` }
  }
}

/**
 * Send to exactly ONE person's channel. Returns false when there is no server
 * or that person has no channel, so the caller can say so plainly instead of
 * claiming a notification went out.
 */
export async function pushNtfyTo(env: Env, topic: string, title: string, message: string, accent = 'green'): Promise<NtfyPushResult> {
  try {
    const server = await ntfyServer(env)
    const target = (topic || '').trim()
    if (!target) return { ok: false, detail: 'that channel has no topic yet' }
    if (!server) return { ok: false, detail: 'no ntfy server is set (an admin can set one)' }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`
    return await pushTo(server.replace(/\/+$/, ''), headers, target, title, message, message.trim().length > 0, accent)
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Load a transaction (with its category/group/account/user names) and push it to ntfy.
 * Call this right after inserting a transaction.
 */
export async function notifyTransaction(env: Env, txnId: string | null): Promise<void> {
  if (!txnId) return
  const db = env.DB
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
    await pushNtfy(env, n.line1, n.line2, n.accent)
    await mirrorToChat(env, n)
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
  async sessionLogged(env: Env, client: string, sessions: number): Promise<void> {
    const line = kineSessionLine(client, sessions)
    await pushNtfy(env, '', line, 'orange')
    await postSystemChat(env, line, 'kine')
  },
  /** A payment recorded without a synced budget income (the synced case goes
   *  through notifyTransaction, which renders the same line). */
  async paid(env: Env, client: string, amount: number): Promise<void> {
    const line = kinePaidLine(client, amount)
    await pushNtfy(env, '', line, 'orange')
    await postSystemChat(env, line, 'kine')
  },
  async newClient(env: Env, client: string): Promise<void> {
    const line = kineNewClientLine(client)
    await pushNtfy(env, '', line, 'orange')
    await postSystemChat(env, line, 'kine')
  },
  async contractFinished(env: Env, client: string): Promise<void> {
    const line = kineContractEndLine(client)
    await pushNtfy(env, '', line, 'orange')
    await postSystemChat(env, line, 'kine')
  },
}
