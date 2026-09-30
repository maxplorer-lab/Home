// ─── One cookie vocabulary ───────────────────────────────────────
// The parser, the Set-Cookie builders and the "does this request count as
// https" rule that every session site needs. They used to exist three times
// over (src/index.tsx, src/identity.ts, src/way/lib/session.ts) and had
// already drifted: only W.A.Y's copy stripped the RFC 2109 quoted form,
// which is the form μlogger's Android client actually sends. One copy now,
// so a fix in the parser is a fix everywhere a cookie is read.
//
// No cookie NAME lives here: identity.ts keeps the per-module constants and
// way/lib/session.ts keeps its device/user names and TTLs. This file knows
// only the SHAPE of a cookie.

/** The value of `name` in the request's Cookie header, or null.
 *
 * Some clients (confirmed: μlogger's Android HTTP client) send cookie
 * values in the older RFC 2109 quoted form -- name="value" -- with the
 * quote characters literally part of the header. Strip a single matching
 * pair if present; a plain unquoted value (every browser, the common case)
 * is untouched. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) {
      let value = part.slice(idx + 1).trim()
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      }
      return value
    }
  }
  return null
}

export function setCookieValue(name: string, token: string, maxAgeSeconds: number, secure = false): string {
  // `Secure` is derived from the request scheme by the caller, not
  // hardcoded: over plain http (wrangler dev) a Secure cookie is REJECTED
  // by browsers, which made local login silently not stick. Production is
  // unaffected -- *.workers.dev http requests are redirected to https at
  // the edge, so every real request is https and the flag is always set.
  return `${name}=${token}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

/** Set-Cookie value that immediately expires a cookie -- used by logout.
 * Same scheme rule as setCookieValue: Secure only over https, or the
 * browser rejects the whole header and the cookie survives logout. */
export function clearCookieValue(name: string, secure = false): string {
  return `${name}=; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=0`
}

/** True when a cookie set for this URL will be honoured over the request's
 * scheme. Loopback counts as secure because browsers treat it as
 * trustworthy; a plain-HTTP LAN IP must NOT get Secure cookies or login
 * would silently not stick. An unparseable URL is treated as secure
 * (production is https). */
export function isSecureRequest(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return true
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  } catch {
    return true
  }
}
