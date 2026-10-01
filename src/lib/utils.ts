// ─── Auth helpers ────────────────────────────────────────────
// Simple hash using Web Crypto (available in Cloudflare Workers)

export async function hashPin(pin: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', keyMaterial, enc.encode(pin))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function generateId(): string {
  return crypto.randomUUID()
}

export function generateToken(): string {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function sessionExpiresAt(): string {
  // 30-day rolling session
  const d = new Date()
  d.setDate(d.getDate() + 30)
  return d.toISOString()
}

// ─── App-timezone day helpers ────────────────────────────────
// The household is at UTC+3 (Africa/Nairobi, no DST) and Workers always run
// with TZ=UTC, so `getFullYear()/getMonth()/getDate()` and `toISOString()`
// return UTC dates — three hours behind the wall calendar. Every date the app
// derives from "now" goes through localDate()/addDays() instead.
export const TZ_OFFSET_MS = 3 * 60 * 60 * 1000

/** The household calendar's `YYYY-MM-DD` for an instant (defaults to now). */
export function localDate(d: Date = new Date()): string {
  const t = new Date(d.getTime() + TZ_OFFSET_MS)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/** `YYYY-MM-DD` moved by whole days — date-only, so no clock or timezone involved. */
export function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** SQLite date()/datetime() modifier: shifts a stored UTC value to local time. */
export const TZ_SQL_MODIFIER = `+${TZ_OFFSET_MS / 3_600_000} hours`

// ─── Week helpers (SAT-FRI cycle) ────────────────────────────
export function currentWeekBounds(offsetWeeks = 0): { start: string; end: string } {
  const today = localDate()
  const day = new Date(today + 'T00:00:00Z').getUTCDay() // 0=Sun … 6=Sat
  const sinceSat = (day + 1) % 7 // days since last Saturday (day 6)
  const start = addDays(today, -sinceSat + offsetWeeks * 7)
  return { start, end: addDays(start, 6) }
}

export function formatDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  })
}

// ─── Month helpers (calendar month, local) ───────────────────
export function currentMonthBounds(offsetMonths = 0): { start: string; end: string; label: string } {
  const [y, m] = localDate().split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1 + offsetMonths, 1))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0))
  return {
    start: first.toISOString().slice(0, 10),
    end: last.toISOString().slice(0, 10),
    label: first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  }
}

// ─── Currency formatter ───────────────────────────────────────
export function mga(amount: number): string {
  return `Ar ${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

// ─── Per-person dot colour ───────────────────────────────────
// The dot tells one person's rows from another's, so its only job is to be
// STABLE and DISTINGUISHABLE. The household's two accounts keep the colours
// they have always had (recognised everywhere: the legend beside the
// transaction list, the map's chat scrollback); anyone else the admin creates
// gets a colour picked from the palette below by a hash of their name, rather
// than the flat grey this used to return — two extra people in grey are the
// same person as far as the eye is concerned.
const EXTRA_DOT_COLORS = [
  'bg-teal-500', 'bg-violet-500', 'bg-pink-500', 'bg-amber-500',
  'bg-lime-500', 'bg-cyan-500', 'bg-rose-500', 'bg-indigo-500',
]

export function userAccentColor(displayName: string | null | undefined): string {
  // Folded first, so these two comparisons are names, not spellings: `Niri`
  // reaches the orange branch without the literal below ever holding a name
  // that is written anywhere else (AGENTS.md rule 33).
  const n = (displayName || '').toLowerCase()
  if (n === 'niri') return 'bg-orange-500'
  if (n === 'maxx') return 'bg-blue-500'
  if (!n) return 'bg-gray-400'
  let hash = 0
  for (let i = 0; i < n.length; i++) hash = (hash * 31 + n.charCodeAt(i)) % 100000
  return EXTRA_DOT_COLORS[hash % EXTRA_DOT_COLORS.length]!
}

// ─── Current balance grading ─────────────────────────────────
// red < 0 · yellow < 200k · blue < 500k · green ≥ 500k
//
// The light-mode weights are the 700 step, not the 500 one: this is the colour
// the home page prints CASH ON HAND in, and yellow-500 on a white sheet
// measures 2.3:1 — under the 3:1 floor even for a 30px figure. The 700 step
// clears 4.5:1 on every one of the four, and dark mode keeps the 400 (4.6-8:1
// on #1f2937).
export function currentGradedColor(v: number): string {
  if (v < 0) return 'text-red-700 dark:text-red-400'
  if (v < 200000) return 'text-yellow-700 dark:text-yellow-400'
  if (v < 500000) return 'text-blue-700 dark:text-blue-400'
  return 'text-green-700 dark:text-green-400'
}

export function currentGradedFill(v: number): string {
  if (v < 0) return '#ef4444'
  if (v < 200000) return '#eab308'
  if (v < 500000) return '#3b82f6'
  return '#16a34a'
}

// Full tinted-card class set (bg + text + border) for the Current balance.
export function currentGradedTone(v: number): string {
  if (v < 0) return 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-100 dark:border-red-800'
  if (v < 200000) return 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 border-yellow-100 dark:border-yellow-800'
  if (v < 500000) return 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-blue-100 dark:border-blue-800'
  return 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 border-green-100 dark:border-green-800'
}
