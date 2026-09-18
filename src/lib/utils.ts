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

// ─── Week helpers (SAT-FRI cycle) ────────────────────────────
export function currentWeekBounds(offsetWeeks = 0): { start: string; end: string } {
  const today = new Date()
  const day = today.getDay() // 0=Sun … 6=Sat
  // days since last Saturday (day 6)
  const sinceSat = (day + 1) % 7
  const sat = new Date(today)
  sat.setDate(today.getDate() - sinceSat + offsetWeeks * 7)
  const fri = new Date(sat)
  fri.setDate(sat.getDate() + 6)
  return {
    start: sat.toISOString().slice(0, 10),
    end:   fri.toISOString().slice(0, 10),
  }
}

export function formatDate(d: string): string {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric'
  })
}

// ─── Month helpers (calendar month, local) ───────────────────
function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function currentMonthBounds(offsetMonths = 0): { start: string; end: string; label: string } {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() + offsetMonths, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
  return {
    start: isoLocal(first),
    end: isoLocal(last),
    label: first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
  }
}

// ─── Currency formatter ───────────────────────────────────────
export function mga(amount: number): string {
  return `Ar ${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

// ─── User accent color (orange = Niri, blue = MaxX) ──────────
export function userAccentColor(displayName: string | null | undefined): string {
  const n = (displayName || '').toLowerCase()
  if (n === 'niri') return 'bg-orange-500'
  if (n === 'maxx') return 'bg-blue-500'
  return 'bg-gray-400'
}

// ─── Current balance grading ─────────────────────────────────
// red < 0 · yellow < 200k · blue < 500k · green ≥ 500k
export function currentGradedColor(v: number): string {
  if (v < 0) return 'text-red-500 dark:text-red-400'
  if (v < 200000) return 'text-yellow-500 dark:text-yellow-400'
  if (v < 500000) return 'text-blue-500 dark:text-blue-400'
  return 'text-green-600 dark:text-green-400'
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
