// ─── Home identity engine ────────────────────────────────────────
// ONE login per person for the whole super app: username + password,
// created by an admin. Stored in the central home-db (HOME_DB).
//
// The three modules keep their own databases and their own session
// mechanisms — this engine bridges them:
//
//   home-db    HOME_DB    users + sessions (THE login)
//   Sompitra   DB         find-or-create its user row (uuid TEXT ids);
//                         pages auth via its D1 `sessions` table + cookie `session`
//   W.A.Y      WAY_DB     find-or-create its user row; auth via stateless
//                         HMAC token cookie `way_user_session` (SESSION_SECRET)
//   Laoka      LAOKA_DB   find-or-create its user row; auth via D1-backed
//                         `sessions` table + cookie `laoka_session`
//
// On every login (and on any module 401 while a Home session lives — the
// "auto-repair" path) this engine:
//   1. provisions the person into each module DB that lacks their account
//      (idempotent, best-effort — one module failing never blocks the rest),
//   2. mints that module's native session cookie.
//
// Password hashing mirrors Laoka's scheme exactly (HMAC pepper then
// PBKDF2-SHA-256, base64 columns, per-row iterations) so the SAME crypto
// verifies the login and provisions Laoka rows byte-compatibly. W.A.Y rows
// use W.A.Y's own format ("salt:hash" hex, 100k iterations) so its μlogger
// Basic Auth keeps working unchanged.
//
// Every module helper is best-effort: a missing secret or a database hiccup
// must never break the central login itself.

import type { Env } from './env'

// ── Cookie names (one per module, all Path=/ on this origin) ─────
export const HOME_COOKIE = 'home_session'
export const SOMPITRA_COOKIE = 'session'
export const WAY_COOKIE = 'way_user_session'
export const LAOKA_COOKIE = 'laoka_session'

export const HOME_SESSION_DAYS = 30
export const LAOKA_SESSION_DAYS = 90
export const MODULE_SESSION_SECONDS = 30 * 24 * 60 * 60

// ── Validation (same rules as Laoka's local accounts) ────────────
export function validUsername(name: unknown): name is string {
  return /^[A-Za-z0-9._-]{3,24}$/.test(String(name || ''))
}
export function validPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200
}

// ── Password hashing — Laoka-compatible (pepper + PBKDF2) ────────
const encoder = new TextEncoder()
const MIN_PEPPER_LENGTH = 16

export function pepperConfigured(env: Env): boolean {
  return String(env.AUTH_PEPPER || '').length >= MIN_PEPPER_LENGTH
}

function iterationsFor(env: Env): number {
  const raw = Number(env.PBKDF2_ITERATIONS || 0)
  if (!Number.isFinite(raw) || raw < 1000) return 5000
  return Math.min(Math.trunc(raw), 1000000)
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}
function fromBase64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function pepperKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(String(env.AUTH_PEPPER || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

export function newSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)))
}

/** Laoka-compatible hash: HMAC(pepper, password) → PBKDF2-SHA-256. */
export async function hashPassword(env: Env, password: string, saltBase64?: string, iterations?: number): Promise<{ hash: string; salt: string; iterations: number }> {
  const key = await pepperKey(env)
  const peppered = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(String(password))))
  const salt = saltBase64 ? fromBase64(saltBase64) : fromBase64(newSalt())
  const rounds = iterations || iterationsFor(env)
  const base = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-256' }, base, 256)
  return { hash: toBase64(new Uint8Array(bits)), salt: toBase64(salt), iterations: rounds }
}

export async function verifyPassword(env: Env, password: string, user: { password_hash: string | null; password_salt: string | null; password_iterations: number | null }): Promise<boolean> {
  if (!user.password_hash || !user.password_salt) return false
  const attempt = await hashPassword(env, password, user.password_salt, user.password_iterations || 5000)
  return sameString(attempt.hash, user.password_hash)
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ── Password hashing — W.A.Y-compatible ("salt:hash" hex, 100k) ──
// W.A.Y verifies this format both for dashboard login AND μlogger Basic
// Auth, so provisioned rows must use its exact scheme.
const WAY_PBKDF2_ITERATIONS = 100_000

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function wayHashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: WAY_PBKDF2_ITERATIONS, hash: 'SHA-256' }, keyMaterial, 256)
  return `${toHex(salt)}:${toHex(bits)}`
}

// ── Tokens ───────────────────────────────────────────────────────

function randomTokenB64url(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomTokenHex(): string {
  const arr = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return toHex(digest)
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

/** W.A.Y session token: payloadB64.sig, HMAC-SHA256 with SESSION_SECRET. */
export async function signWayToken(payload: Record<string, string | number>, secret: string): Promise<string> {
  const bytes = encoder.encode(JSON.stringify(payload))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const payloadB64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const key = await hmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64))
  return `${payloadB64}.${base64urlBytes(new Uint8Array(sig))}`
}

function base64urlBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── Rate limiting (failed logins) ────────────────────────────────
const MAX_ATTEMPTS = 10
const WINDOW_MINUTES = 60

export async function tooManyAttempts(db: D1Database, key: string): Promise<boolean> {
  const row = await db.prepare('SELECT count, window_start FROM attempts WHERE key = ?1').bind(key).first<{ count: number; window_start: string }>()
  if (!row) return false
  const started = Date.parse(row.window_start.replace(' ', 'T') + 'Z')
  if (!Number.isFinite(started)) return false
  if (Date.now() - started > WINDOW_MINUTES * 60000) return false
  return row.count >= MAX_ATTEMPTS
}

export async function noteAttempt(db: D1Database, key: string): Promise<void> {
  const cutoff = '-' + WINDOW_MINUTES + ' minutes'
  await db.prepare(
    "INSERT INTO attempts (key, count, window_start) VALUES (?1, 1, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET " +
    "count = CASE WHEN attempts.window_start < datetime('now', ?2) THEN 1 ELSE attempts.count + 1 END, " +
    "window_start = CASE WHEN attempts.window_start < datetime('now', ?2) THEN datetime('now') ELSE attempts.window_start END"
  ).bind(key, cutoff).run()
}

export async function clearAttempts(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM attempts WHERE key = ?1').bind(key).run()
}

// ── Central user directory (HOME_DB) ─────────────────────────────

export interface HomeUser {
  id: string
  username: string
  display_name: string | null
  role: 'admin' | 'member'
  is_active: number
  last_login_at: string | null
}

const HOME_USER_COLUMNS = 'id, username, display_name, role, is_active, last_login_at'

export async function findHomeUserByName(db: D1Database, username: string): Promise<(HomeUser & { password_hash: string | null; password_salt: string | null; password_iterations: number | null }) | null> {
  return await db.prepare(
    `SELECT ${HOME_USER_COLUMNS}, password_hash, password_salt, password_iterations FROM users WHERE lower(username) = lower(?1)`
  ).bind(String(username || '')).first()
}

export async function listHomeUsers(db: D1Database): Promise<HomeUser[]> {
  const res = await db.prepare(`SELECT ${HOME_USER_COLUMNS} FROM users ORDER BY created_at`).all<HomeUser>()
  return res.results || []
}

export interface CreateHomeUserInput {
  username: string
  password: string
  displayName?: string
  role?: 'admin' | 'member'
}

/** Admin action: create a person. The password is required — there is no
 * invite flow; the admin hands out credentials directly. */
export async function createHomeUser(env: Env, input: CreateHomeUserInput): Promise<{ ok: true; user: HomeUser } | { ok: false; error: string }> {
  if (!validUsername(input.username)) return { ok: false, error: 'Usernames are 3 to 24 characters: letters, numbers, dot, dash or underscore.' }
  if (!validPassword(input.password)) return { ok: false, error: 'Passwords must be at least 8 characters.' }
  if (!pepperConfigured(env)) return { ok: false, error: 'AUTH_PEPPER is not configured on this Worker.' }

  const existing = await findHomeUserByName(env.HOME_DB, input.username)
  if (existing) return { ok: false, error: 'That username is already taken.' }

  const hashed = await hashPassword(env, input.password)
  const id = crypto.randomUUID()
  await env.HOME_DB.prepare(
    'INSERT INTO users (id, username, display_name, role, password_hash, password_salt, password_iterations) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  ).bind(id, input.username, input.displayName?.trim() || input.username, input.role === 'admin' ? 'admin' : 'member', hashed.hash, hashed.salt, hashed.iterations).run()

  const user = await env.HOME_DB.prepare(`SELECT ${HOME_USER_COLUMNS} FROM users WHERE id = ?1`).bind(id).first<HomeUser>()
  return { ok: true, user: user! }
}

/** Admin action: set/replace a person's password (rows may pre-date a
 * password — legacy accounts merged from a module DB). */
export async function setHomePassword(env: Env, userId: string, password: string): Promise<{ ok: boolean; error?: string }> {
  if (!validPassword(password)) return { ok: false, error: 'Passwords must be at least 8 characters.' }
  if (!pepperConfigured(env)) return { ok: false, error: 'AUTH_PEPPER is not configured on this Worker.' }
  const hashed = await hashPassword(env, password)
  await env.HOME_DB.prepare('UPDATE users SET password_hash = ?1, password_salt = ?2, password_iterations = ?3 WHERE id = ?4')
    .bind(hashed.hash, hashed.salt, hashed.iterations, userId).run()
  return { ok: true }
}

// ── Central sessions (home-db) ───────────────────────────────────

export async function createHomeSession(db: D1Database, userId: string): Promise<string> {
  const token = randomTokenB64url()
  const hash = await sha256Hex(token)
  await db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, datetime('now', ?3))"
  ).bind(hash, userId, '+' + HOME_SESSION_DAYS + ' days').run()
  // Opportunistic tidy-up, like Laoka's own session table.
  await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run()
  return token
}

export async function getHomeUserFromCookie(db: D1Database, token: string | undefined | null): Promise<HomeUser | null> {
  if (!token) return null
  try {
    const hash = await sha256Hex(token)
    return await db.prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.is_active, u.last_login_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?1 AND s.expires_at > datetime('now') AND u.is_active = 1`
    ).bind(hash).first<HomeUser>()
  } catch {
    return null
  }
}

export async function destroyHomeSession(db: D1Database, token: string | undefined | null): Promise<void> {
  if (!token) return
  const hash = await sha256Hex(token)
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(hash).run()
}

// ── Module provisioning (find-or-create, idempotent) ─────────────

export interface ModuleAccounts {
  sompitra: { id: string; username: string } | null
  way: { id: number; username: string } | null
  laoka: { id: number; username: string } | null
}

// The password is only available at login time; the auto-repair path never
// needs to CREATE accounts (it repairs sessions for accounts that exist),
// so it is threaded via this module-level field instead of changing every
// call signature. Set per request before ensureModuleAccounts runs.
let lastPassword: string | null = null

/** Make sure this person exists in every module database. Missing rows are
 * created with the SAME username and credentials; existing rows are left
 * alone (legacy accounts simply get linked by username). */
export async function ensureModuleAccounts(env: Env, user: HomeUser): Promise<ModuleAccounts> {
  const out: ModuleAccounts = { sompitra: null, way: null, laoka: null }
  const name = user.username
  const display = (user.display_name || user.username).trim()

  // Sompitra — uuid TEXT ids, pin_hash NOT NULL (unused now, empty string).
  try {
    const found = await env.DB.prepare('SELECT id, username FROM users WHERE lower(username) = lower(?1)').bind(name).first<{ id: string; username: string }>()
    if (found) {
      out.sompitra = found
    } else {
      const id = crypto.randomUUID()
      await env.DB.prepare(
        "INSERT INTO users (id, username, display_name, pin_hash, is_admin) VALUES (?1, ?2, ?3, '', ?4)"
      ).bind(id, name, display, user.role === 'admin' ? 1 : 0).run()
      out.sompitra = { id, username: name }
    }
  } catch { /* sompitra-db hiccup — cookie skipped, repair retries later */ }

  // W.A.Y — integer ids, "salt:hash" PBKDF2 in ITS OWN format (the same
  // hash doubles as the μlogger Basic Auth credential, so it must be
  // W.A.Y-compatible). Existing rows keep their password untouched.
  try {
    const found = await env.WAY_DB.prepare('SELECT id, username FROM users WHERE lower(username) = lower(?1)').bind(name).first<{ id: number; username: string }>()
    if (found) {
      out.way = found
    } else if (lastPassword) {
      const passwordHash = await wayHashPassword(lastPassword)
      const made = await env.WAY_DB.prepare(
        "INSERT INTO users (username, password_hash, role) VALUES (?1, ?2, ?3)"
      ).bind(name, passwordHash, user.role === 'admin' ? 'admin' : 'member').run()
      out.way = { id: Number(made.meta.last_row_id), username: name }
    }
  } catch { /* ignore */ }

  // Laoka — integer ids, Laoka-format hash. A legacy row (password NULL)
  // gets its credentials filled in, merging the old account.
  try {
    const found = await env.LAOKA_DB.prepare(
      'SELECT id, username, password_hash FROM users WHERE lower(username) = lower(?1)'
    ).bind(name).first<{ id: number; username: string; password_hash: string | null }>()
    if (found) {
      out.laoka = { id: found.id, username: found.username }
      if (!found.password_hash && lastPassword && pepperConfigured(env)) {
        const hashed = await hashPassword(env, lastPassword)
        await env.LAOKA_DB.prepare('UPDATE users SET password_hash = ?1, password_salt = ?2, password_iterations = ?3 WHERE id = ?4')
          .bind(hashed.hash, hashed.salt, hashed.iterations, found.id).run()
      }
    } else if (lastPassword && pepperConfigured(env)) {
      const hashed = await hashPassword(env, lastPassword)
      const made = await env.LAOKA_DB.prepare(
        'INSERT INTO users (username, role, display_name, password_hash, password_salt, password_iterations) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      ).bind(name, user.role === 'admin' ? 'admin' : 'member', display, hashed.hash, hashed.salt, hashed.iterations).run()
      out.laoka = { id: Number(made.meta.last_row_id), username: name }
    }
  } catch { /* ignore */ }

  return out
}

/** Provision with credentials (login path — may create rows). */
export async function ensureModuleAccountsWithPassword(env: Env, user: HomeUser, password: string): Promise<ModuleAccounts> {
  lastPassword = password
  try {
    return await ensureModuleAccounts(env, user)
  } finally {
    lastPassword = null
  }
}

/** Provision without credentials (repair path — never creates rows). */
export async function ensureModuleAccountsWithoutPassword(env: Env, user: HomeUser): Promise<ModuleAccounts> {
  return ensureModuleAccounts(env, user)
}

// ── Module session minting ───────────────────────────────────────

function isSecureRequest(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    // Browsers treat loopback as trustworthy; plain-HTTP LAN IPs must NOT
    // get Secure cookies or login would silently not stick.
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  } catch {
    return true
  }
}

function cookieValue(name: string, token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${name}=${token}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

interface MintedCookie {
  name: string
  value: string
}

/** Create every module session for this person and return the Set-Cookie
 * values. Provisioning runs first so the session rows reference real users. */
export async function mintModuleCookies(env: Env, user: HomeUser, secure: boolean, password?: string): Promise<MintedCookie[]> {
  const out: MintedCookie[] = []
  const accounts = password !== undefined
    ? await ensureModuleAccountsWithPassword(env, user, password)
    : await ensureModuleAccountsWithoutPassword(env, user)

  // Sompitra — D1-backed session row + raw-token cookie (its native scheme).
  if (accounts.sompitra) {
    try {
      const token = randomTokenHex()
      const expires = new Date(Date.now() + MODULE_SESSION_SECONDS * 1000).toISOString()
      await env.DB.prepare('INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?1, ?2, ?3, ?4)')
        .bind(crypto.randomUUID(), accounts.sompitra.id, token, expires).run()
      out.push({ name: SOMPITRA_COOKIE, value: cookieValue(SOMPITRA_COOKIE, token, secure, MODULE_SESSION_SECONDS) })
    } catch { /* skip */ }
  }

  // W.A.Y — stateless signed token.
  if (accounts.way && env.SESSION_SECRET) {
    try {
      const token = await signWayToken(
        { userId: accounts.way.id, username: accounts.way.username, exp: Math.floor(Date.now() / 1000) + MODULE_SESSION_SECONDS },
        env.SESSION_SECRET,
      )
      out.push({ name: WAY_COOKIE, value: cookieValue(WAY_COOKIE, token, secure, MODULE_SESSION_SECONDS) })
    } catch { /* skip */ }
  }

  // Laoka — D1-backed session, SHA-256-hashed token (its native scheme).
  if (accounts.laoka) {
    try {
      const token = randomTokenB64url()
      const hash = await sha256Hex(token)
      await env.LAOKA_DB.prepare(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1, ?2, datetime('now', ?3))"
      ).bind(hash, accounts.laoka.id, '+' + LAOKA_SESSION_DAYS + ' days').run()
      out.push({ name: LAOKA_COOKIE, value: cookieValue(LAOKA_COOKIE, token, secure, LAOKA_SESSION_DAYS * 24 * 60 * 60) })
    } catch { /* skip */ }
  }

  return out
}

/** Auto-repair: mint ONE module's cookie (used when a browser arrives with a
 * live Home session but no/stale module cookie). Returns the Set-Cookie
 * value or null. */
export async function promoteSession(env: Env, target: 'sompitra' | 'way' | 'laoka', user: HomeUser, secure: boolean): Promise<string | null> {
  const cookies = await mintModuleCookies(env, user, secure)
  const want = target === 'sompitra' ? SOMPITRA_COOKIE : target === 'way' ? WAY_COOKIE : LAOKA_COOKIE
  return cookies.find((c) => c.name === want)?.value ?? null
}

// ── Notification channels (TWO per person, app-wide) ─────────────
// The channels belong to the PERSON, not to a module: a phone follows two
// ntfy topics, because the two halves of the app are filtered differently.
// See migrations-home/0002 (the first one) and 0004 (the split):
//
//   ntfy_topic   the FEED      money + Kiné, in the chat's wording. Sent to
//                              EVERY active person, including whoever
//                              recorded it. Nothing filters it.
//   way_topic    TRACKING      W.A.Y activity (chat, entry, exit, stationary,
//                              moving, approach). W.A.Y's own grid decides
//                              who receives which event, and nobody is
//                              notified about their own.

/** Topic alphabet: URL-safe, no look-alikes (0/O, 1/l). */
const TOPIC_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/** Random suffix shared by both generators. A channel is a bearer secret —
 *  anyone who knows it can subscribe — so it is never chosen by hand. */
function randomTopicSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  let suffix = ''
  for (const b of bytes) suffix += TOPIC_ALPHABET[b % TOPIC_ALPHABET.length]
  return suffix
}

/** The feed channel (money + Kiné). */
export function generateNtfyTopic(): string {
  return `home-${randomTopicSuffix()}`
}

/** The tracking channel (W.A.Y activity). The `way-` prefix is not cosmetic:
 *  phones in the field are already following `way-…` topics, so a regenerated
 *  one looks like what it replaces. */
export function generateWayTopic(): string {
  return `way-${randomTopicSuffix()}`
}

/**
 * Just the bindings the channel writers touch.
 *
 * Narrowed on purpose: W.A.Y's module code carries its own small `Env`
 * interface (its own database plus this one), and asking it for the whole app's
 * bindings just to write two columns would be a type-only coupling between two
 * things that have no other reason to know about each other. `WAY_DB` is
 * optional because a caller with no W.A.Y database to mirror into is legitimate.
 */
export interface ChannelEnv {
  HOME_DB: D1Database
  WAY_DB?: D1Database
}

export interface NtfyChannel {
  id: string
  username: string
  display_name: string | null
  ntfy_topic: string | null
  ntfy_topic_set_at: string | null
  way_topic: string | null
  way_topic_set_at: string | null
}

/** Everyone's channels — the admin view, and what a feed push iterates. */
export async function listNtfyChannels(db: D1Database): Promise<NtfyChannel[]> {
  const out = await db
    .prepare(
      `SELECT id, username, display_name, ntfy_topic, ntfy_topic_set_at, way_topic, way_topic_set_at
       FROM users WHERE is_active = 1 ORDER BY display_name, username`
    )
    .all<NtfyChannel>()
  return out.results ?? []
}

/** Give a person a channel if they have none. Returns the topic. */
export async function ensureNtfyTopic(db: D1Database, userId: string): Promise<string> {
  const row = await db
    .prepare('SELECT ntfy_topic FROM users WHERE id = ?')
    .bind(userId)
    .first<{ ntfy_topic: string | null }>()
  if (row?.ntfy_topic) return row.ntfy_topic
  return await setNtfyTopic(db, userId, generateNtfyTopic())
}

/** Write a channel (generated by default). Rotating one is immediate: the old
 *  topic stops receiving, so the person must be shown the new one. */
export async function setNtfyTopic(db: D1Database, userId: string, topic?: string): Promise<string> {
  const value = topic || generateNtfyTopic()
  await db
    .prepare("UPDATE users SET ntfy_topic = ?, ntfy_topic_set_at = datetime('now') WHERE id = ?")
    .bind(value, userId)
    .run()
  return value
}

/** Turn a channel off entirely (the phone stops hearing anything). */
export async function clearNtfyTopic(db: D1Database, userId: string): Promise<void> {
  await db.prepare('UPDATE users SET ntfy_topic = NULL, ntfy_topic_set_at = NULL WHERE id = ?').bind(userId).run()
}

/** Give a person a tracking channel if they have none. Returns the topic. */
export async function ensureWayTopic(env: ChannelEnv, userId: string): Promise<string> {
  const row = await env.HOME_DB
    .prepare('SELECT way_topic FROM users WHERE id = ?')
    .bind(userId)
    .first<{ way_topic: string | null }>()
  if (row?.way_topic) return row.way_topic
  return await setWayTopic(env, userId, generateWayTopic())
}

/**
 * Write a person's tracking channel (generated by default), and mirror it into
 * W.A.Y's own copy of the column.
 *
 * The identity database is the authority — that is what makes one phone follow
 * one topic no matter which module publishes. The mirror exists for the
 * opposite case: the standalone W.A.Y Worker is still a deployable build, and
 * if it is ever serving again it must publish to the topic the phone is
 * actually following rather than to the one it replaced. Best-effort: a
 * missing way-db (or nobody by that name) must not fail the rotation.
 *
 * Rotating is immediate — the old topic stops receiving, so the new one has to
 * be shown to the person straight away.
 */
export async function setWayTopic(env: ChannelEnv, userId: string, topic?: string): Promise<string> {
  const value = topic || generateWayTopic()
  const row = await env.HOME_DB
    .prepare('SELECT username FROM users WHERE id = ?')
    .bind(userId)
    .first<{ username: string }>()
  await env.HOME_DB
    .prepare("UPDATE users SET way_topic = ?, way_topic_set_at = datetime('now') WHERE id = ?")
    .bind(value, userId)
    .run()
  await mirrorWayTopic(env, row?.username, value)
  return value
}

/** Turn the tracking channel off. Mirrored like a rotation, so a standalone
 *  W.A.Y rollback also stops pushing rather than resurrecting an old topic. */
export async function clearWayTopic(env: ChannelEnv, userId: string): Promise<void> {
  const row = await env.HOME_DB
    .prepare('SELECT username FROM users WHERE id = ?')
    .bind(userId)
    .first<{ username: string }>()
  await env.HOME_DB.prepare('UPDATE users SET way_topic = NULL, way_topic_set_at = NULL WHERE id = ?').bind(userId).run()
  await mirrorWayTopic(env, row?.username, null)
}

async function mirrorWayTopic(env: ChannelEnv, username: string | undefined, topic: string | null): Promise<void> {
  if (!username || !env.WAY_DB) return
  try {
    await env.WAY_DB
      .prepare('UPDATE users SET ntfy_topic = ? WHERE lower(username) = lower(?)')
      .bind(topic, username)
      .run()
  } catch {
    // No way-db, or no such person there: the home-db write already happened.
  }
}

/**
 * Promote the tracking topics that already exist in W.A.Y.
 *
 * W.A.Y has always owned a topic per person (way-db `users.ntfy_topic`), and a
 * phone in the field is still following it. Before the channels were split,
 * that topic was copied into the single home-db column; now it belongs in
 * `way_topic`, which is the column W.A.Y's events are routed to — so this
 * promotes it where it is actually used instead of pretending a tracking topic
 * is the money channel.
 *
 * ONCE, by username, and only when home-db has no tracking topic yet — an
 * existing channel (especially one the person has already put on their phone)
 * is never overwritten. Idempotent, safe to call on every boot.
 *
 * Returns how many channels were adopted.
 */
export async function adoptWayTopics(env: ChannelEnv): Promise<number> {
  let adopted = 0
  try {
    if (!env.WAY_DB) return 0
    const way = await env.WAY_DB
      .prepare('SELECT username, ntfy_topic FROM users WHERE ntfy_topic IS NOT NULL AND ntfy_topic != \'\'')
      .all<{ username: string; ntfy_topic: string }>()
    for (const row of way.results ?? []) {
      const res = await env.HOME_DB
        .prepare(
          `UPDATE users SET way_topic = ?, way_topic_set_at = datetime('now')
           WHERE lower(username) = lower(?) AND (way_topic IS NULL OR way_topic = '')`
        )
        .bind(row.ntfy_topic, row.username)
        .run()
      adopted += res.meta?.changes ?? 0
    }
  } catch {
    // A missing way-db (fresh deploy) must never break the settings page.
  }
  return adopted
}

// ── Household-level settings (home-db key/value) ────────────────
// For values that belong to the app as a whole rather than to a person or a
// module — currently the ntfy server root.

export async function getHomeSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM home_settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? null
}

export async function setHomeSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO home_settings (key, value) VALUES (?, ?)')
    .bind(key, value)
    .run()
}

// ── Unified logout ───────────────────────────────────────────────

export function clearCookieValue(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=0`
}

export { isSecureRequest }
