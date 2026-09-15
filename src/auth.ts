import type { Env, Role } from "./types";

// ---------------------------------------------------------------- passwords
//
// PBKDF2-SHA256 via Web Crypto (available in Workers) — no bcrypt/argon2
// package needed. Salted per-user, 100k iterations.

const PBKDF2_ITERATIONS = 100_000;

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, saltBytes: Uint8Array): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(bits);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToHex(saltBytes);
  const hash = await derive(password, saltBytes);
  return { hash, salt };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  const actual = await derive(password, hexToBytes(salt));
  return timingSafeEqual(actual, expectedHash);
}

// ---------------------------------------------------------------- login rate limiting

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface LockStatus {
  locked: boolean;
  retryAfterSeconds?: number;
}

/** Checks (without recording anything) whether `key` is currently locked
 *  out from too many recent failed attempts. */
export async function checkNotLocked(env: Env, key: string): Promise<LockStatus> {
  const row = await env.DB.prepare("SELECT locked_until FROM login_attempts WHERE key = ?")
    .bind(key)
    .first<{ locked_until: string | null }>();
  if (!row?.locked_until) return { locked: false };
  const lockedUntilMs = new Date(row.locked_until).getTime();
  const remainingMs = lockedUntilMs - Date.now();
  if (remainingMs > 0) return { locked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
  return { locked: false };
}

/** Records one failed attempt for `key`, locking it out once
 *  MAX_FAILED_ATTEMPTS is reached. */
export async function recordFailedAttempt(env: Env, key: string): Promise<void> {
  const row = await env.DB.prepare("SELECT failed_count FROM login_attempts WHERE key = ?")
    .bind(key)
    .first<{ failed_count: number }>();
  const failedCount = (row?.failed_count ?? 0) + 1;
  const lockedUntil =
    failedCount >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO login_attempts (key, failed_count, locked_until, last_attempt_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET failed_count = excluded.failed_count, locked_until = excluded.locked_until, last_attempt_at = CURRENT_TIMESTAMP`
  )
    .bind(key, failedCount, lockedUntil)
    .run();
}

/** Clears any tracked failures for `key` — called after a successful login
 *  so a real account holder isn't stuck behind an old lockout window. */
export async function clearFailedAttempts(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}

// ---------------------------------------------------------------- sessions

const SESSION_COOKIE = "wq_session";
const SESSION_LIFETIME_SECONDS = 12 * 60 * 60; // 12 hours

export interface Session {
  role: Role;
  userId: number;
  displayName: string;
}

function newToken(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createSession(
  env: Env,
  userId: number,
  role: Role
): Promise<{ token: string; maxAge: number }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, role, expires_at) VALUES (?, ?, ?, ?)")
    .bind(token, userId, role, expiresAt)
    .run();
  return { token, maxAge: SESSION_LIFETIME_SECONDS };
}

export async function destroySession(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export function sessionCookieHeader(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function getSessionToken(request: Request): string | null {
  return readCookie(request, SESSION_COOKIE);
}

/** The real source of truth for "who is this request" — replaces the old
 *  client-set X-Role header. Looks up the session token's cookie against
 *  the sessions table (joined to the still-active user), so a logged-out,
 *  expired, or deactivated account can never act. */
export async function getSession(request: Request, env: Env): Promise<Session | null> {
  const token = getSessionToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    // expires_at is stored as an ISO-8601 string (toISOString, with a "T"
    // and milliseconds); datetime('now') returns SQLite's own space-
    // separated format. Plain string comparison between the two is
    // unreliable — "T" (0x54) sorts after a space (0x20), so a same-day
    // expiry can compare as "still valid" hours after it actually passed.
    // Wrapping both sides in datetime() normalizes to the same format.
    `SELECT s.role AS role, u.id AS user_id, u.display_name AS display_name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND u.active = 1`
  )
    .bind(token)
    .first<{ role: Role; user_id: number; display_name: string }>();
  if (!row) return null;
  return { role: row.role, userId: row.user_id, displayName: row.display_name };
}
