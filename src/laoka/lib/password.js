// Password hashing that fits the Workers free plan.
//
// Measured on this machine, PBKDF2-SHA256 costs about 8 ms at 10,000
// iterations, and the free plan allows 10 ms of CPU for an entire request.
// A conventional iteration count is therefore impossible here, so the password
// is first put through an HMAC with a server side pepper. The pepper lives in
// the Worker secret, never in the database, so a stolen database is useless
// without it and the iteration count is no longer the only thing standing in
// the way. A handful of iterations then only has to cover online guessing,
// which the attempt limiter also throttles.
//
// On the Workers Paid plan, raise PBKDF2_ITERATIONS. Nothing else needs to
// change: each row records the count it was hashed with.

const encoder = new TextEncoder();

export const DEFAULT_ITERATIONS = 5000;
export const MIN_PEPPER_LENGTH = 16;

export function iterationsFor(env) {
  const raw = Number(env.PBKDF2_ITERATIONS || 0);
  if (!Number.isFinite(raw) || raw < 1000) return DEFAULT_ITERATIONS;
  return Math.min(Math.trunc(raw), 1000000);
}

export function pepperConfigured(env) {
  return String(env.AUTH_PEPPER || '').length >= MIN_PEPPER_LENGTH;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pepperKey(env) {
  const pepper = String(env.AUTH_PEPPER || '');
  if (pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error('AUTH_PEPPER must be set to at least ' + MIN_PEPPER_LENGTH + ' characters');
  }
  return crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export function newSalt() {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function hashPassword(password, env, saltBase64, iterations) {
  const key = await pepperKey(env);
  const peppered = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(String(password))));
  const salt = saltBase64 ? fromBase64(saltBase64) : fromBase64(newSalt());
  const rounds = iterations || iterationsFor(env);
  const base = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt, iterations: rounds, hash: 'SHA-256' },
    base,
    256
  );
  return { hash: toBase64(new Uint8Array(bits)), salt: toBase64(salt), iterations: rounds };
}

// Constant time comparison, so a near miss cannot be timed.
function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, user, env) {
  if (!user || !user.password_hash || !user.password_salt) return false;
  const attempt = await hashPassword(password, env, user.password_salt, user.password_iterations || DEFAULT_ITERATIONS);
  return sameString(attempt.hash, user.password_hash);
}

export function validUsername(name) {
  return /^[A-Za-z0-9._-]{3,24}$/.test(String(name || ''));
}

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomInviteCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}
