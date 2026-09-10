import { error, json } from "../http";
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

export async function markNotificationRead(env: Env, role: Role, id: number): Promise<Response> {
  const notification = await env.DB.prepare("SELECT target_role FROM notification_events WHERE id = ?")
    .bind(id)
    .first<{ target_role: string }>();
  if (!notification) return error("Notification not found", 404);
  if (notification.target_role !== role) {
    return error("You can only mark your own notifications as read", 403);
  }

  await env.DB.prepare("UPDATE notification_events SET read_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(id)
    .run();
  return json({ id, read: true });
}
