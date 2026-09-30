// session.ts
// Cookie-handling shared by device sessions (μlogger, via routes/ingest.ts)
// and human dashboard sessions (routes/auth.ts, index.ts's /ws upgrade).
// Both use the same signed-token mechanism from auth-crypto.ts -- this
// file centralizes cookie names/TTLs so they don't drift out of sync
// across files.
//
// The parsing and the Set-Cookie SHAPE now live in src/lib/cookies.ts -- ONE
// vocabulary for the whole app, including the RFC 2109 quoted form
// μlogger's Android client sends (that strip used to live here, and only
// here; it is why the vocabulary is shared). The primitives below are
// re-exported under W.A.Y's own spellings so its callers keep reading
// naturally: getCookie(request, name), buildSetCookie(name, token,
// ttlSeconds, secure), buildClearCookie(name, secure).

export const DEVICE_SESSION_COOKIE = "way_device_session";
export const USER_SESSION_COOKIE = "way_user_session";

// Phones and dashboard sessions both stay logged in for 30 days by
// default -- no re-login flow exists on the device side, and dashboard
// convenience matters more than session hygiene at household scale.
// Adjust independently here if you ever want them to differ.
export const DEVICE_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const USER_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export {
  readCookie as getCookie,
  setCookieValue as buildSetCookie,
  clearCookieValue as buildClearCookie,
} from "../../lib/cookies";
