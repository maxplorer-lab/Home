// session.ts
// Cookie-handling shared by device sessions (μlogger, via routes/ingest.ts)
// and human dashboard sessions (routes/auth.ts, index.ts's /ws upgrade).
// Both use the same signed-token mechanism from auth-crypto.ts -- this
// file just centralizes cookie names/TTLs/parsing so they don't drift
// out of sync across files.

export const DEVICE_SESSION_COOKIE = "way_device_session";
export const USER_SESSION_COOKIE = "way_user_session";

// Phones and dashboard sessions both stay logged in for 30 days by
// default -- no re-login flow exists on the device side, and dashboard
// convenience matters more than session hygiene at household scale.
// Adjust independently here if you ever want them to differ.
export const DEVICE_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const USER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      let value = part.slice(eq + 1).trim();
      // Some clients (confirmed: μlogger's Android HTTP client) send
      // cookie values in the older RFC 2109 quoted form --
      // name="value" -- with the quote characters literally part of
      // the header. Strip a single matching pair if present; a plain
      // unquoted value (the common case) is untouched.
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }
  return null;
}

export function buildSetCookie(name: string, token: string, ttlSeconds: number, secure = false): string {
  // `Secure` is derived from the request scheme by the two callers, not
  // hardcoded: over plain http (wrangler dev) a Secure cookie is REJECTED
  // by browsers, which made local login silently not stick. Production is
  // unaffected -- *.workers.dev http requests are redirected to https at
  // the edge, so every real request is https and the flag is always set.
  return `${name}=${token}; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${ttlSeconds}`;
}

/** Set-Cookie value that immediately expires a cookie -- used by logout.
 * Same scheme rule as buildSetCookie: Secure only over https, or the
 * browser rejects the whole header and the cookie survives logout. */
export function buildClearCookie(name: string, secure = false): string {
  return `${name}=; Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Max-Age=0`;
}
