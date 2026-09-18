import {
  classifySupplyLine,
  drawPoolCode,
  fetchByIds,
  generateInternalBatchNo,
  getSupplierByCode,
  isImportCodeTaken,
  isInternalBatchNoTaken,
  nextReceiptNo,
  notify,
  POOL_FOR_KIND,
  resolveMaterialClassification,
} from "../db";
import { error, json } from "../http";
import { autoJudge } from "../../public/specLimits.js";
import { createSpecVersion, getActiveSpec, getActiveSpecsForMaterials } from "./specs";
import type {
  AssociateCodeInput,
  BatchDecisionInput,
  BatchTestResult,
  Env,
  FinalizeWeightInput,
  LineProductInfoInput,
  NewReceiptInput,
  Receipt,
  ReceiptBatch,
  ReceiptLine,
  RecordTestResultsInput,
  Role,
  SetLineClassificationInput,
  SetSampleSenderInput,
  SpecScope,
  SpecWithParameters,
  Supplier,
  SupplyKind,
} from "../types";

/** A test result joined with enough of its spec parameter to render/export
 *  without a second lookup. */
export interface TestResultWithParameter extends BatchTestResult {
  test_code: string | null;
  parameter_name: string;
  unit: string | null;
  param_type: string;
  method: string | null;
  conditions: string | null;
  min_value: number | null;
  max_value: number | null;
  expected_text: string | null;
  target_value: number | null;
  tolerance: number | null;
  remarks: string | null;
}

const RESULT_PARAMETER_COLUMNS =
  "sp.test_code, sp.parameter_name, sp.unit, sp.param_type, sp.method, sp.conditions, sp.min_value, sp.max_value, sp.expected_text, sp.target_value, sp.tolerance, sp.remarks";

/** Samples are tested against the sample spec (falling back to the supply
 *  spec); everything else against the supply spec. */
export function specScopeFor(receiptType: string): SpecScope {
  return receiptType === "sample" ? "sample" : "supply";
}

/** Full receipt payload assembled from the three tables for API responses. */
interface ReceiptWithDetail {
  id: number;
  type: string;
  received_at: string;
  supplier_id: number;
  created_by: string;
  status: string;
  created_at: string;
  sample_sent_by: string | null;
  lines: Array<
    ReceiptLine & {
      batches: Array<Partial<ReceiptBatch> & { test_results: TestResultWithParameter[] }>;
      spec: SpecWithParameters | null;
    }
  >;
}

export async function getBatchTestResults(env: Env, batchId: number): Promise<TestResultWithParameter[]> {
  const rows = await env.DB.prepare(
    `SELECT btr.*, ${RESULT_PARAMETER_COLUMNS}
     FROM batch_test_results btr
     JOIN spec_parameters sp ON sp.id = btr.spec_parameter_id
     WHERE btr.batch_id = ?
     ORDER BY sp.sort_order`
  )
    .bind(batchId)
    .all<TestResultWithParameter>();
  return rows.results ?? [];
}

export async function createReceipt(request: Request, env: Env, role: Role): Promise<Response> {
  const input = await request.json<NewReceiptInput>();

  // Quality only registers samples it received directly; everything else
  // comes in through the warehouse.
  if (role === "quality" && input.type !== "sample") {
    return error("Quality can only register samples it received directly", 403);
  }
  if (!input.lines?.length) {
    return error("A receipt needs at least one line");
  }
  if (input.sample_sent_by && input.type !== "sample") {
    return error("sample_sent_by only applies to sample receipts");
  }
  const supplier = await getSupplierByCode(env, input.supplier_code);
  if (!supplier) return error(`Unknown supplier code: ${input.supplier_code}`, 404);

  // receipt_lines.material_code is a foreign key into materials — check
  // every line up front (before writing anything) rather than letting an
  // unknown code surface as a raw constraint-violation 500 partway
  // through inserting the lines.
  for (const line of input.lines) {
    if (!line.material_code) continue;
    const material = await env.DB.prepare("SELECT code FROM materials WHERE code = ?")
      .bind(line.material_code)
      .first();
    if (!material) return error(`Unknown material code: ${line.material_code}`, 404);
  }

  for (const line of input.lines) {
    if (!line.batches?.length) return error("Each line needs at least one batch");
  }

  // A batch flagged as a retest must point at a real, previously
  // *rejected* batch — checked up front for the same reason material
  // codes are: a bad id here shouldn't surface as a raw FK-constraint 500
  // partway through the insert below.
  for (const line of input.lines) {
    for (const batch of line.batches) {
      if (batch.retest_of_batch_id == null) continue;
      const original = await env.DB.prepare("SELECT id, status FROM receipt_batches WHERE id = ?")
        .bind(batch.retest_of_batch_id)
        .first<{ id: number; status: string }>();
      if (!original) return error(`Unknown batch to retest: #${batch.retest_of_batch_id}`, 404);
      if (original.status !== "rejected") {
        return error(`Batch #${batch.retest_of_batch_id} isn't rejected, so it isn't something to retest`, 400);
      }
    }
  }

  // The receipt itself is inserted first, on its own — a single INSERT
  // essentially can't "partially" fail, and doing it this way gives every
  // line/batch insert below a real numeric receipt_id to bind, instead of
  // relying on last_insert_rowid() across multiple lines (which would
  // break: by the second line, last_insert_rowid() would point at the
  // first line's last *batch* row, not the receipt).
  // Warehouse deliveries continue the addition-note serial; a sample Quality
  // received directly gets its own QS- number, so the two never collide.
  const receiptNo = await nextReceiptNo(env, role === "quality" ? "quality_sample" : "warehouse");
  const receiptRow = await env.DB.prepare(
    `INSERT INTO receipts (type, received_at, supplier_id, created_by, status, sample_sent_by, receipt_no, received_by)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
     RETURNING id`
  )
    .bind(input.type, input.received_at, supplier.id, input.created_by, input.sample_sent_by ?? null, receiptNo, role)
    .first<{ id: number }>();
  const receiptId = receiptRow!.id;

  // Like the Access log, every line gets its kind and code the moment it's
  // registered: a sample line draws from RMS; a supply line is classified
  // first (RMF) or regular (RMP) from its material's history. A supply line
  // without a material code can't be classified yet, so it gets its code
  // when Quality associates one (associateCode).
  const lineCodes: Array<{ kind: SupplyKind | null; scenario: string | null; code: string | null }> = [];
  for (const line of input.lines) {
    if (input.type === "sample") {
      lineCodes.push({ kind: "sample", scenario: null, code: await drawPoolCode(env, "RMS") });
    } else if (line.material_code) {
      const c = await classifySupplyLine(env, line.material_code, line.material_name_text, supplier.id, receiptId);
      lineCodes.push({ kind: c.kind, scenario: c.scenario, code: await drawPoolCode(env, POOL_FOR_KIND[c.kind]) });
    } else {
      lineCodes.push({ kind: null, scenario: null, code: null });
    }
  }

  // Every line and batch insert lands in one atomic D1 batch (a single
  // transaction — all commit together or none do) instead of the previous
  // sequential .run() calls, so a failure partway through a multi-line,
  // multi-batch receipt can no longer leave an orphaned partial receipt
  // behind. Each batch insert looks its line's id up via a correlated
  // subquery ("the most recently inserted line for this receipt") rather
  // than last_insert_rowid() — that connection-level value drifts to point
  // at whichever *batch* row was just inserted once a line has more than
  // one batch, silently misattaching every batch after the first.
  const statements: D1PreparedStatement[] = [];
  input.lines.forEach((line, i) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO receipt_lines (receipt_id, material_code, material_name_text, unit, packaging_type, qty_basis,
                                    supply_kind, import_scenario, import_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        receiptId,
        line.material_code ?? null,
        line.material_name_text,
        line.unit,
        line.packaging_type ?? null,
        line.qty_basis ?? null,
        lineCodes[i].kind,
        lineCodes[i].scenario,
        lineCodes[i].code
      )
    );
    for (const batch of line.batches) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO receipt_batches (receipt_line_id, supplier_batch_no, qty_as_received, container_qty, per_unit_weight, qty_secondary, retest_of_batch_id, status)
           VALUES ((SELECT id FROM receipt_lines WHERE receipt_id = ? ORDER BY id DESC LIMIT 1), ?, ?, ?, ?, ?, ?, 'pending')`
        ).bind(
          receiptId,
          batch.supplier_batch_no,
          batch.qty_as_received,
          batch.container_qty ?? null,
          batch.per_unit_weight ?? null,
          batch.qty_secondary ?? null,
          batch.retest_of_batch_id ?? null
        )
      );
    }
  });
  await env.DB.batch(statements);

  await notify(
    env,
    "quality",
    "new_receipt",
    `New ${input.type} receipt #${receiptNo} from ${supplier.name} awaiting review`,
    { receiptId }
  );

  return json({ id: receiptId, receipt_no: receiptNo }, 201);
}

/** Rejected batches for one material code, for the Receive wizard's
 *  "Retest of" picker — only rejected batches make sense to retest. */
export async function listRejectedBatchesForMaterial(env: Env, role: Role, materialCode: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT rb.id, rb.supplier_batch_no, rb.internal_batch_no, rb.decided_at, rl.receipt_id
     FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     JOIN receipts r ON r.id = rl.receipt_id
     WHERE rl.material_code = ? AND rb.status = 'rejected' AND ${visibleToSql(role)}
     ORDER BY rb.decided_at DESC
     LIMIT 50`
  )
    .bind(materialCode)
    .all();
  return json(rows.results ?? []);
}

/** Resolves a batch id into just enough human-readable info to show on a
 *  "Retest of ..." label — called once per batch that actually has a
 *  retest link set (rare), rather than joined into every list load. */
export async function getBatchSummary(env: Env, role: Role, batchId: number): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT rb.id, rb.supplier_batch_no, rb.internal_batch_no, rl.receipt_id, r.receipt_no, rl.material_name_text
     FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     JOIN receipts r ON r.id = rl.receipt_id
     WHERE rb.id = ? AND ${visibleToSql(role)}`
  )
    .bind(batchId)
    .first();
  if (!row) return error("Batch not found", 404);
  return json(row);
}

/** `type` is how Quality's two tabs (Imports / Samples) are implemented —
 *  each tab is just this endpoint called with a fixed `type` filter. */
export async function listReceipts(request: Request, env: Env, role: Role): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const type = url.searchParams.get("type");

  const conditions: string[] = [visibleToSql(role)];
  const params: string[] = [];
  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const rows = await env.DB.prepare(`SELECT * FROM receipts r ${where} ORDER BY created_at DESC LIMIT 200`)
    .bind(...params)
    .all();

  return json(rows.results?.map((r) => redactReceiptSummaryForRole(r, role)) ?? []);
}

/** Count for the To Do nav badge — deliberately a single SQL COUNT rather
 *  than reusing listReceiptsDetailed's full fetch-and-filter (this gets
 *  polled every 20s, so it needs to stay cheap regardless of how many
 *  receipts exist). Mirrors the exact "still open" rule
 *  fetchReceiptsBucket() applies client-side in app.js: Quality's to-do is
 *  simply "not yet decided"; Warehouse's also includes an already-decided
 *  receipt that still has an approved/partial batch nobody has weighed in
 *  yet. */
export async function getTodoCount(env: Env, role: Role): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM receipts r WHERE ${visibleToSql(role)} AND ${openReceiptSql(role)}`
  ).first<{
    count: number;
  }>();
  return json({ count: row?.count ?? 0 });
}

/** SQL condition (on alias `r`): the receipts this role may see at all.
 *  Samples Quality received directly never reach Warehouse. */
export function visibleToSql(role: Role): string {
  return role === "warehouse" ? "r.received_by = 'warehouse'" : "1 = 1";
}

/** SQL condition (on alias `r`) for "still on this role's To Do": Quality's
 *  is simply "not yet decided"; Warehouse's also keeps a decided *import*
 *  that still has an approved/partial batch nobody has weighed in yet
 *  (samples are never weighed, so they never linger for that reason). */
function openReceiptSql(role: Role): string {
  if (role !== "warehouse") return "r.status != 'decided'";
  return `(r.status != 'decided' OR (r.type = 'import' AND EXISTS (
    SELECT 1 FROM receipt_lines rl
    JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
    WHERE rl.receipt_id = r.id
      -- The unary + keeps SQLite from walking every approved batch through
      -- the status index for each receipt (seconds, once the Access history
      -- is in); batches are found through their line instead (milliseconds).
      AND +rb.status IN ('approved', 'partial')
      AND rb.qty_actual_weighed IS NULL
  )))`;
}

export async function getReceipt(env: Env, role: Role, id: number): Promise<Response> {
  const receipt = await env.DB.prepare(`SELECT * FROM receipts r WHERE r.id = ? AND ${visibleToSql(role)}`)
    .bind(id)
    .first();
  if (!receipt) return error("Receipt not found", 404);

  const lines = await env.DB.prepare("SELECT * FROM receipt_lines WHERE receipt_id = ?")
    .bind(id)
    .all<ReceiptLine>();

  const detail: ReceiptWithDetail = { ...(receipt as any), lines: [] };

  for (const line of lines.results ?? []) {
    const batches = await env.DB.prepare("SELECT * FROM receipt_batches WHERE receipt_line_id = ?")
      .bind(line.id)
      .all<ReceiptBatch>();
    const spec = line.material_code
      ? await getActiveSpec(env, line.material_code, specScopeFor(receipt.type as string))
      : null;
    const batchesWithResults = [];
    for (const b of batches.results ?? []) {
      const test_results = role === "quality" || receipt.type !== "sample" ? await getBatchTestResults(env, b.id) : [];
      batchesWithResults.push({ ...redactBatchForRole(b, role, receipt.type as string), test_results });
    }
    detail.lines.push({ ...redactLineForRole(line, role), spec, batches: batchesWithResults });
  }

  return json(detail);
}

/** Same shape as calling getReceipt once per row, for a whole type-filtered
 *  page at once — this is what the To Do/History screens actually need,
 *  every time they load. The frontend used to fetch listReceipts and then
 *  call getReceipt for every single row (up to 200 sequential round trips
 *  per page load); this does it in a fixed handful of batched queries
 *  regardless of how many receipts are in the page. */
export async function listReceiptsDetailed(request: Request, env: Env, role: Role): Promise<Response> {
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const bucket = url.searchParams.get("bucket");
  const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  // Filtering, search and paging all happen here rather than in the
  // browser, so a list with thousands of receipts (the Access history)
  // stays complete and fast.
  const conditions: string[] = [visibleToSql(role)];
  const params: Array<string | number> = [];
  if (type) {
    conditions.push("r.type = ?");
    params.push(type);
  }
  if (bucket === "todo") conditions.push(openReceiptSql(role));
  if (bucket === "history") conditions.push(`NOT ${openReceiptSql(role)}`);
  if (query) {
    const like = `%${query.replace(/^#/, "")}%`;
    // Warehouse never learns a sample's status, so it can't search by it either.
    const statusVisible = role === "quality" ? "1" : "r.type != 'sample'";
    conditions.push(`(
      LOWER(COALESCE(r.receipt_no, '')) LIKE ?
      OR LOWER(s.name) LIKE ? OR LOWER(s.code) LIKE ?
      OR (${statusVisible} AND r.status LIKE ?)
      OR EXISTS (
        SELECT 1 FROM receipt_lines ql
        LEFT JOIN receipt_batches qb ON qb.receipt_line_id = ql.id
        WHERE ql.receipt_id = r.id AND (
          LOWER(COALESCE(ql.material_code, '')) LIKE ?
          OR LOWER(COALESCE(ql.import_code, '')) LIKE ?
          OR LOWER(ql.material_name_text) LIKE ?
          OR LOWER(COALESCE(qb.supplier_batch_no, '')) LIKE ?
          OR LOWER(COALESCE(qb.internal_batch_no, '')) LIKE ?
          OR (${statusVisible} AND COALESCE(qb.status, '') LIKE ?)
        )
      )
    )`);
    params.push(like, like, like, like, like, like, like, like, like, like);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const from = "FROM receipts r JOIN suppliers s ON s.id = r.supplier_id";

  const [receiptRows, totalRow] = await Promise.all([
    env.DB.prepare(`SELECT r.* ${from} ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<Receipt>(),
    env.DB.prepare(`SELECT COUNT(*) AS total ${from} ${where}`)
      .bind(...params)
      .first<{ total: number }>(),
  ]);
  const receipts = receiptRows.results ?? [];
  const total = totalRow?.total ?? 0;
  if (!receipts.length) return json({ items: [], total, offset, limit });

  const receiptIds = receipts.map((r) => r.id);
  const lines = await fetchByIds<ReceiptLine>(
    env,
    (ph) => `SELECT * FROM receipt_lines WHERE receipt_id IN (${ph})`,
    receiptIds
  );

  const lineIds = lines.map((l) => l.id);
  const batches = await fetchByIds<ReceiptBatch>(
    env,
    (ph) => `SELECT * FROM receipt_batches WHERE receipt_line_id IN (${ph})`,
    lineIds
  );

  const batchIds = batches.map((b) => b.id);
  const testResultRows = await fetchByIds<TestResultWithParameter>(
    env,
    (ph) =>
      `SELECT btr.*, ${RESULT_PARAMETER_COLUMNS}
       FROM batch_test_results btr
       JOIN spec_parameters sp ON sp.id = btr.spec_parameter_id
       WHERE btr.batch_id IN (${ph})
       ORDER BY sp.sort_order`,
    batchIds
  );

  const receiptTypeById = new Map(receipts.map((r) => [r.id, r.type]));
  const codesFor = (scope: SpecScope) =>
    lines
      .filter((l) => l.material_code && specScopeFor(receiptTypeById.get(l.receipt_id)!) === scope)
      .map((l) => l.material_code as string);
  const specsByScope: Record<SpecScope, Map<string, SpecWithParameters>> = {
    supply: await getActiveSpecsForMaterials(env, codesFor("supply"), "supply"),
    sample: await getActiveSpecsForMaterials(env, codesFor("sample"), "sample"),
  };

  const testResultsByBatch = new Map<number, TestResultWithParameter[]>();
  for (const r of testResultRows) {
    if (!testResultsByBatch.has(r.batch_id)) testResultsByBatch.set(r.batch_id, []);
    testResultsByBatch.get(r.batch_id)!.push(r);
  }
  const batchesByLine = new Map<number, ReceiptBatch[]>();
  for (const b of batches) {
    if (!batchesByLine.has(b.receipt_line_id)) batchesByLine.set(b.receipt_line_id, []);
    batchesByLine.get(b.receipt_line_id)!.push(b);
  }
  const linesByReceipt = new Map<number, ReceiptLine[]>();
  for (const l of lines) {
    if (!linesByReceipt.has(l.receipt_id)) linesByReceipt.set(l.receipt_id, []);
    linesByReceipt.get(l.receipt_id)!.push(l);
  }

  const detailed = receipts.map((receipt) => {
    const receiptLines = (linesByReceipt.get(receipt.id) ?? []).map((line) => {
      const spec = line.material_code
        ? (specsByScope[specScopeFor(receipt.type)].get(line.material_code) ?? null)
        : null;
      const lineBatches = (batchesByLine.get(line.id) ?? []).map((b) => {
        const test_results = role === "quality" || receipt.type !== "sample" ? (testResultsByBatch.get(b.id) ?? []) : [];
        return { ...redactBatchForRole(b, role, receipt.type), test_results };
      });
      return { ...redactLineForRole(line, role), spec, batches: lineBatches };
    });
    return { ...receipt, lines: receiptLines };
  });

  return json({ items: detailed, total, offset, limit });
}

export async function decideBatch(
  request: Request,
  env: Env,
  batchId: number
): Promise<Response> {
  const input = await request.json<BatchDecisionInput>();

  const batch = await env.DB.prepare(
    `SELECT rb.*, rl.id as line_id, rl.material_code, rl.material_name_text,
            rl.import_code, rl.import_scenario, rl.supply_kind, rl.receipt_id, r.supplier_id, r.type as receipt_type
     FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     JOIN receipts r ON r.id = rl.receipt_id
     WHERE rb.id = ?`
  )
    .bind(batchId)
    .first<
      ReceiptBatch & {
        line_id: number;
        material_code: string | null;
        material_name_text: string;
        import_code: string | null;
        import_scenario: string | null;
        supply_kind: SupplyKind | null;
        receipt_id: number;
        supplier_id: number;
        receipt_type: string;
      }
    >();
  if (!batch) return error("Batch not found", 404);
  if (!batch.material_code) {
    return error("Associate a material code on this line before testing it", 400);
  }
  if (batch.status !== "pending") {
    return error("This batch has already been decided", 409);
  }
  if (!["approve", "concession", "reject", "partial"].includes(input.decision)) {
    return error("decision must be approve, concession, reject or partial", 400);
  }
  const concession = input.decision === "concession";
  const concessionReason = input.concession_reason?.trim() || null;
  const concessionApprovedBy = input.concession_approved_by?.trim() || null;
  if (concession && (!concessionReason || !concessionApprovedBy)) {
    return error("Accepting with concession needs a reason and who authorized it", 400);
  }

  let status: "approved" | "rejected" | "partial";
  let qtyAccepted: number | null = null;
  let qtyRejected: number | null = null;

  if (input.decision === "reject") {
    status = "rejected";
    qtyRejected = batch.qty_as_received;
  } else {
    status = input.decision === "partial" ? "partial" : "approved";
    qtyAccepted = input.qty_accepted ?? batch.qty_as_received;
    qtyRejected = input.qty_rejected ?? Math.max(0, batch.qty_as_received - qtyAccepted);

    // A typo'd or made-up split shouldn't silently corrupt the batch's own
    // received quantity — accepted/rejected can't be negative, and can't
    // add up to more than what was actually received.
    if (qtyAccepted < 0 || qtyRejected < 0) {
      return error("Accepted and rejected quantities can't be negative", 400);
    }
    if (qtyAccepted + qtyRejected > batch.qty_as_received) {
      return error(
        `Accepted (${qtyAccepted}) + rejected (${qtyRejected}) can't exceed the received quantity (${batch.qty_as_received})`,
        400
      );
    }
  }

  const manualBatchNo = status === "rejected" ? null : input.internal_batch_no?.trim() || null;
  if (manualBatchNo && (await isInternalBatchNoTaken(env, batch.material_code, manualBatchNo, batchId))) {
    return error(`Internal batch # ${manualBatchNo} is already used for ${batch.material_code}`, 409);
  }
  const manualImportCode = input.import_code?.trim() || null;
  if (manualImportCode && !batch.import_code && (await isImportCodeTaken(env, manualImportCode, batch.line_id))) {
    return error(`Code ${manualImportCode} is already used on another line`, 409);
  }

  const supplier = (await env.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
    .bind(batch.supplier_id)
    .first<Supplier>())!;

  // Lines registered before codes were assigned at receiving time may
  // still lack one — give it one now, from the pool its kind belongs to.
  let importCode = batch.import_code;
  let importScenario = batch.import_scenario;
  if (!importCode) {
    let kind = batch.supply_kind;
    if (!kind) {
      if (batch.receipt_type === "sample") {
        kind = "sample";
      } else {
        const c = await classifySupplyLine(env, batch.material_code, batch.material_name_text, supplier.id, batch.receipt_id);
        kind = c.kind;
        importScenario = c.scenario;
      }
    }
    if (manualImportCode) {
      importCode = manualImportCode;
      importScenario = null;
    } else {
      importCode = await drawPoolCode(env, POOL_FOR_KIND[kind]);
    }
    await env.DB.prepare("UPDATE receipt_lines SET import_code = ?, import_scenario = ?, supply_kind = ? WHERE id = ?")
      .bind(importCode, importScenario, kind, batch.line_id)
      .run();
  }

  const internalBatchNo =
    status === "rejected"
      ? null
      : (manualBatchNo ?? (await generateInternalBatchNo(env, supplier, batch.material_code, new Date())));

  // Guarding the UPDATE itself with "AND status = 'pending'" (not just the
  // earlier SELECT-time check) closes a real race: two near-simultaneous
  // decide requests on the same batch could otherwise both pass the check
  // above before either UPDATE lands, and the second would silently
  // overwrite the first's decision.
  const result = await env.DB.prepare(
    `UPDATE receipt_batches
     SET status = ?, qty_accepted = ?, qty_rejected = ?, internal_batch_no = ?,
         expiry_date = ?, production_date = ?, coa_remarks = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP,
         concession = ?, concession_reason = ?, concession_approved_by = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(
      status,
      qtyAccepted,
      qtyRejected,
      internalBatchNo,
      input.expiry_date ?? null,
      input.production_date ?? null,
      input.coa_remarks ?? null,
      input.decided_by,
      concession ? 1 : 0,
      concession ? concessionReason : null,
      concession ? concessionApprovedBy : null,
      batchId
    )
    .run();
  if (result.meta.changes === 0) {
    return error("This batch was just decided by someone else — refresh and check its current status", 409);
  }

  await env.DB.prepare(
    `UPDATE receipts SET status = 'decided' WHERE id = ? AND NOT EXISTS (
       SELECT 1 FROM receipt_batches rb
       JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
       WHERE rl.receipt_id = ? AND rb.status = 'pending'
     )`
  )
    .bind(batch.receipt_id, batch.receipt_id)
    .run();

  const summary =
    status === "rejected"
      ? `Batch ${batch.supplier_batch_no} was rejected`
      : concession
        ? `Batch ${batch.supplier_batch_no} accepted with concession — internal batch # ${internalBatchNo}`
        : `Batch ${batch.supplier_batch_no} ${status} — internal batch # ${internalBatchNo}`;
  await notify(env, "warehouse", "decision", summary, {
    receiptId: batch.receipt_id,
    batchId,
  });

  return json({
    id: batchId,
    status,
    concession,
    internal_batch_no: internalBatchNo,
    import_code: importCode,
    import_scenario: importScenario,
  });
}

/**
 * Quality re-files a line as a sample, first supply, or regular supply —
 * at any time, decided or not. Sample vs supply is a property of the whole
 * receipt (it decides what Warehouse may see), so moving one line across
 * that boundary moves the whole receipt: the other lines are re-filed too
 * (samples -> RMS; supplies -> classified from history; an uncoded supply
 * line waits for its material code, as at receiving time).
 *
 * A line whose kind changes gets the next code from its new pool, unless
 * Quality typed a code in. The old number isn't reused.
 */
export async function setLineClassification(request: Request, env: Env, lineId: number): Promise<Response> {
  const input = await request.json<SetLineClassificationInput>();
  if (!["sample", "first", "regular"].includes(input.supply_kind)) {
    return error("supply_kind must be sample, first or regular", 400);
  }
  const manualCode = input.import_code?.trim() || null;

  const line = await env.DB.prepare(
    `SELECT rl.id, rl.receipt_id, rl.supply_kind, rl.import_code, r.type AS receipt_type
     FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id
     WHERE rl.id = ?`
  )
    .bind(lineId)
    .first<{ id: number; receipt_id: number; supply_kind: SupplyKind | null; import_code: string | null; receipt_type: string }>();
  if (!line) return error("Receipt line not found", 404);
  if (manualCode && (await isImportCodeTaken(env, manualCode, lineId))) {
    return error(`Code ${manualCode} is already used on another line`, 409);
  }

  const kind = input.supply_kind;
  const newReceiptType = kind === "sample" ? "sample" : "import";
  const statements: D1PreparedStatement[] = [];

  if (newReceiptType !== line.receipt_type) {
    statements.push(env.DB.prepare("UPDATE receipts SET type = ? WHERE id = ?").bind(newReceiptType, line.receipt_id));

    const receipt = (await env.DB.prepare("SELECT supplier_id FROM receipts WHERE id = ?")
      .bind(line.receipt_id)
      .first<{ supplier_id: number }>())!;
    const others = await env.DB.prepare(
      "SELECT id, material_code, material_name_text FROM receipt_lines WHERE receipt_id = ? AND id != ?"
    )
      .bind(line.receipt_id, lineId)
      .all<{ id: number; material_code: string | null; material_name_text: string }>();
    for (const other of others.results ?? []) {
      let otherKind: SupplyKind | null = null;
      let otherScenario: string | null = null;
      let otherCode: string | null = null;
      if (newReceiptType === "sample") {
        otherKind = "sample";
        otherCode = await drawPoolCode(env, "RMS");
      } else if (other.material_code) {
        const c = await classifySupplyLine(env, other.material_code, other.material_name_text, receipt.supplier_id, line.receipt_id);
        otherKind = c.kind;
        otherScenario = c.scenario;
        otherCode = await drawPoolCode(env, POOL_FOR_KIND[c.kind]);
      }
      statements.push(
        env.DB.prepare("UPDATE receipt_lines SET supply_kind = ?, import_scenario = ?, import_code = ? WHERE id = ?").bind(
          otherKind,
          otherScenario,
          otherCode,
          other.id
        )
      );
    }
  }

  let code = line.import_code;
  if (manualCode) code = manualCode;
  else if (kind !== line.supply_kind || !code) code = await drawPoolCode(env, POOL_FOR_KIND[kind]);

  // Set by hand, so there's no detected scenario to show any more.
  statements.push(
    env.DB.prepare("UPDATE receipt_lines SET supply_kind = ?, import_scenario = NULL, import_code = ? WHERE id = ?").bind(
      kind,
      code,
      lineId
    )
  );
  await env.DB.batch(statements);

  return json({ id: lineId, supply_kind: kind, import_code: code, receipt_type: newReceiptType });
}

export async function recordTestResults(
  request: Request,
  env: Env,
  batchId: number
): Promise<Response> {
  const input = await request.json<RecordTestResultsInput>();

  const batch = await env.DB.prepare(
    `SELECT rb.*, rl.material_code, r.type AS receipt_type
     FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     JOIN receipts r ON r.id = rl.receipt_id
     WHERE rb.id = ?`
  )
    .bind(batchId)
    .first<ReceiptBatch & { material_code: string | null; receipt_type: string }>();
  if (!batch) return error("Batch not found", 404);
  if (!batch.material_code) {
    return error("Associate a material code on this line before testing it", 400);
  }
  if (batch.status !== "pending") {
    return error("This batch has already been decided — test results are locked", 409);
  }
  if (!input.results?.length) {
    return error("Provide at least one test result", 400);
  }

  const spec = await getActiveSpec(env, batch.material_code, specScopeFor(batch.receipt_type));
  const paramsById = new Map((spec?.parameters ?? []).map((p) => [p.id, p]));
  const rows: Array<{ id: number; measured: string | null; result: string | null; auto: string | null; reason: string | null }> = [];
  for (const r of input.results) {
    const param = paramsById.get(r.spec_parameter_id);
    if (!param) {
      return error(`spec_parameter_id ${r.spec_parameter_id} is not on this material's active spec`, 400);
    }
    const measured = r.measured_value?.trim() || null;
    // The app judges numeric and time limits itself; a person can still
    // disagree (e.g. a known instrument offset), but has to say why.
    const auto = autoJudge(param, measured);
    // A value with no result is kept as "not judged" — unless the app can
    // judge it, in which case its judgement is the result.
    if (r.result == null && measured != null) r.result = auto;
    if (r.result != null && r.result !== "pass" && r.result !== "fail") {
      return error("Each test result needs result: 'pass', 'fail', or none", 400);
    }
    if (r.result == null && measured == null) {
      return error(`${param.parameter_name}: enter a value or a result`, 400);
    }
    const reason = r.override_reason?.trim() || null;
    if (auto && r.result && auto !== r.result && !reason) {
      return error(
        `${param.parameter_name}: ${measured} is a ${auto} against the spec — give a reason to record it as ${r.result}`,
        400
      );
    }
    rows.push({ id: param.id, measured, result: r.result, auto, reason: auto && r.result && auto !== r.result ? reason : null });
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM batch_test_results WHERE batch_id = ?").bind(batchId),
    ...rows.map((r) =>
      env.DB.prepare(
        `INSERT INTO batch_test_results (batch_id, spec_parameter_id, measured_value, result, auto_result, override_reason)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(batchId, r.id, r.measured, r.result, r.auto, r.reason)
    ),
  ]);

  await env.DB.prepare("UPDATE receipt_batches SET tested_by = ?, tested_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(input.tested_by, batchId)
    .run();

  return json({ id: batchId, tested_by: input.tested_by });
}

export async function finalizeWeight(request: Request, env: Env, batchId: number): Promise<Response> {
  const input = await request.json<FinalizeWeightInput>();

  const batch = await env.DB.prepare(
    `SELECT rb.*, r.type as receipt_type
     FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     JOIN receipts r ON r.id = rl.receipt_id
     WHERE rb.id = ?`
  )
    .bind(batchId)
    .first<ReceiptBatch & { receipt_type: string }>();
  if (!batch) return error("Batch not found", 404);
  if (batch.receipt_type === "sample") return error("Samples don't get a weight finalization step", 400);
  if (batch.status === "pending") return error("Batch has not been decided by Quality yet", 400);
  if (batch.qty_actual_weighed != null) {
    return error("Actual weight has already been recorded for this batch", 409);
  }

  // Same race as decideBatch: guard the UPDATE itself, not just the read
  // above, so two near-simultaneous finalize requests can't both "win".
  const additionNo = input.addition_no?.trim() || null;
  const result = await env.DB.prepare(
    "UPDATE receipt_batches SET qty_actual_weighed = ?, addition_no = ? WHERE id = ? AND qty_actual_weighed IS NULL"
  )
    .bind(input.qty_actual_weighed, additionNo, batchId)
    .run();
  if (result.meta.changes === 0) {
    return error("Actual weight was just recorded by someone else — refresh and check its current value", 409);
  }

  return json({ id: batchId, qty_actual_weighed: input.qty_actual_weighed, addition_no: additionNo });
}

/** Who sent the sample. If warehouse didn't capture it at receiving time
 *  (createReceipt), warehouse permanently loses the ability to add it —
 *  only Quality can fill the gap. Once a value exists, either role can
 *  edit it at any time. */
export async function setSampleSender(
  request: Request,
  env: Env,
  role: Role,
  receiptId: number
): Promise<Response> {
  const input = await request.json<SetSampleSenderInput>();
  if (!input.sample_sent_by) return error("sample_sent_by is required");

  const receipt = await env.DB.prepare(`SELECT type, sample_sent_by FROM receipts r WHERE r.id = ? AND ${visibleToSql(role)}`)
    .bind(receiptId)
    .first<{ type: string; sample_sent_by: string | null }>();
  if (!receipt) return error("Receipt not found", 404);
  if (receipt.type !== "sample") return error("sample_sent_by only applies to sample receipts", 400);
  if (role === "warehouse" && receipt.sample_sent_by === null) {
    return error("Warehouse can only set this at receiving time — ask Quality to add it now", 403);
  }

  await env.DB.prepare("UPDATE receipts SET sample_sent_by = ? WHERE id = ?")
    .bind(input.sample_sent_by, receiptId)
    .run();

  return json({ id: receiptId, sample_sent_by: input.sample_sent_by });
}

/** Quality resolves an uncoded receipt line ("Associate a Code") either by
 *  linking it to an existing material (its spec then applies as-is) or by
 *  creating a brand-new material together with its spec. */
export async function associateCode(request: Request, env: Env, lineId: number): Promise<Response> {
  const input = await request.json<AssociateCodeInput>();

  const line = await env.DB.prepare(
    "SELECT rl.*, r.type AS receipt_type FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id WHERE rl.id = ?"
  )
    .bind(lineId)
    .first<ReceiptLine & { receipt_type: string }>();
  if (!line) return error("Receipt line not found", 404);
  const scope = specScopeFor(line.receipt_type);
  if (line.material_code !== null) {
    return error("This line already has a material code associated", 409);
  }

  let materialCode: string;
  let spec: SpecWithParameters | null;

  if (input.mode === "existing") {
    if (!input.material_code) return error("material_code is required");
    const material = await env.DB.prepare("SELECT code FROM materials WHERE code = ?")
      .bind(input.material_code)
      .first<{ code: string }>();
    if (!material) return error(`Unknown material code: ${input.material_code}`, 404);
    materialCode = material.code;
    spec = await getActiveSpec(env, materialCode, scope);
  } else if (input.mode === "new") {
    const { new_material, spec: specInput } = input;
    if (!new_material?.code || !new_material.name || !new_material.unit) {
      return error("new_material requires code, name and unit");
    }
    if (!specInput?.title || !specInput.created_by) {
      return error("spec (title, created_by) is required when creating a new code");
    }
    const existing = await env.DB.prepare("SELECT code FROM materials WHERE code = ?")
      .bind(new_material.code)
      .first();
    if (existing) return error(`Material code ${new_material.code} already exists`, 409);

    const classification = await resolveMaterialClassification(
      env,
      new_material.type_code,
      new_material.subtype_code
    );
    if (!classification.ok) return error(classification.message, classification.status);

    await env.DB.prepare(
      "INSERT INTO materials (code, name, unit, requires_expiry, type_code, subtype_code) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(
        new_material.code,
        new_material.name,
        new_material.unit,
        new_material.requires_expiry === false ? 0 : 1,
        classification.type_code,
        classification.subtype_code
      )
      .run();
    materialCode = new_material.code;

    const specResult = await createSpecVersion(env, materialCode, { scope, ...specInput });
    if (!specResult.ok) return error(specResult.message, specResult.status);
    spec = specResult.spec;
  } else {
    return error("mode must be 'existing' or 'new'");
  }

  // A supply line registered without a code couldn't be classified at
  // receiving time — now that its material is known, it can be.
  let supplyKind = line.supply_kind;
  let importScenario = line.import_scenario;
  let importCode = line.import_code;
  if (!importCode) {
    const receipt = (await env.DB.prepare("SELECT type, supplier_id FROM receipts WHERE id = ?")
      .bind(line.receipt_id)
      .first<{ type: string; supplier_id: number }>())!;
    if (receipt.type === "sample") {
      supplyKind = "sample";
    } else {
      const c = await classifySupplyLine(env, materialCode, line.material_name_text, receipt.supplier_id, line.receipt_id);
      supplyKind = c.kind;
      importScenario = c.scenario;
    }
    importCode = await drawPoolCode(env, POOL_FOR_KIND[supplyKind]);
  }

  await env.DB.prepare(
    "UPDATE receipt_lines SET material_code = ?, supply_kind = ?, import_scenario = ?, import_code = ? WHERE id = ?"
  )
    .bind(materialCode, supplyKind, importScenario, importCode, lineId)
    .run();

  return json({ receipt_line_id: lineId, material_code: materialCode, spec, supply_kind: supplyKind, import_code: importCode });
}

/** Product description, manufacturer and origin are Quality's notes on
 *  what arrived — Warehouse never receives them. */
function redactLineForRole(line: ReceiptLine, role: Role): ReceiptLine {
  if (role === "quality") return line;
  return { ...line, product_description: null, manufacturer: null, origin: null };
}

/** The received line migrated from one Access record ("access:RM Master
 *  Data:<ID>") — used by the attachment upload script to find where each
 *  old TDS/MSDS/photo belongs. */
export async function findLineByLegacyRef(env: Env, ref: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT rl.id AS line_id, rl.import_code, rl.receipt_id
     FROM receipt_lines rl
     WHERE rl.legacy_ref = ?`
  )
    .bind(ref)
    .first();
  if (!row) return error(`No migrated record for ${ref}`, 404);
  return json(row);
}

/** Quality records (or corrects) the product details of a received line,
 *  at any time. Blank fields are cleared. */
export async function setLineProductInfo(request: Request, env: Env, lineId: number): Promise<Response> {
  const input = await request.json<LineProductInfoInput>();
  const clean = (v: string | null | undefined, max: number) => {
    const t = (v ?? "").trim();
    return t ? t.slice(0, max) : null;
  };
  const description = clean(input.product_description, 2000);
  const manufacturer = clean(input.manufacturer, 200);
  const origin = clean(input.origin, 100);

  const result = await env.DB.prepare(
    "UPDATE receipt_lines SET product_description = ?, manufacturer = ?, origin = ? WHERE id = ?"
  )
    .bind(description, manufacturer, origin, lineId)
    .run();
  if (result.meta.changes === 0) return error("Receipt line not found", 404);
  return json({ id: lineId, product_description: description, manufacturer, origin });
}

/** Samples never show Quality's in-progress/final test status to warehouse. */
function redactBatchForRole(
  batch: ReceiptBatch,
  role: Role,
  receiptType: string
): Partial<ReceiptBatch> {
  if (role === "quality" || receiptType !== "sample") return batch;
  return {
    id: batch.id,
    receipt_line_id: batch.receipt_line_id,
    supplier_batch_no: batch.supplier_batch_no,
    qty_as_received: batch.qty_as_received,
  };
}

function redactReceiptSummaryForRole(receipt: any, role: Role): any {
  if (role === "quality" || receipt.type !== "sample") return receipt;
  const { status, ...rest } = receipt;
  return rest;
}
