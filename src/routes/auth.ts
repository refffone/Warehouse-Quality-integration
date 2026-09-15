import {
  checkNotLocked,
  clearFailedAttempts,
  clearSessionCookieHeader,
  createSession,
  destroySession,
  getSession,
  getSessionToken,
  recordFailedAttempt,
  sessionCookieHeader,
  verifyPassword,
} from "../auth";
import { error, json } from "../http";
import type { Env, Role } from "../types";

interface UserRow {
  id: number;
  password_hash: string;
  password_salt: string;
  role: Role;
  display_name: string;
  active: number;
}

export async function login(request: Request, env: Env): Promise<Response> {
  const input = await request
    .json<{ username?: string; password?: string; role?: string }>()
    .catch(() => ({}) as { username?: string; password?: string; role?: string });
  const username = (input.username ?? "").trim();
  const password = input.password ?? "";
  const role = input.role;
  if (role !== "warehouse" && role !== "quality") return error("Invalid portal", 400);
  if (!username || !password) return error("Username and password are required", 400);

  // Keyed by username (not IP) — a handful of known accounts, so the
  // threat this guards against is someone repeatedly guessing one
  // person's password, not a broad distributed attack.
  const lockKey = `portal:${username.toLowerCase()}`;
  const lockStatus = await checkNotLocked(env, lockKey);
  if (lockStatus.locked) {
    const minutes = Math.ceil((lockStatus.retryAfterSeconds ?? 0) / 60);
    return error(`Too many failed attempts — try again in ${minutes} minute(s)`, 429);
  }

  const user = await env.DB.prepare(
    "SELECT id, password_hash, password_salt, role, display_name, active FROM users WHERE username = ?"
  )
    .bind(username)
    .first<UserRow>();

  // Same generic message whether the username doesn't exist, the password
  // is wrong, the account is deactivated, or it belongs to the other
  // portal — never confirm which, so a guesser learns nothing.
  const genericError = "Invalid username or password";
  if (!user || !user.active || user.role !== role) {
    await recordFailedAttempt(env, lockKey);
    return error(genericError, 401);
  }
  const ok = await verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) {
    await recordFailedAttempt(env, lockKey);
    return error(genericError, 401);
  }
  await clearFailedAttempts(env, lockKey);

  const { token, maxAge } = await createSession(env, user.id, user.role);
  const res = json({ role: user.role, name: user.display_name });
  res.headers.append("Set-Cookie", sessionCookieHeader(token, maxAge));
  return res;
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const token = getSessionToken(request);
  if (token) await destroySession(env, token);
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", clearSessionCookieHeader());
  return res;
}

export async function me(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return error("Not signed in", 401);
  return json({ role: session.role, name: session.displayName });
}
