// routes/auth.ts
// Human account auth for the dashboard. One account == one person == one
// tracked device: the username/password created here is ALSO what the
// person's μlogger app uploads with (routes/ingest.ts authenticates
// against the same users table).
//
// Signup is gated by a one-time-use, 30-minute, 6-digit invite code that
// an admin generates (routes/dashboard-api.ts). Codes live in the
// invite_codes table -- there is no longer an INVITE_CODE env secret.

import { Env } from "../types";
import { hashPassword, verifyPassword, signToken, verifyToken } from "../lib/auth-crypto";
import {
  USER_SESSION_COOKIE, USER_SESSION_TTL_SECONDS, buildSetCookie, buildClearCookie, getCookie,
} from "../lib/session";
import {
  getUserByUsername, getUserById, createUser, updateUserPassword,
  getInviteCodeByCode, markInviteCodeUsed,
} from "../db/queries";

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: true, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonSuccess(extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: false, ...extra }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface SignupBody {
  username?: string;
  password?: string;
  inviteCode?: string;
  emoji?: string;
  color?: string;
}

interface LoginBody {
  username?: string;
  password?: string;
}

interface ChangePasswordBody {
  currentPassword?: string;
  newPassword?: string;
}

interface UserSessionPayload {
  userId: number;
  username: string;
}

export async function handleAuth(request: Request, env: Env, pathname: string): Promise<Response> {
  if (pathname === "/api/auth/signup") {
    if (request.method !== "POST") return jsonError("Method not allowed", 405);
    return handleSignup(request, env);
  }
  if (pathname === "/api/auth/login") {
    if (request.method !== "POST") return jsonError("Method not allowed", 405);
    return handleLogin(request, env);
  }
  if (pathname === "/api/auth/logout") {
    if (request.method !== "POST") return jsonError("Method not allowed", 405);
    return handleLogout(request);
  }
  if (pathname === "/api/auth/password") {
    if (request.method !== "POST") return jsonError("Method not allowed", 405);
    return handleChangePassword(request, env);
  }
  return jsonError("Unknown auth action", 404);
}

async function handleSignup(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as SignupBody | null;
  if (!body?.username || !body.password || !body.inviteCode) {
    return jsonError("username, password, and inviteCode are all required");
  }

  const existing = await getUserByUsername(env.WAY_DB, body.username);
  if (existing) {
    return jsonError("Username already taken", 409);
  }

  const invite = await getInviteCodeByCode(env.WAY_DB, body.inviteCode.trim());
  if (!invite) return jsonError("Invalid invite code", 403);
  if (invite.used_by !== null) return jsonError("Invite code already used", 403);
  if (new Date(invite.expires_at).getTime() < Date.now()) return jsonError("Invite code expired", 403);

  const passwordHash = await hashPassword(body.password);
  const user = await createUser(env.WAY_DB, {
    username: body.username,
    passwordHash,
    role: "member", // admins are created/promoted directly; signup is always a member
    emoji: body.emoji ?? null,
    color: body.color ?? null,
  });
  await markInviteCodeUsed(env.WAY_DB, invite.id, user.id);

  return withSessionCookie(
    jsonSuccess({ user: publicUser(user) }),
    { userId: user.id, username: user.username },
    env,
    request
  );
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as LoginBody | null;
  if (!body?.username || !body.password) {
    return jsonError("username and password are required");
  }

  const user = await getUserByUsername(env.WAY_DB, body.username);
  if (!user || !(await verifyPassword(body.password, user.password_hash))) {
    return jsonError("Invalid username or password", 401);
  }

  return withSessionCookie(
    jsonSuccess({ user: publicUser(user) }),
    { userId: user.id, username: user.username },
    env,
    request
  );
}

async function handleChangePassword(request: Request, env: Env): Promise<Response> {
  const userId = await currentUserId(request, env);
  if (userId === null) return jsonError("Unauthorized", 401);

  const body = (await request.json().catch(() => null)) as ChangePasswordBody | null;
  if (!body?.currentPassword || !body.newPassword) {
    return jsonError("currentPassword and newPassword are required");
  }

  const user = await getUserById(env.WAY_DB, userId);
  if (!user || !(await verifyPassword(body.currentPassword, user.password_hash))) {
    return jsonError("Current password is incorrect", 401);
  }

  const newHash = await hashPassword(body.newPassword);
  await updateUserPassword(env.WAY_DB, userId, newHash);
  return jsonSuccess();
}

function handleLogout(request: Request): Response {
  const res = jsonSuccess();
  res.headers.append("Set-Cookie", buildClearCookie(USER_SESSION_COOKIE, new URL(request.url).protocol === "https:"));
  return res;
}

function publicUser(user: { id: number; username: string; emoji: string | null; color: string | null; role: string }) {
  return { id: user.id, username: user.username, emoji: user.emoji, color: user.color, role: user.role };
}

async function currentUserId(request: Request, env: Env): Promise<number | null> {
  const cookie = getCookie(request, USER_SESSION_COOKIE);
  if (!cookie) return null;
  const session = await verifyToken<UserSessionPayload>(cookie, env.SESSION_SECRET);
  return session?.userId ?? null;
}

async function withSessionCookie(
  res: Response,
  payload: { userId: number; username: string },
  env: Env,
  request: Request
): Promise<Response> {
  const token = await signToken(
    { ...payload, exp: Math.floor(Date.now() / 1000) + USER_SESSION_TTL_SECONDS },
    env.SESSION_SECRET
  );
  // Secure only when actually serving https (see buildSetCookie) -- wrangler
  // dev serves http, production serves https.
  res.headers.append("Set-Cookie", buildSetCookie(USER_SESSION_COOKIE, token, USER_SESSION_TTL_SECONDS, new URL(request.url).protocol === "https:"));
  return res;
}
