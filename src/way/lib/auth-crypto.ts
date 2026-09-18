// auth-crypto.ts
// Two independent pieces, both built on Web Crypto (available natively
// in the Workers runtime, no dependency needed):
//   1. Password hashing/verification (PBKDF2-SHA256) -- used for user
//      accounts (users.password_hash). One account == one device, so the
//      same hash serves both dashboard login and μlogger upload auth.
//   2. Signed, stateless tokens (HMAC-SHA256) -- used as session cookies.
//      "Stateless" means no server-side session table: the token itself
//      carries its payload + an expiry, and a valid signature is proof
//      it hasn't been tampered with. Cheaper and simpler than a D1-backed
//      sessions table at this scale.

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// ============================================================
//  Password hashing
//  Stored format: "<saltHex>:<hashHex>" -- self-contained, no separate
//  salt column needed.
// ============================================================
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial, 256
  );
  return `${toHex(salt)}:${toHex(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial, 256
  );
  return toHex(bits) === hashHex;
}

// ============================================================
//  Signed tokens (session cookies)
// ============================================================
function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): Uint8Array {
  const str = atob(input.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

/** payload must include `exp` (unix seconds) -- checked on verify. */
export async function signToken(
  payload: Record<string, string | number>,
  secret: string
): Promise<string> {
  const payloadB64 = base64url(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${base64url(sig)}`;
}

/** Returns null on bad signature, malformed token, or expiry in the past.
 * Never throws -- any malformed input (bad base64, wrong shape, whatever
 * a misbehaving client sends) is treated as "not a valid session," not
 * a server error. */
export async function verifyToken<T = Record<string, unknown>>(
  token: string,
  secret: string
): Promise<(T & { exp: number }) | null> {
  try {
    const [payloadB64, sigB64] = token.split(".");
    if (!payloadB64 || !sigB64) return null;

    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC", key, base64urlDecode(sigB64), new TextEncoder().encode(payloadB64)
    );
    if (!valid) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(payloadB64))
    ) as T & { exp: number };
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
