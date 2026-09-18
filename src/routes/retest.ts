import { notify } from "../db";
import { error, json } from "../http";
import type { Env } from "../types";

// Retesting a decided batch (migration 0030): a new round on the same
// batch. The finished round is archived with its results; the batch goes
// back to Quality's To Do and its next decision becomes its status.

export const RETEST_REASONS = ["shelf_life", "complaint", "doubt", "other"] as const;
export type RetestReason = (typeof RETEST_REASONS)[number];

export const RETEST_REASON_LABELS: Record<RetestReason, string> = {
  shelf_life: "Shelf life ending",
  complaint: "Complaint",
  doubt: "Result in doubt",
  other: "Other",
};

interface StartRetestInput {
  reason: RetestReason;
  note?: string | null;
  on_hold?: boolean;
  started_by: string;
}

export async function startRetest(request: Request, env: Env, batchId: number): Promise<Response> {
  const input = await request.json<StartRetestInput>();
  if (!RETEST_REASONS.includes(input.reason)) return error("Pick a reason for the retest", 400);
  const startedBy = input.started_by?.trim();
  if (!startedBy) return error("started_by is required", 400);
  const note = input.note?.trim() || null;
  const onHold = input.on_hold === false ? 0 : 1;

  const batch = await env.DB.prepare(
    `SELECT rb.id, rb.status, rb.current_round, rb.supplier_batch_no, rl.receipt_id, r.received_by
     FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     JOIN receipts r ON r.id = rl.receipt_id
     WHERE rb.id = ?`
  )
    .bind(batchId)
    .first<{ id: number; status: string; current_round: number; supplier_batch_no: string; receipt_id: number; received_by: string }>();
  if (!batch) return error("Batch not found", 404);
  if (batch.status === "pending") return error("This batch hasn't been decided yet, so there's nothing to retest", 409);
  const round = batch.current_round;

  // One atomic batch: archive the finished round and its results, then
  // reopen the batch. The final UPDATE is guarded on the round, so two
  // simultaneous "Start retest" clicks can't both win.
  const [, , reopened] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO batch_rounds (batch_id, round_no, reason, note, started_by, started_at, status, concession,
         concession_reason, concession_approved_by, qty_accepted, qty_rejected, internal_batch_no, expiry_date,
         production_date, coa_remarks, decided_by, decided_at, tested_by, tested_at)
       SELECT id, current_round,
              CASE WHEN current_round = 1 THEN NULL ELSE retest_reason END,
              CASE WHEN current_round = 1 THEN NULL ELSE retest_note END,
              CASE WHEN current_round = 1 THEN NULL ELSE retest_started_by END,
              CASE WHEN current_round = 1 THEN NULL ELSE retest_started_at END,
              status, concession, concession_reason, concession_approved_by, qty_accepted, qty_rejected,
              internal_batch_no, expiry_date, production_date, coa_remarks, decided_by, decided_at, tested_by, tested_at
       FROM receipt_batches WHERE id = ? AND current_round = ? AND status != 'pending'`
    ).bind(batchId, round),
    env.DB.prepare("UPDATE batch_test_results SET round_no = ? WHERE batch_id = ? AND round_no IS NULL").bind(round, batchId),
    env.DB.prepare(
      `UPDATE receipt_batches
       SET status = 'pending', current_round = current_round + 1,
           retest_reason = ?, retest_note = ?, retest_started_by = ?, retest_started_at = CURRENT_TIMESTAMP, on_hold = ?,
           qty_accepted = NULL, qty_rejected = NULL, decided_by = NULL, decided_at = NULL,
           concession = 0, concession_reason = NULL, concession_approved_by = NULL, tested_by = NULL, tested_at = NULL
       WHERE id = ? AND current_round = ? AND status != 'pending'`
    ).bind(input.reason, note, startedBy, onHold, batchId, round),
    env.DB.prepare("UPDATE receipts SET status = 'pending' WHERE id = ?").bind(batch.receipt_id),
  ]);
  if (!reopened.meta.changes) return error("This batch was just changed by someone else — refresh and try again", 409);

  if (onHold && batch.received_by === "warehouse") {
    await notify(env, "warehouse", "decision", `Batch ${batch.supplier_batch_no} is on hold for a retest`, {
      receiptId: batch.receipt_id,
      batchId,
    });
  }
  return json({ id: batchId, current_round: round + 1, on_hold: onHold === 1 }, 201);
}

/** Every round of a batch, oldest first: the archived ones and the current. */
export async function listRounds(env: Env, batchId: number): Promise<Response> {
  const current = await env.DB.prepare(
    `SELECT id, current_round AS round_no, retest_reason AS reason, retest_note AS note, retest_started_by AS started_by,
            retest_started_at AS started_at, status, concession, decided_by, decided_at, expiry_date, on_hold
     FROM receipt_batches WHERE id = ?`
  )
    .bind(batchId)
    .first<Record<string, unknown>>();
  if (!current) return error("Batch not found", 404);
  const archived = await env.DB.prepare(
    `SELECT round_no, reason, note, started_by, started_at, status, concession, decided_by, decided_at, expiry_date, 0 AS on_hold
     FROM batch_rounds WHERE batch_id = ? ORDER BY round_no`
  )
    .bind(batchId)
    .all<Record<string, unknown>>();
  // Which spec version each round was judged against, from its results.
  const specs = await env.DB.prepare(
    `SELECT COALESCE(btr.round_no, 0) AS round_key, MAX(s.version) AS version, MAX(s.receipt_line_id IS NOT NULL) AS one_time
     FROM batch_test_results btr
     JOIN spec_parameters sp ON sp.id = btr.spec_parameter_id
     JOIN specs s ON s.id = sp.spec_id
     WHERE btr.batch_id = ? GROUP BY round_key`
  )
    .bind(batchId)
    .all<{ round_key: number; version: number; one_time: number }>();
  const specFor = (key: number) => specs.results?.find((s) => s.round_key === key) ?? null;
  const currentKey = 0;
  const rounds = [
    ...(archived.results ?? []).map((r) => ({ ...r, current: false, spec: specFor(Number(r.round_no)) })),
    { ...current, id: undefined, current: true, spec: specFor(currentKey) },
  ];
  return json(rounds);
}
