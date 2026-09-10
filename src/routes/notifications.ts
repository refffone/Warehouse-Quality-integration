import { json } from "../http";
import type { Env, Role } from "../types";

export async function listNotifications(request: Request, env: Env, role: Role): Promise<Response> {
  const url = new URL(request.url);
  const unreadOnly = url.searchParams.get("unread") === "true";

  const rows = await env.DB.prepare(
    `SELECT * FROM notification_events
     WHERE target_role = ? ${unreadOnly ? "AND read_at IS NULL" : ""}
     ORDER BY created_at DESC
     LIMIT 100`
  )
    .bind(role)
    .all();

  return json(rows.results ?? []);
}

export async function markNotificationRead(env: Env, id: number): Promise<Response> {
  await env.DB.prepare("UPDATE notification_events SET read_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(id)
    .run();
  return json({ id, read: true });
}
