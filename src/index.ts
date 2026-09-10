import { error, getRole, json } from "./http";
import {
  createSupplier,
  listMaterials,
  listMaterialSubtypes,
  listMaterialTypes,
  listSuppliers,
  setBatchNumberScheme,
  upsertMaterial,
  upsertMaterialSubtype,
  upsertMaterialType,
} from "./routes/masterdata";
import { listNotifications, markNotificationRead } from "./routes/notifications";
import {
  associateCode,
  createReceipt,
  decideBatch,
  finalizeWeight,
  getReceipt,
  listReceipts,
} from "./routes/receipts";
import { createSpec, getSubtypeSpecTemplate, listSpecs, setSubtypeSpecTemplate } from "./routes/specs";
import { runExpiryCheck } from "./scheduled";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const role = getRole(request);

    try {
      // Master data — read is open to both roles; Quality owns writes
      // ("Create Codes" is one of Quality's three core functions).
      if (pathname === "/api/suppliers" && method === "GET") return listSuppliers(request, env);
      if (pathname === "/api/suppliers" && method === "POST") return createSupplier(request, env);
      if (pathname === "/api/materials" && method === "GET") return listMaterials(request, env);
      if (pathname === "/api/materials" && method === "PUT") {
        if (role !== "quality") return error("Only quality can create/edit material codes", 403);
        return upsertMaterial(request, env);
      }
      if (pathname === "/api/material-types" && method === "GET") return listMaterialTypes(request, env);
      if (pathname === "/api/material-types" && method === "PUT") {
        if (role !== "quality") return error("Only quality can manage material types", 403);
        return upsertMaterialType(request, env);
      }
      if (pathname === "/api/material-subtypes" && method === "GET") {
        return listMaterialSubtypes(request, env);
      }
      if (pathname === "/api/material-subtypes" && method === "PUT") {
        if (role !== "quality") return error("Only quality can manage material subtypes", 403);
        return upsertMaterialSubtype(request, env);
      }
      if (pathname === "/api/batch-number-schemes" && method === "PUT") {
        if (role !== "quality") return error("Only quality can configure batch-number schemes", 403);
        return setBatchNumberScheme(request, env);
      }

      // Specifications — Quality's second core function.
      const subtypeTemplateMatch = pathname.match(/^\/api\/material-subtypes\/([^/]+)\/spec-template$/);
      if (subtypeTemplateMatch && method === "GET") {
        return getSubtypeSpecTemplate(env, decodeURIComponent(subtypeTemplateMatch[1]));
      }
      if (subtypeTemplateMatch && method === "PUT") {
        if (role !== "quality") return error("Only quality can manage spec templates", 403);
        return setSubtypeSpecTemplate(request, env, decodeURIComponent(subtypeTemplateMatch[1]));
      }

      const materialSpecsMatch = pathname.match(/^\/api\/materials\/([^/]+)\/specs$/);
      if (materialSpecsMatch && method === "GET") {
        return listSpecs(env, decodeURIComponent(materialSpecsMatch[1]));
      }
      if (materialSpecsMatch && method === "POST") {
        if (role !== "quality") return error("Only quality can create specifications", 403);
        return createSpec(request, env, decodeURIComponent(materialSpecsMatch[1]));
      }

      // Receipts — everything below requires an X-Role header identifying
      // the caller as warehouse or quality (stand-in for real auth).
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

      // Test Incomings — Quality's third core function.
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

      const associateMatch = pathname.match(/^\/api\/receipt-lines\/(\d+)\/associate-code$/);
      if (associateMatch && method === "POST") {
        if (role !== "quality") return error("Only quality can associate a code", 403);
        return associateCode(request, env, Number(associateMatch[1]));
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
