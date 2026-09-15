import { error, json } from "../http";
import type { Env } from "../types";

/** Columns never included in a backup dump, even though they live in an
 *  otherwise-included table — credentials and push encryption keys have
 *  no business leaving the database, backup or not. */
const REDACTED_COLUMNS: Record<string, string[]> = {
  users: ["password_hash", "password_salt"],
  sessions: ["token"],
  push_subscriptions: ["p256dh", "auth"],
  login_attempts: [], // no secrets, but listed for visibility when this map is next edited
};

function redactRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const dropped = REDACTED_COLUMNS[table];
  if (!dropped?.length) return row;
  const copy = { ...row };
  for (const col of dropped) delete copy[col];
  return copy;
}

/** A full, generic export of every real table — used by the nightly
 *  GitHub Actions backup job (see .github/workflows/backup.yml) as a
 *  second, independent copy of the data alongside Cloudflare D1's own
 *  30-day point-in-time recovery. Protected by a dedicated BACKUP_TOKEN
 *  (a bearer token, separate from ADMIN_PASSWORD) so a leaked CI secret
 *  can only ever read a data dump, never reach the admin panel. */
export async function exportBackup(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  if (!token || !env.BACKUP_TOKEN || token !== env.BACKUP_TOKEN) {
    return error("Not authorized", 401);
  }

  const tableRows = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`
  ).all<{ name: string }>();
  const tables = (tableRows.results ?? []).map((r) => r.name);

  const dump: Record<string, unknown[]> = {};
  for (const table of tables) {
    // Table names come from sqlite_master, never from request input — not
    // user-controlled, so this interpolation isn't an injection risk.
    const rows = await env.DB.prepare(`SELECT * FROM "${table}"`).all<Record<string, unknown>>();
    dump[table] = (rows.results ?? []).map((row) => redactRow(table, row));
  }

  return json({ exported_at: new Date().toISOString(), tables: dump });
}
