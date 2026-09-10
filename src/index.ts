import { error, getRole, json } from "./http";
import {
  createSupplier,
  listMaterials,
  listSuppliers,
  setBatchNumberScheme,
  upsertMaterial,
} from "./routes/masterdata";
import { listNotifications, markNotificationRead } from "./routes/notifications";
import {
  createReceipt,
  decideBatch,
  finalizeWeight,
  getReceipt,
  listReceipts,
} from "./routes/receipts";
import { runExpiryCheck } from "./scheduled";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // Master data
      if (pathname === "/api/suppliers" && method === "GET") return listSuppliers(request, env);
      if (pathname === "/api/suppliers" && method === "POST") return createSupplier(request, env);
      if (pathname === "/api/materials" && method === "GET") return listMaterials(request, env);
      if (pathname === "/api/materials" && method === "PUT") return upsertMaterial(request, env);
      if (pathname === "/api/batch-number-schemes" && method === "PUT") {
        return setBatchNumberScheme(request, env);
      }

      // Receipts — everything below requires an X-Role header identifying
      // the caller as warehouse or quality (stand-in for real auth).
      const role = getRole(request);

      if (pathname === "/api/receipts" && method === "POST") {
        if (role !== "warehouse") return error("Only warehouse can register receipts", 403);
        return createReceipt(request, env);
      }
      if (pathname === "/api/receipts" && method === "GET") {
        if (!role) return error("Missing X-Role header", 401);
        return listReceipts(request, env, role);
      }

      const receiptMatch = pathname.match(/^\/api\/receipts\/(\d+)$/);
      if (receiptMatch && method === "GET") {
        if (!role) return error("Missing X-Role header", 401);
        return getReceipt(env, role, Number(receiptMatch[1]));
      }

      const decisionMatch = pathname.match(/^\/api\/batches\/(\d+)\/decision$/);
      if (decisionMatch && method === "POST") {
        if (role !== "quality") return error("Only quality can decide on a batch", 403);
        return decideBatch(request, env, Number(decisionMatch[1]));
      }

      const finalizeMatch = pathname.match(/^\/api\/batches\/(\d+)\/finalize-weight$/);
      if (finalizeMatch && method === "POST") {
        if (role !== "warehouse") return error("Only warehouse finalizes actual weight", 403);
        return finalizeWeight(request, env, Number(finalizeMatch[1]));
      }

      // Notifications
      if (pathname === "/api/notifications" && method === "GET") {
        if (!role) return error("Missing X-Role header", 401);
        return listNotifications(request, env, role);
      }
      const notifReadMatch = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
      if (notifReadMatch && method === "POST") {
        return markNotificationRead(env, Number(notifReadMatch[1]));
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await runExpiryCheck(env);
  },
};
