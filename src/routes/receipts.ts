import { generateInternalBatchNo, getSupplierByCode, notify } from "../db";
import { error, json } from "../http";
import type {
  BatchDecisionInput,
  Env,
  FinalizeWeightInput,
  NewReceiptInput,
  ReceiptBatch,
  ReceiptLine,
  Role,
} from "../types";

/** Full receipt payload assembled from the three tables for API responses. */
interface ReceiptWithDetail {
  id: number;
  type: string;
  received_at: string;
  supplier_id: number;
  created_by: string;
  status: string;
  created_at: string;
  lines: Array<ReceiptLine & { batches: Partial<ReceiptBatch>[] }>;
}

export async function createReceipt(request: Request, env: Env): Promise<Response> {
  const input = await request.json<NewReceiptInput>();

  if (!input.lines?.length) {
    return error("A receipt needs at least one line");
  }
  const supplier = await getSupplierByCode(env, input.supplier_code);
  if (!supplier) return error(`Unknown supplier code: ${input.supplier_code}`, 404);

  const receiptRow = await env.DB.prepare(
    `INSERT INTO receipts (type, received_at, supplier_id, created_by, status)
     VALUES (?, ?, ?, ?, 'pending')
     RETURNING id`
  )
    .bind(input.type, input.received_at, supplier.id, input.created_by)
    .first<{ id: number }>();
  const receiptId = receiptRow!.id;

  for (const line of input.lines) {
    if (!line.batches?.length) return error("Each line needs at least one batch");

    const lineRow = await env.DB.prepare(
      `INSERT INTO receipt_lines (receipt_id, material_code, material_name_text, unit)
       VALUES (?, ?, ?, ?)
       RETURNING id`
    )
      .bind(receiptId, line.material_code ?? null, line.material_name_text, line.unit)
      .first<{ id: number }>();
    const lineId = lineRow!.id;

    for (const batch of line.batches) {
      await env.DB.prepare(
        `INSERT INTO receipt_batches (receipt_line_id, supplier_batch_no, qty_as_received, status)
         VALUES (?, ?, ?, 'pending')`
      )
        .bind(lineId, batch.supplier_batch_no, batch.qty_as_received)
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

export async function listReceipts(request: Request, env: Env, role: Role): Promise<Response> {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");

  const rows = await env.DB.prepare(
    `SELECT * FROM receipts ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 200`
  )
    .bind(...(status ? [status] : []))
    .all();

  return json(rows.results?.map((r) => redactReceiptSummaryForRole(r, role)) ?? []);
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
    detail.lines.push({
      ...line,
      batches: (batches.results ?? []).map((b) => redactBatchForRole(b, role, receipt.type as string)),
    });
  }

  return json(detail);
}

export async function decideBatch(
  request: Request,
  env: Env,
  batchId: number
): Promise<Response> {
  const input = await request.json<BatchDecisionInput>();

  const batch = await env.DB.prepare(
    `SELECT rb.*, rl.receipt_id, r.supplier_id, r.type as receipt_type
     FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     JOIN receipts r ON r.id = rl.receipt_id
     WHERE rb.id = ?`
  )
    .bind(batchId)
    .first<ReceiptBatch & { receipt_id: number; supplier_id: number; receipt_type: string }>();
  if (!batch) return error("Batch not found", 404);

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

    const supplier = await env.DB.prepare("SELECT * FROM suppliers WHERE id = ?")
      .bind(batch.supplier_id)
      .first<{ id: number; code: string; name: string }>();
    internalBatchNo =
      input.internal_batch_no ?? (await generateInternalBatchNo(env, supplier!, new Date()));
  }

  await env.DB.prepare(
    `UPDATE receipt_batches
     SET status = ?, qty_accepted = ?, qty_rejected = ?, internal_batch_no = ?,
         expiry_date = ?, coa_remarks = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(
      status,
      qtyAccepted,
      qtyRejected,
      internalBatchNo,
      input.expiry_date ?? null,
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

  return json({ id: batchId, status, internal_batch_no: internalBatchNo });
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

  await env.DB.prepare("UPDATE receipt_batches SET qty_actual_weighed = ? WHERE id = ?")
    .bind(input.qty_actual_weighed, batchId)
    .run();

  return json({ id: batchId, qty_actual_weighed: input.qty_actual_weighed });
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
