import { buildPushPayload, type PushMessage, type PushSubscription, type VapidKeys } from "@block65/webcrypto-web-push";
import { error, json } from "./http";
import type { Env, Role } from "./types";

interface SubscribeInput {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

export async function subscribeToPush(request: Request, env: Env, role: Role): Promise<Response> {
  const input = await request.json<SubscribeInput>().catch(() => ({}) as SubscribeInput);
  const endpoint = input.endpoint ?? "";
  const p256dh = input.keys?.p256dh ?? "";
  const auth = input.keys?.auth ?? "";
  if (!endpoint || !p256dh || !auth) return error("Invalid subscription", 400);

  await env.DB.prepare(
    `INSERT INTO push_subscriptions (role, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET role = excluded.role, p256dh = excluded.p256dh, auth = excluded.auth`
  )
    .bind(role, endpoint, p256dh, auth)
    .run();

  return json({ ok: true });
}

export async function unsubscribeFromPush(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{ endpoint?: string }>().catch(() => ({}) as { endpoint?: string });
  if (!input.endpoint) return error("Missing endpoint", 400);
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(input.endpoint).run();
  return json({ ok: true });
}

export function getVapidPublicKey(env: Env): Response {
  if (!env.VAPID_PUBLIC_KEY) return json({ key: null });
  return json({ key: env.VAPID_PUBLIC_KEY });
}

interface PushPayload {
  title: string;
  body: string;
  kind: string;
  receiptId?: number | null;
}

/** Best-effort fan-out to every device subscribed for a role. Never throws —
 *  a push-service failure (expired subscription, network hiccup) must not
 *  break the caller's own request (e.g. registering a receipt). A 404/410
 *  from the push service means the subscription is dead, so it's deleted. */
export async function sendPushToRole(env: Env, role: Role, payload: PushPayload): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return;

  const vapid: VapidKeys = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  const rows = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE role = ?")
    .bind(role)
    .all<{ endpoint: string; p256dh: string; auth: string }>();

  const subscriptions = rows.results ?? [];
  if (!subscriptions.length) return;

  const message: PushMessage = { data: { ...payload }, options: { ttl: 60 * 60, urgency: "high" } };

  await Promise.all(
    subscriptions.map(async (sub) => {
      const subscription: PushSubscription = {
        endpoint: sub.endpoint,
        expirationTime: null,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      };
      try {
        const pushPayload = await buildPushPayload(message, subscription, vapid);
        const res = await fetch(subscription.endpoint, pushPayload);
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(sub.endpoint).run();
        }
      } catch {
        // Best-effort — one dead/misbehaving subscription shouldn't stop the rest.
      }
    })
  );
}
