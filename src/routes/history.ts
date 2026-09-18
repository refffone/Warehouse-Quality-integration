import { json } from "../http";
import type { Env, Role } from "../types";

// History as a register: one row per decided batch, newest decision first,
// filtered the same way on screen and in the exports. Quality sees record
// codes and COAs; Warehouse sees real material codes only, its weigh-in
// figures, and nothing about a sample's decision.

const STAND_IN = "GLOB 'RM[SFP][0-9][0-9][0-9][0-9]*'";

export interface HistoryFilters {
  where: string;
  params: Array<string | number>;
}

/** The WHERE clause shared by the list, its supplier facet and the export. */
export function historyFilters(url: URL, role: Role, { skipSupplier = false } = {}): HistoryFilters {
  const get = (k: string) => (url.searchParams.get(k) ?? "").trim();
  const where: string[] = ["rb.status != 'pending'"];
  const params: Array<string | number> = [];
  if (role === "warehouse") {
    // Warehouse's History: what it received and has nothing left to do on
    // (a sample, a rejected batch, or one it has weighed).
    where.push("r.received_by = 'warehouse'");
    where.push("(r.type = 'sample' OR rb.status = 'rejected' OR rb.qty_actual_weighed IS NOT NULL)");
  }
  const type = get("type");
  if (type === "import" || type === "sample") {
    where.push("r.type = ?");
    params.push(type);
  }
  const decision = get("decision");
  if (decision) {
    // Warehouse never learns a sample's decision, so it can't filter by it.
    if (role === "warehouse") where.push("r.type = 'import'");
    if (decision === "approved") where.push("rb.status = 'approved'");
    else if (decision === "concession") where.push("rb.status = 'approved' AND rb.concession = 1");
    else if (decision === "partial" || decision === "rejected") {
      where.push("rb.status = ?");
      params.push(decision);
    }
  }
  const kind = get("kind");
  if (role === "quality" && (kind === "first" || kind === "regular" || kind === "sample")) {
    where.push("rl.supply_kind = ?");
    params.push(kind);
  }
  const supplier = Number(get("supplier"));
  if (supplier && !skipSupplier) {
    where.push("r.supplier_id = ?");
    params.push(supplier);
  }
  const from = get("from");
  const to = get("to");
  if (from) {
    where.push("rb.decided_at IS NOT NULL AND datetime(rb.decided_at) >= datetime(?)");
    params.push(from);
  }
  if (to) {
    where.push("rb.decided_at IS NOT NULL AND datetime(rb.decided_at) <= datetime(?)");
    params.push(to);
  }
  const q = get("q").toLowerCase().replace(/^#/, "");
  if (q) {
    const like = `%${q}%`;
    const codes =
      role === "quality"
        ? "LOWER(COALESCE(rl.material_code, '')) LIKE ? OR LOWER(COALESCE(rl.import_code, '')) LIKE ?"
        : `(rl.material_code NOT ${STAND_IN} AND LOWER(COALESCE(rl.material_code, '')) LIKE ?)`;
    where.push(`(
      LOWER(COALESCE(r.receipt_no, '')) LIKE ? OR LOWER(rl.material_name_text) LIKE ? OR LOWER(COALESCE(m.name, '')) LIKE ?
      OR LOWER(COALESCE(rb.supplier_batch_no, '')) LIKE ? OR LOWER(COALESCE(rb.internal_batch_no, '')) LIKE ?
      OR LOWER(s.name) LIKE ? OR ${codes}
    )`);
    params.push(like, like, like, like, like, like, ...(role === "quality" ? [like, like] : [like]));
  }
  return { where: where.join(" AND "), params };
}

const FROM = `
  FROM receipt_batches rb
  JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
  JOIN receipts r ON r.id = rl.receipt_id
  JOIN suppliers s ON s.id = r.supplier_id
  LEFT JOIN materials m ON m.code = rl.material_code`;

/** Columns per role. Warehouse gets no record codes, no stand-ins and no
 *  decision on samples. */
function selectFor(role: Role): string {
  const quality = role === "quality";
  return `
    SELECT rb.id AS batch_id, rb.supplier_batch_no, rb.internal_batch_no, rb.qty_as_received, rb.qty_accepted,
           rb.qty_rejected, rb.qty_actual_weighed, rb.decided_at, rb.decided_by,
           ${quality ? "rb.status, rb.concession" : "CASE WHEN r.type = 'sample' THEN NULL ELSE rb.status END AS status, CASE WHEN r.type = 'sample' THEN 0 ELSE rb.concession END AS concession"},
           rl.id AS line_id, rl.material_name_text, rl.unit, m.name AS material_name,
           ${quality ? "rl.material_code" : `CASE WHEN rl.material_code ${STAND_IN} THEN NULL ELSE rl.material_code END AS material_code`},
           ${quality ? "rl.import_code, rl.supply_kind" : "NULL AS import_code, NULL AS supply_kind"},
           r.id AS receipt_id, r.receipt_no, r.type AS receipt_type, r.received_at, r.received_at_unknown,
           s.id AS supplier_id, s.name AS supplier_name`;
}

const ORDER = "ORDER BY rb.decided_at IS NULL, datetime(rb.decided_at) DESC, rb.id DESC";

export async function listHistory(request: Request, env: Env, role: Role): Promise<Response> {
  const url = new URL(request.url);
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 80));
  const f = historyFilters(url, role);
  const facet = historyFilters(url, role, { skipSupplier: true });
  const [items, total, suppliers] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`${selectFor(role)} ${FROM} WHERE ${f.where} ${ORDER} LIMIT ? OFFSET ?`).bind(...f.params, limit, offset),
    env.DB.prepare(`SELECT COUNT(*) AS n ${FROM} WHERE ${f.where}`).bind(...f.params),
    env.DB.prepare(
      `SELECT s.id, s.name, COUNT(*) AS n ${FROM} WHERE ${facet.where} GROUP BY s.id ORDER BY n DESC, s.name`
    ).bind(...facet.params),
  ]);
  return json({
    items: items.results ?? [],
    total: Number(total.results?.[0]?.n ?? 0),
    offset,
    limit,
    suppliers: suppliers.results ?? [],
  });
}

/** Every row the current filters match, for the export. */
export async function historyRowsForExport(url: URL, env: Env, role: Role): Promise<Record<string, unknown>[]> {
  const f = historyFilters(url, role);
  const rows = await env.DB.prepare(`${selectFor(role)} ${FROM} WHERE ${f.where} ${ORDER} LIMIT 5000`)
    .bind(...f.params)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}
