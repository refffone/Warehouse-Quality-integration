import {
  fetchByIds,
  generateImportCode,
  generateInternalBatchNo,
  getSupplierByCode,
  notify,
  resolveMaterialClassification,
} from "../db";
import { error, json } from "../http";
import { createSpecVersion, getActiveSpec, getActiveSpecsForMaterials } from "./specs";
import type {
  AssociateCodeInput,
  BatchDecisionInput,
  BatchTestResult,
  Env,
  FinalizeWeightInput,
  NewReceiptInput,
  Receipt,
  ReceiptBatch,
  ReceiptLine,
  RecordTestResultsInput,
  Role,
  SetSampleSenderInput,
  SpecWithParameters,
} from "../types";

/** A test result joined with enough of its spec parameter to render/export
 *  without a second lookup. */
export interface TestResultWithParameter extends BatchTestResult {
  parameter_name: string;
  unit: string | null;
  param_type: string;
  method: string | null;
  min_value: number | null;
  max_value: number | null;
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
    `SELECT btr.*, sp.parameter_name, sp.unit, sp.param_type, sp.method, sp.min_value, sp.max_value
     FROM batch_test_results btr
     JOIN spec_parameters sp ON sp.id = btr.spec_parameter_id
     WHERE btr.batch_id = ?
     ORDER BY sp.sort_order`
  )
    .bind(batchId)
    .all<TestResultWithParameter>();
  return rows.results ?? [];
}

export async function createReceipt(request: Request, env: Env): Promise<Response> {
  const input = await request.json<NewReceiptInput>();

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

  const receiptRow = await env.DB.prepare(
    `INSERT INTO receipts (type, received_at, supplier_id, created_by, status, sample_sent_by)
     VALUES (?, ?, ?, ?, 'pending', ?)
     RETURNING id`
  )
    .bind(input.type, input.received_at, supplier.id, input.created_by, input.sample_sent_by ?? null)
    .first<{ id: number }>();
  const receiptId = receiptRow!.id;

  for (const line of input.lines) {
    if (!line.batches?.length) return error("Each line needs at least one batch");

    const lineRow = await env.DB.prepare(
      `INSERT INTO receipt_lines (receipt_id, material_code, material_name_text, unit, packaging_type)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
      .bind(receiptId, line.material_code ?? null, line.material_name_text, line.unit, line.packaging_type ?? null)
      .first<{ id: number }>();
    const lineId = lineRow!.id;

    for (const batch of line.batches) {
      await env.DB.prepare(
        `INSERT INTO receipt_batches (receipt_line_id, supplier_batch_no, qty_as_received, per_unit_weight, qty_secondary, total_units, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`
      )
        .bind(
          lineId,
          batch.supplier_batch_no,
          batch.qty_as_received,
          batch.per_unit_weight ?? null,
          batch.qty_secondary ?? null,
          batch.total_units ?? null
        )
        .run();
    }
  }

  await notify(
    env,
    "quality",
    "new_receipt",
    `New ${input.type} receipt #${receiptId} from ${supplier.name} awaiting review`,
    { receiptId }
  );

  return json({ id: receiptId }, 201);
}

/** `type` is how Quality's two tabs (Imports / Samples) are implemented —
 *  each tab is just this endpoint called with a fixed `type` filter. */
export async function listReceipts(request: Request, env: Env, role: Role): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const type = url.searchParams.get("type");

  const conditions: string[] = [];
  const params: string[] = [];
  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await env.DB.prepare(`SELECT * FROM receipts ${where} ORDER BY created_at DESC LIMIT 200`)
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
  const sql =
    role === "warehouse"
      ? `SELECT COUNT(*) AS count FROM receipts r
         WHERE r.status != 'decided'
            OR EXISTS (
              SELECT 1 FROM receipt_lines rl
              JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
              WHERE rl.receipt_id = r.id
                AND rb.status IN ('approved', 'partial')
                AND rb.qty_actual_weighed IS NULL
            )`
      : `SELECT COUNT(*) AS count FROM receipts WHERE status != 'decided'`;
  const row = await env.DB.prepare(sql).first<{ count: number }>();
  return json({ count: row?.count ?? 0 });
}

export async function getReceipt(env: Env, role: Role, id: number): Promise<Response> {
  const receipt = await env.DB.prepare("SELECT * FROM receipts WHERE id = ?").bind(id).first();
  if (!receipt) return error("Receipt not found", 404);

  const lines = await env.DB.prepare("SELECT * FROM receipt_lines WHERE receipt_id = ?")
    .bind(id)
    .all<ReceiptLine>();

  const detail: ReceiptWithDetail = { ...(receipt as any), lines: [] };

  for (const line of lines.results ?? []) {
    const batches = await env.DB.prepare("SELECT * FROM receipt_batches WHERE receipt_line_id = ?")
      .bind(line.id)
      .all<ReceiptBatch>();
    const spec = line.material_code ? await getActiveSpec(env, line.material_code) : null;
    const batchesWithResults = [];
    for (const b of batches.results ?? []) {
      const test_results = role === "quality" || receipt.type !== "sample" ? await getBatchTestResults(env, b.id) : [];
      batchesWithResults.push({ ...redactBatchForRole(b, role, receipt.type as string), test_results });
    }
    detail.lines.push({ ...line, spec, batches: batchesWithResults });
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

  const conditions: string[] = [];
  const params: string[] = [];
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const receiptRows = await env.DB.prepare(`SELECT * FROM receipts ${where} ORDER BY created_at DESC LIMIT 200`)
    .bind(...params)
    .all<Receipt>();
  const receipts = receiptRows.results ?? [];
  if (!receipts.length) return json([]);

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
      `SELECT btr.*, sp.parameter_name, sp.unit, sp.param_type, sp.method, sp.min_value, sp.max_value
       FROM batch_test_results btr
       JOIN spec_parameters sp ON sp.id = btr.spec_parameter_id
       WHERE btr.batch_id IN (${ph})
       ORDER BY sp.sort_order`,
    batchIds
  );

  const materialCodes = lines.map((l) => l.material_code).filter((c): c is string => Boolean(c));
  const specsByMaterial = await getActiveSpecsForMaterials(env, materialCodes);

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
      const spec = line.material_code ? (specsByMaterial.get(line.material_code) ?? null) : null;
      const lineBatches = (batchesByLine.get(line.id) ?? []).map((b) => {
        const test_results = role === "quality" || receipt.type !== "sample" ? (testResultsByBatch.get(b.id) ?? []) : [];
        return { ...redactBatchForRole(b, role, receipt.type), test_results };
      });
      return { ...line, spec, batches: lineBatches };
    });
    return { ...receipt, lines: receiptLines };
  });

  return json(detailed);
}

export async function decideBatch(
  request: Request,
  env: Env,
  batchId: number
): Promise<Response> {
  const input = await request.json<BatchDecisionInput>();

  const batch = await env.DB.prepare(
    `SELECT rb.*, rl.id as line_id, rl.material_code, rl.material_name_text,
            rl.import_code, rl.import_scenario, rl.receipt_id, r.supplier_id, r.type as receipt_type
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

  const supplier = await env.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
    .bind(batch.supplier_id)
    .first<{ id: number; code: string; name: string }>();

  // Import code flags novelty of (material, name, supplier) and is assigned
  // once per line, on its first review, regardless of the decision outcome.
  let importCode = batch.import_code;
  let importScenario = batch.import_scenario;
  if (!importCode) {
    if (input.import_code) {
      importCode = input.import_code;
      importScenario = null;
    } else {
      const generated = await generateImportCode(env, batch.material_code, batch.material_name_text, supplier!);
      importCode = generated.code;
      importScenario = generated.scenario;
    }
    await env.DB.prepare("UPDATE receipt_lines SET import_code = ?, import_scenario = ? WHERE id = ?")
      .bind(importCode, importScenario, batch.line_id)
      .run();
  }

  let status: "approved" | "rejected" | "partial";
  let qtyAccepted: number | null = null;
  let qtyRejected: number | null = null;
  let internalBatchNo: string | null = null;

  if (input.decision === "reject") {
    status = "rejected";
    qtyRejected = batch.qty_as_received;
  } else {
    status = input.decision === "partial" ? "partial" : "approved";
    qtyAccepted = input.qty_accepted ?? batch.qty_as_received;
    qtyRejected = input.qty_rejected ?? Math.max(0, batch.qty_as_received - qtyAccepted);

    internalBatchNo =
      input.internal_batch_no ?? (await generateInternalBatchNo(env, supplier!, new Date()));
  }

  await env.DB.prepare(
    `UPDATE receipt_batches
     SET status = ?, qty_accepted = ?, qty_rejected = ?, internal_batch_no = ?,
         expiry_date = ?, production_date = ?, coa_remarks = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
     WHERE id = ?`
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
      batchId
    )
    .run();

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
      : `Batch ${batch.supplier_batch_no} ${status} — internal batch # ${internalBatchNo}`;
  await notify(env, "warehouse", "decision", summary, {
    receiptId: batch.receipt_id,
    batchId,
  });

  return json({
    id: batchId,
    status,
    internal_batch_no: internalBatchNo,
    import_code: importCode,
    import_scenario: importScenario,
  });
}

export async function recordTestResults(
  request: Request,
  env: Env,
  batchId: number
): Promise<Response> {
  const input = await request.json<RecordTestResultsInput>();

  const batch = await env.DB.prepare(
    `SELECT rb.*, rl.material_code
     FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     WHERE rb.id = ?`
  )
    .bind(batchId)
    .first<ReceiptBatch & { material_code: string | null }>();
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

  const spec = await getActiveSpec(env, batch.material_code);
  const validIds = new Set((spec?.parameters ?? []).map((p) => p.id));
  for (const r of input.results) {
    if (!validIds.has(r.spec_parameter_id)) {
      return error(`spec_parameter_id ${r.spec_parameter_id} is not on this material's active spec`, 400);
    }
    if (r.result !== "pass" && r.result !== "fail") {
      return error("Each test result needs result: 'pass' or 'fail'", 400);
    }
  }

  await env.DB.prepare("DELETE FROM batch_test_results WHERE batch_id = ?").bind(batchId).run();
  await env.DB.batch(
    input.results.map((r) =>
      env.DB.prepare(
        `INSERT INTO batch_test_results (batch_id, spec_parameter_id, measured_value, result)
         VALUES (?, ?, ?, ?)`
      ).bind(batchId, r.spec_parameter_id, r.measured_value ?? null, r.result)
    )
  );

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

  await env.DB.prepare("UPDATE receipt_batches SET qty_actual_weighed = ? WHERE id = ?")
    .bind(input.qty_actual_weighed, batchId)
    .run();

  return json({ id: batchId, qty_actual_weighed: input.qty_actual_weighed });
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

  const receipt = await env.DB.prepare("SELECT type, sample_sent_by FROM receipts WHERE id = ?")
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

  const line = await env.DB.prepare("SELECT * FROM receipt_lines WHERE id = ?")
    .bind(lineId)
    .first<ReceiptLine>();
  if (!line) return error("Receipt line not found", 404);
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
    spec = await getActiveSpec(env, materialCode);
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

    const specResult = await createSpecVersion(env, materialCode, specInput);
    if (!specResult.ok) return error(specResult.message, specResult.status);
    spec = specResult.spec;
  } else {
    return error("mode must be 'existing' or 'new'");
  }

  await env.DB.prepare("UPDATE receipt_lines SET material_code = ? WHERE id = ?")
    .bind(materialCode, lineId)
    .run();

  return json({ receipt_line_id: lineId, material_code: materialCode, spec });
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
