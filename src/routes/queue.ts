import { error, json } from "../http";
import type { Env } from "../types";

// Quality's To Do as a work queue: one row per batch still waiting for a
// decision, each in the stage that says what it needs next. Records carried
// over from Access sit in their own "Access backlog" scope so they don't
// bury new work.

export type QueueStage = "needs_code" | "needs_spec" | "to_test" | "ready";
const STAGES: QueueStage[] = ["needs_code", "needs_spec", "to_test", "ready"];

/** Every pending batch, with its stage and how long it has waited. The spec
 *  test mirrors resolveLineSpecs: a line's one-time spec, the material's
 *  spec for its manufacturer, or its normal spec (a sample also accepts the
 *  supply spec). */
const QUEUE_CTE = `
  WITH q AS (
    SELECT rb.id AS batch_id, rb.supplier_batch_no, rb.qty_as_received, rb.expiry_date, rb.retest_of_batch_id,
           rl.id AS line_id, rl.material_code, rl.material_name_text, rl.unit, rl.import_code, rl.supply_kind,
           rl.manufacturer, m.name AS material_name,
           r.id AS receipt_id, r.receipt_no, r.type AS receipt_type, r.received_at, r.received_at_unknown,
           CASE WHEN r.legacy_ref IS NULL THEN 0 ELSE 1 END AS from_access,
           s.id AS supplier_id, s.name AS supplier_name, s.code AS supplier_code,
           CASE
             WHEN rl.material_code IS NULL THEN 'needs_code'
             WHEN EXISTS (SELECT 1 FROM batch_test_results t WHERE t.batch_id = rb.id) THEN 'ready'
             WHEN NOT EXISTS (
               SELECT 1 FROM specs sp
               WHERE sp.status = 'active' AND (
                 sp.receipt_line_id = rl.id
                 OR (sp.receipt_line_id IS NULL AND sp.material_code = rl.material_code
                     AND (sp.scope = 'supply' OR r.type = 'sample')
                     AND (sp.variant IS NULL OR LOWER(TRIM(sp.variant)) = LOWER(TRIM(COALESCE(rl.manufacturer, '')))))
               )
             ) THEN 'needs_spec'
             ELSE 'to_test'
           END AS stage,
           CASE WHEN r.received_at_unknown = 1 THEN NULL
                ELSE CAST(julianday('now') - julianday(r.received_at) AS INTEGER) END AS waiting_days
    FROM receipt_batches rb
    JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
    JOIN receipts r ON r.id = rl.receipt_id
    JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN materials m ON m.code = rl.material_code
    WHERE rb.status = 'pending'
  )`;

const SORTS: Record<string, string> = {
  oldest: "received_at_unknown ASC, received_at ASC, batch_id ASC",
  newest: "received_at_unknown ASC, received_at DESC, batch_id DESC",
  expiry: "expiry_date IS NULL, expiry_date ASC, received_at ASC",
};

export async function listQualityQueue(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const get = (k: string) => (url.searchParams.get(k) ?? "").trim();
  const scope = get("scope") === "backlog" ? 1 : 0;
  const stage = get("stage");
  if (stage && stage !== "all" && !STAGES.includes(stage as QueueStage)) return error("Unknown stage", 400);
  const sort = SORTS[get("sort")] ?? SORTS.oldest;
  const offset = Math.max(0, Number(get("offset")) || 0);
  const limit = Math.min(200, Math.max(1, Number(get("limit")) || 80));

  // Filters shared by the list and the stage counts (everything but stage).
  const where: string[] = ["from_access = ?"];
  const params: Array<string | number> = [scope];
  const type = get("type");
  if (type === "import" || type === "sample") {
    where.push("receipt_type = ?");
    params.push(type);
  }
  const kind = get("kind");
  if (kind === "first" || kind === "regular" || kind === "sample") {
    where.push("supply_kind = ?");
    params.push(kind);
  }
  const supplier = Number(get("supplier"));
  if (supplier) {
    where.push("supplier_id = ?");
    params.push(supplier);
  }
  if (get("not_matched") === "1") where.push("material_code GLOB 'RM[SFP][0-9][0-9][0-9][0-9]*'");
  const q = get("q").toLowerCase().replace(/^#/, "");
  if (q) {
    const like = `%${q}%`;
    where.push(`(
      LOWER(COALESCE(receipt_no, '')) LIKE ? OR LOWER(COALESCE(material_code, '')) LIKE ?
      OR LOWER(COALESCE(import_code, '')) LIKE ? OR LOWER(material_name_text) LIKE ?
      OR LOWER(COALESCE(material_name, '')) LIKE ? OR LOWER(COALESCE(supplier_batch_no, '')) LIKE ?
      OR LOWER(supplier_name) LIKE ? OR LOWER(supplier_code) LIKE ?
    )`);
    params.push(like, like, like, like, like, like, like, like);
  }
  const filtered = where.join(" AND ");
  const listWhere = stage && stage !== "all" ? `${filtered} AND stage = ?` : filtered;
  const listParams = stage && stage !== "all" ? [...params, stage] : params;

  const [items, stageRows, scopeRows, supplierRows] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`${QUEUE_CTE} SELECT * FROM q WHERE ${listWhere} ORDER BY ${sort} LIMIT ? OFFSET ?`).bind(
      ...listParams,
      limit,
      offset
    ),
    env.DB.prepare(`${QUEUE_CTE} SELECT stage, COUNT(*) AS n FROM q WHERE ${filtered} GROUP BY stage`).bind(...params),
    env.DB.prepare(`${QUEUE_CTE} SELECT from_access, COUNT(*) AS n FROM q GROUP BY from_access`),
    env.DB.prepare(
      `${QUEUE_CTE} SELECT supplier_id AS id, supplier_name AS name, COUNT(*) AS n FROM q
       WHERE from_access = ? GROUP BY supplier_id ORDER BY n DESC, name`
    ).bind(scope),
  ]);

  const counts: Record<string, number> = { needs_code: 0, needs_spec: 0, to_test: 0, ready: 0 };
  for (const r of stageRows.results ?? []) counts[r.stage as string] = Number(r.n);
  counts.all = STAGES.reduce((sum, s) => sum + counts[s], 0);
  const scopes = { new: 0, backlog: 0 };
  for (const r of scopeRows.results ?? []) scopes[Number(r.from_access) ? "backlog" : "new"] = Number(r.n);

  return json({
    items: items.results ?? [],
    total: stage && stage !== "all" ? counts[stage] : counts.all,
    offset,
    limit,
    counts,
    scopes,
    suppliers: supplierRows.results ?? [],
  });
}

/** Quality's To Do badge: batches waiting on Quality, not counting the
 *  Access backlog. */
export async function qualityQueueCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     JOIN receipts r ON r.id = rl.receipt_id
     WHERE rb.status = 'pending' AND r.legacy_ref IS NULL`
  ).first<{ n: number }>();
  return row?.n ?? 0;
}
