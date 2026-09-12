import { getSession } from "./auth";
import { error, json } from "./http";
import {
  adminCreateUser,
  adminGetBranding,
  adminGetStatus,
  adminListUsers,
  adminPage,
  adminResetPassword,
  adminSetBranding,
  adminSetStatus,
  adminSetUserActive,
  getServiceStatus,
  suspendedResponse,
} from "./routes/admin";
import { login, logout, me } from "./routes/auth";
import { landingPage, loginPage, requireAppSession } from "./routes/pages";
import {
  createSupplier,
  getMaterialDossier,
  getSupplierAssessment,
  getSupplierWeightAssessment,
  importMaterials,
  importSuppliers,
  listImportCodeSchemes,
  listMaterialFunctions,
  listMaterials,
  listMaterialSubtypes,
  listMaterialTypes,
  listSuppliers,
  materialsImportTemplate,
  setBatchNumberScheme,
  setImportCodeScheme,
  suppliersImportTemplate,
  upsertMaterial,
  upsertMaterialFunction,
  upsertMaterialSubtype,
  upsertMaterialType,
} from "./routes/masterdata";
import {
  deleteAttachment,
  downloadAttachment,
  listAttachmentsForLine,
  uploadAttachment,
} from "./routes/attachments";
import { downloadCoa } from "./routes/coa";
import { listNotifications, markNotificationRead } from "./routes/notifications";
import { getVapidPublicKey, subscribeToPush, unsubscribeFromPush } from "./push";
import {
  associateCode,
  createReceipt,
  decideBatch,
  finalizeWeight,
  getReceipt,
  getTodoCount,
  listReceipts,
  listReceiptsDetailed,
  recordTestResults,
  setSampleSender,
} from "./routes/receipts";
import {
  exportCodeSpec,
  exportCodesList,
  exportHistory,
  exportMasterData,
  exportReceivedLog,
  exportSuppliersList,
  exportTodos,
} from "./routes/reports";
import {
  createSpec,
  getSubtypeSpecTemplate,
  importSpecs,
  listSpecs,
  setSubtypeSpecTemplate,
  specsImportTemplate,
} from "./routes/specs";
import { runExpiryCheck } from "./scheduled";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // Admin panel — a real credential (ADMIN_PASSWORD), not a session,
      // and the one thing that must keep working even while the service
      // is suspended (the owner still needs to be able to turn it back
      // on). Everything else checks the kill switch first.
      if (pathname === "/admin" && method === "GET") return adminPage(request, env);
      if (pathname === "/admin/api/status" && method === "GET") return adminGetStatus(request, env);
      if (pathname === "/admin/api/status" && method === "POST") return adminSetStatus(request, env);
      if (pathname === "/admin/api/branding" && method === "GET") return adminGetBranding(request, env);
      if (pathname === "/admin/api/branding" && method === "POST") return adminSetBranding(request, env);
      if (pathname === "/admin/api/users" && method === "GET") return adminListUsers(request, env);
      if (pathname === "/admin/api/users" && method === "POST") return adminCreateUser(request, env);
      const adminUserPasswordMatch = pathname.match(/^\/admin\/api\/users\/(\d+)\/password$/);
      if (adminUserPasswordMatch && method === "POST") {
        return adminResetPassword(request, env, Number(adminUserPasswordMatch[1]));
      }
      const adminUserActiveMatch = pathname.match(/^\/admin\/api\/users\/(\d+)\/(deactivate|reactivate)$/);
      if (adminUserActiveMatch && method === "POST") {
        return adminSetUserActive(request, env, Number(adminUserActiveMatch[1]), adminUserActiveMatch[2] === "reactivate");
      }

      if ((await getServiceStatus(env)) === "suspended") {
        return suspendedResponse(pathname);
      }

      // Entry pages — landing (pick a portal), the two role-locked logins,
      // and the auth API behind them. The SPA itself lives at /app and
      // requires a valid session; everything before this point is public.
      if (pathname === "/" && method === "GET") return landingPage();
      if (pathname === "/login/warehouse" && method === "GET") return loginPage("warehouse");
      if (pathname === "/login/quality" && method === "GET") return loginPage("quality");
      if (pathname === "/app" && method === "GET") {
        const guard = await requireAppSession(request, env);
        if (guard) return guard;
        return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
      }
      if (pathname === "/api/auth/login" && method === "POST") return login(request, env);
      if (pathname === "/api/auth/logout" && method === "POST") return logout(request, env);
      if (pathname === "/api/auth/me" && method === "GET") return me(request, env);

      const session = await getSession(request, env);
      const role = session?.role ?? null;

      // Master data — Warehouse's only legitimate reason to touch this
      // section is picking/adding a supplier while receiving; everything
      // else here (codes, types, subtypes, functions, specs, schemes) is
      // Quality's catalog and Warehouse's own screens never call it, so
      // it's read *and* write, Quality-only.
      if (pathname === "/api/suppliers" && method === "GET") {
        if (!role) return error("Not signed in", 401);
        return listSuppliers(request, env);
      }
      if (pathname === "/api/suppliers" && method === "POST") {
        if (!role) return error("Not signed in", 401);
        return createSupplier(request, env);
      }
      if (pathname === "/api/suppliers/import-template" && method === "GET") {
        if (!role) return error("Not signed in", 401);
        return suppliersImportTemplate(env);
      }
      if (pathname === "/api/suppliers/import" && method === "POST") {
        if (!role) return error("Not signed in", 401);
        return importSuppliers(request, env, url.searchParams.get("commit") === "true");
      }
      if (pathname === "/api/materials" && method === "GET") {
        if (role !== "quality") return error("Material codes are a quality-only view", 403);
        return listMaterials(request, env);
      }
      if (pathname === "/api/materials" && method === "PUT") {
        if (role !== "quality") return error("Only quality can create/edit material codes", 403);
        return upsertMaterial(request, env);
      }
      if (pathname === "/api/materials/import-template" && method === "GET") {
        if (role !== "quality") return error("Material codes are a quality-only view", 403);
        return materialsImportTemplate(env);
      }
      if (pathname === "/api/materials/import" && method === "POST") {
        if (role !== "quality") return error("Only quality can create/edit material codes", 403);
        return importMaterials(request, env, url.searchParams.get("commit") === "true");
      }
      if (pathname === "/api/material-types" && method === "GET") {
        if (role !== "quality") return error("Material types are a quality-only view", 403);
        return listMaterialTypes(request, env);
      }
      if (pathname === "/api/material-types" && method === "PUT") {
        if (role !== "quality") return error("Only quality can manage material types", 403);
        return upsertMaterialType(request, env);
      }
      if (pathname === "/api/material-subtypes" && method === "GET") {
        if (role !== "quality") return error("Material subtypes are a quality-only view", 403);
        return listMaterialSubtypes(request, env);
      }
      if (pathname === "/api/material-functions" && method === "GET") {
        if (role !== "quality") return error("Material functions are a quality-only view", 403);
        return listMaterialFunctions(request, env);
      }
      if (pathname === "/api/material-functions" && method === "PUT") {
        if (role !== "quality") return error("Only quality can manage material functions", 403);
        return upsertMaterialFunction(request, env);
      }
      if (pathname === "/api/material-subtypes" && method === "PUT") {
        if (role !== "quality") return error("Only quality can manage material subtypes", 403);
        return upsertMaterialSubtype(request, env);
      }
      if (pathname === "/api/batch-number-schemes" && method === "PUT") {
        if (role !== "quality") return error("Only quality can configure batch-number schemes", 403);
        return setBatchNumberScheme(request, env);
      }
      if (pathname === "/api/import-code-schemes" && method === "GET") {
        if (role !== "quality") return error("Import-code schemes are a quality-only view", 403);
        return listImportCodeSchemes(request, env);
      }
      const importSchemeMatch = pathname.match(/^\/api\/import-code-schemes\/(RMF|RMS)$/);
      if (importSchemeMatch && method === "PUT") {
        if (role !== "quality") return error("Only quality can configure the import-code schemes", 403);
        return setImportCodeScheme(request, env, importSchemeMatch[1]);
      }

      // Specifications — Quality's second core function.
      const subtypeTemplateMatch = pathname.match(/^\/api\/material-subtypes\/([^/]+)\/spec-template$/);
      if (subtypeTemplateMatch && method === "GET") {
        if (role !== "quality") return error("Spec templates are a quality-only view", 403);
        return getSubtypeSpecTemplate(env, decodeURIComponent(subtypeTemplateMatch[1]));
      }
      if (subtypeTemplateMatch && method === "PUT") {
        if (role !== "quality") return error("Only quality can manage spec templates", 403);
        return setSubtypeSpecTemplate(request, env, decodeURIComponent(subtypeTemplateMatch[1]));
      }

      const materialSpecsMatch = pathname.match(/^\/api\/materials\/([^/]+)\/specs$/);
      if (materialSpecsMatch && method === "GET") {
        if (role !== "quality") return error("Specifications are a quality-only view", 403);
        return listSpecs(env, decodeURIComponent(materialSpecsMatch[1]));
      }
      if (materialSpecsMatch && method === "POST") {
        if (role !== "quality") return error("Only quality can create specifications", 403);
        return createSpec(request, env, decodeURIComponent(materialSpecsMatch[1]));
      }
      if (pathname === "/api/specs/import-template" && method === "GET") {
        if (role !== "quality") return error("Specifications are a quality-only view", 403);
        return specsImportTemplate(env);
      }
      if (pathname === "/api/specs/import" && method === "POST") {
        if (role !== "quality") return error("Only quality can create specifications", 403);
        return importSpecs(request, env, url.searchParams.get("commit") === "true");
      }

      // Master Data dossier — Quality-only aggregate view of a material code.
      const dossierMatch = pathname.match(/^\/api\/materials\/([^/]+)\/dossier$/);
      if (dossierMatch && method === "GET") {
        if (role !== "quality") return error("Master Data is a quality-only view", 403);
        return getMaterialDossier(env, decodeURIComponent(dossierMatch[1]));
      }

      // Master Data — Suppliers subtab: performance assessment per supplier.
      const supplierAssessmentMatch = pathname.match(/^\/api\/suppliers\/([^/]+)\/assessment$/);
      if (supplierAssessmentMatch && method === "GET") {
        if (role !== "quality") return error("Master Data is a quality-only view", 403);
        return getSupplierAssessment(env, decodeURIComponent(supplierAssessmentMatch[1]));
      }

      // Warehouse's own supplier scorecard: as-received vs actually-weighed
      // quantity — a different question from Quality's pass/fail assessment
      // above, so it's a separate tab and a separate warehouse-only route.
      const weightAssessmentMatch = pathname.match(/^\/api\/suppliers\/([^/]+)\/weight-assessment$/);
      if (weightAssessmentMatch && method === "GET") {
        if (role !== "warehouse") return error("Only warehouse can view this assessment", 403);
        return getSupplierWeightAssessment(env, decodeURIComponent(weightAssessmentMatch[1]));
      }

      // Attachments (photo/TDS/MSDS) per import code — Quality-only, like the dossier.
      const lineAttachmentsMatch = pathname.match(/^\/api\/receipt-lines\/(\d+)\/attachments$/);
      if (lineAttachmentsMatch && method === "POST") {
        if (role !== "quality") return error("Only quality can attach files", 403);
        return uploadAttachment(request, env, Number(lineAttachmentsMatch[1]));
      }
      if (lineAttachmentsMatch && method === "GET") {
        if (role !== "quality") return error("Only quality can view attachments", 403);
        return listAttachmentsForLine(env, Number(lineAttachmentsMatch[1]));
      }
      const attachmentDownloadMatch = pathname.match(/^\/api\/attachments\/(\d+)\/download$/);
      if (attachmentDownloadMatch && method === "GET") {
        if (role !== "quality") return error("Only quality can download attachments", 403);
        return downloadAttachment(env, Number(attachmentDownloadMatch[1]));
      }
      const attachmentMatch = pathname.match(/^\/api\/attachments\/(\d+)$/);
      if (attachmentMatch && method === "DELETE") {
        if (role !== "quality") return error("Only quality can remove attachments", 403);
        return deleteAttachment(env, Number(attachmentMatch[1]));
      }

      // Receipts — everything below requires an X-Role header identifying
      // the caller as warehouse or quality (stand-in for real auth).
      if (pathname === "/api/receipts" && method === "POST") {
        if (role !== "warehouse") return error("Only warehouse can register receipts", 403);
        return createReceipt(request, env);
      }
      if (pathname === "/api/receipts" && method === "GET") {
        if (!role) return error("Not signed in", 401);
        return listReceipts(request, env, role);
      }
      if (pathname === "/api/receipts/detailed" && method === "GET") {
        if (!role) return error("Not signed in", 401);
        return listReceiptsDetailed(request, env, role);
      }
      if (pathname === "/api/receipts/todo-count" && method === "GET") {
        if (!role) return error("Not signed in", 401);
        return getTodoCount(env, role);
      }

      const receiptMatch = pathname.match(/^\/api\/receipts\/(\d+)$/);
      if (receiptMatch && method === "GET") {
        if (!role) return error("Not signed in", 401);
        return getReceipt(env, role, Number(receiptMatch[1]));
      }

      const sampleSenderMatch = pathname.match(/^\/api\/receipts\/(\d+)\/sample-sender$/);
      if (sampleSenderMatch && method === "PATCH") {
        if (!role) return error("Not signed in", 401);
        return setSampleSender(request, env, role, Number(sampleSenderMatch[1]));
      }

      // Test Incomings — Quality's third core function.
      const testResultsMatch = pathname.match(/^\/api\/batches\/(\d+)\/test-results$/);
      if (testResultsMatch && method === "POST") {
        if (role !== "quality") return error("Only quality can record test results", 403);
        return recordTestResults(request, env, Number(testResultsMatch[1]));
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

      const associateMatch = pathname.match(/^\/api\/receipt-lines\/(\d+)\/associate-code$/);
      if (associateMatch && method === "POST") {
        if (role !== "quality") return error("Only quality can associate a code", 403);
        return associateCode(request, env, Number(associateMatch[1]));
      }

      const coaMatch = pathname.match(/^\/api\/batches\/(\d+)\/coa$/);
      if (coaMatch && method === "GET") {
        if (role !== "quality") return error("Only quality can export a COA", 403);
        return downloadCoa(env, Number(coaMatch[1]), url.searchParams.get("format") ?? "pdf");
      }

      // Reports — export as PDF/Excel, branded from Admin panel settings.
      if (pathname === "/api/reports/received-log" && method === "GET") {
        if (role !== "warehouse") return error("Only warehouse can export the received log", 403);
        return exportReceivedLog(request, env);
      }
      if (pathname === "/api/reports/todos" && method === "GET") {
        if (role !== "quality") return error("Only quality can export this report", 403);
        return exportTodos(request, env);
      }
      if (pathname === "/api/reports/history" && method === "GET") {
        if (role !== "quality") return error("Only quality can export this report", 403);
        return exportHistory(request, env);
      }
      const reportSpecMatch = pathname.match(/^\/api\/reports\/spec\/([^/]+)$/);
      if (reportSpecMatch && method === "GET") {
        if (role !== "quality") return error("Only quality can export this report", 403);
        return exportCodeSpec(request, env, decodeURIComponent(reportSpecMatch[1]));
      }
      const reportMasterDataMatch = pathname.match(/^\/api\/reports\/master-data\/([^/]+)$/);
      if (reportMasterDataMatch && method === "GET") {
        if (role !== "quality") return error("Only quality can export this report", 403);
        return exportMasterData(request, env, decodeURIComponent(reportMasterDataMatch[1]));
      }
      if (pathname === "/api/reports/suppliers" && method === "GET") {
        // Unlike the other reports here, this one backs the plain Suppliers
        // list tab both roles now have, not a quality-only screen — the
        // underlying supplier directory (GET /api/suppliers) was already
        // open to both.
        if (!role) return error("Not signed in", 401);
        return exportSuppliersList(request, env);
      }
      if (pathname === "/api/reports/codes" && method === "GET") {
        if (role !== "quality") return error("Only quality can export this report", 403);
        return exportCodesList(request, env);
      }

      // Notifications
      if (pathname === "/api/notifications" && method === "GET") {
        if (!role) return error("Not signed in", 401);
        return listNotifications(request, env, role);
      }
      const notifReadMatch = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
      if (notifReadMatch && method === "POST") {
        if (!role) return error("Not signed in", 401);
        return markNotificationRead(env, role, Number(notifReadMatch[1]));
      }

      // Web Push
      if (pathname === "/api/push/vapid-public-key" && method === "GET") {
        return getVapidPublicKey(env);
      }
      if (pathname === "/api/push/subscribe" && method === "POST") {
        if (!role) return error("Not signed in", 401);
        return subscribeToPush(request, env, role);
      }
      if (pathname === "/api/push/unsubscribe" && method === "POST") {
        if (!role) return error("Not signed in", 401);
        return unsubscribeFromPush(request, env);
      }

      if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Internal error" }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await runExpiryCheck(env);
  },
};
