import { sendPushToRole } from "./push";
import type { CodePool, Env, ImportScenario, NotificationKind, Role, Supplier, SupplyKind } from "./types";

/** D1 caps bound parameters per statement, so a `WHERE col IN (...)` over
 *  an arbitrarily long id list needs chunking. Runs one query per chunk
 *  (in parallel) instead of one query per id — the batching fix for every
 *  spot in this app that used to loop a single-id query per row. */
export async function fetchByIds<T>(
  env: Env,
  buildSql: (placeholders: string) => string,
  ids: Array<string | number>,
  chunkSize = 100
): Promise<T[]> {
  if (!ids.length) return [];
  const chunks: Array<string | number>[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) chunks.push(ids.slice(i, i + chunkSize));

  const results = await Promise.all(
    chunks.map((chunk) => {
      const placeholders = chunk.map(() => "?").join(",");
      return env.DB.prepare(buildSql(placeholders))
        .bind(...chunk)
        .all<T>();
    })
  );
  return results.flatMap((r) => r.results ?? []);
}

export async function getSupplierByCode(env: Env, code: string): Promise<Supplier | null> {
  const row = await env.DB.prepare("SELECT * FROM suppliers WHERE code = ?")
    .bind(code)
    .first<Supplier>();
  return row ?? null;
}

export type ClassificationResult =
  | { ok: true; type_code: string | null; subtype_code: string | null }
  | { ok: false; message: string; status: number };

/** Validates a material's Type/Subtype pair against the Quality-managed
 *  lookup tables: an unknown code is rejected, and a subtype's own type
 *  always wins (a mismatched type_code is an error, not silently ignored).
 *  Shared by material creation (masterdata.ts) and associate-code's
 *  "new material" path (receipts.ts) so both enforce the same rule. */
export async function resolveMaterialClassification(
  env: Env,
  typeCode: string | null | undefined,
  subtypeCode: string | null | undefined
): Promise<ClassificationResult> {
  if (subtypeCode) {
    const subtype = await env.DB.prepare("SELECT type_code FROM material_subtypes WHERE code = ?")
      .bind(subtypeCode)
      .first<{ type_code: string }>();
    if (!subtype) return { ok: false, message: `Unknown subtype code: ${subtypeCode}`, status: 404 };
    if (typeCode && typeCode !== subtype.type_code) {
      return {
        ok: false,
        message: `Subtype ${subtypeCode} belongs to type ${subtype.type_code}, not ${typeCode}`,
        status: 400,
      };
    }
    return { ok: true, type_code: subtype.type_code, subtype_code: subtypeCode };
  }
  if (typeCode) {
    const type = await env.DB.prepare("SELECT code FROM material_types WHERE code = ?")
      .bind(typeCode)
      .first();
    if (!type) return { ok: false, message: `Unknown type code: ${typeCode}`, status: 404 };
  }
  return { ok: true, type_code: typeCode ?? null, subtype_code: null };
}

export async function notify(
  env: Env,
  targetRole: Role,
  kind: NotificationKind,
  message: string,
  opts: { receiptId?: number; batchId?: number } = {}
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notification_events (target_role, receipt_id, batch_id, kind, message)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(targetRole, opts.receiptId ?? null, opts.batchId ?? null, kind, message)
    .run();

  // Fire-and-forget: a push-service outage or missing VAPID config must
  // never break the caller's own request (e.g. registering a receipt).
  await sendPushToRole(env, targetRole, {
    title: kind === "new_receipt" ? "New receipt" : kind === "decision" ? "Decision recorded" : "Expiry alert",
    body: message,
    kind,
    receiptId: opts.receiptId ?? null,
  }).catch(() => {});
}

export const DEFAULT_BATCH_PATTERN = "{supplier_abbr}{seq:04d}{YY}";

/** Which counter period a batch-number pattern implies: a pattern with a
 *  month in it restarts monthly, one with only a year restarts yearly, and
 *  one with no date at all never restarts. */
function batchPeriodKey(pattern: string, date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getUTCFullYear());
  if (/\{MM(YY)?\}/.test(pattern)) return `${mm}${yyyy.slice(2)}`;
  if (/\{YY(YY)?\}/.test(pattern)) return yyyy;
  return "all";
}

/**
 * Next internal batch number for one material from one supplier, matching
 * the Access log's format (MHND000926 = abbreviation MHND, the 9th batch of
 * this material from MHND this year, 2026).
 *
 * The pattern comes from the supplier's own scheme, else the global default
 * (supplier_id IS NULL), else DEFAULT_BATCH_PATTERN. The counter is keyed
 * by (abbreviation, material, period) — Access counts per abbreviation, and
 * two suppliers sharing one abbreviation share its sequence. A supplier
 * with no abbreviation yet falls back to its own id as the scope and its
 * code as the prefix.
 *
 * The same number can exist on a different material, but never twice on
 * the same one: if a drawn number is already taken for this material (a
 * counter seeded too low, or a number typed in by hand earlier), the next
 * one is drawn instead.
 */
export async function generateInternalBatchNo(
  env: Env,
  supplier: Supplier,
  materialCode: string,
  periodDate: Date
): Promise<string> {
  const scheme = await env.DB.prepare(
    `SELECT pattern_template FROM batch_number_schemes
     WHERE supplier_id = ?
     UNION ALL
     SELECT pattern_template FROM batch_number_schemes
     WHERE supplier_id IS NULL
     LIMIT 1`
  )
    .bind(supplier.id)
    .first<{ pattern_template: string }>();
  const pattern = scheme?.pattern_template ?? DEFAULT_BATCH_PATTERN;

  const abbr = supplier.abbreviation?.trim().toUpperCase() || null;
  const scope = abbr ?? `#${supplier.id}`;
  const periodKey = batchPeriodKey(pattern, periodDate);
  const mm = String(periodDate.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = String(periodDate.getUTCFullYear());

  for (let attempt = 0; attempt < 50; attempt++) {
    const counterRow = await env.DB.prepare(
      `INSERT INTO batch_seq_counters (scope, material_code, period_key, current_sequence)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(scope, material_code, period_key)
       DO UPDATE SET current_sequence = current_sequence + 1
       RETURNING current_sequence`
    )
      .bind(scope, materialCode, periodKey)
      .first<{ current_sequence: number }>();

    const candidate = renderPattern(pattern, {
      supplier_abbr: abbr ?? supplier.code,
      supplier_code: supplier.code,
      material_code: materialCode,
      MMYY: `${mm}${yyyy.slice(2)}`,
      MM: mm,
      YY: yyyy.slice(2),
      YYYY: yyyy,
      seq: counterRow?.current_sequence ?? 1,
    });
    if (!(await isInternalBatchNoTaken(env, materialCode, candidate))) return candidate;
  }
  throw new Error("Couldn't find a free internal batch number — check this supplier's batch-number counter");
}

/** True if `internalBatchNo` is already used by a batch of `materialCode`,
 *  optionally ignoring one batch (the one being decided). */
export async function isInternalBatchNoTaken(
  env: Env,
  materialCode: string,
  internalBatchNo: string,
  exceptBatchId?: number
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     WHERE rl.material_code = ? AND rb.internal_batch_no = ? AND rb.id != ?
     LIMIT 1`
  )
    .bind(materialCode, internalBatchNo, exceptBatchId ?? -1)
    .first();
  return row !== null;
}

/** Shared placeholder renderer for both the batch-number and code-pool
 *  patterns: `{key}` substitutes a value verbatim, `{key:04d}` zero-pads a
 *  numeric value to that width. */
function renderPattern(pattern: string, values: Record<string, string | number>): string {
  return pattern.replace(/\{(\w+)(?::(\d+)d)?\}/g, (_match, key: string, padLenRaw?: string) => {
    const value = values[key];
    if (value === undefined) return "";
    if (typeof value === "number" && padLenRaw) {
      return String(value).padStart(parseInt(padLenRaw, 10), "0");
    }
    return String(value);
  });
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export const POOL_FOR_KIND: Record<SupplyKind, CodePool> = {
  sample: "RMS",
  first: "RMF",
  regular: "RMP",
};

export interface LineClassification {
  kind: SupplyKind;
  scenario: ImportScenario | null;
}

/**
 * First supply vs regular supply for a coded supply line, from earlier
 * supply lines in *other* receipts (samples don't count — in Access a
 * sample typically comes before the first supply). Any of the three novelty
 * scenarios is a first supply (RMF); a plain repeat is a regular supply
 * (RMP). The scenario itself is kept on the line for display.
 */
export async function classifySupplyLine(
  env: Env,
  materialCode: string,
  materialNameText: string,
  supplierId: number,
  receiptId: number
): Promise<LineClassification> {
  const history = await env.DB.prepare(
    `SELECT
       COUNT(*) AS seen_material,
       COALESCE(MAX(CASE WHEN r.supplier_id = ? THEN 1 ELSE 0 END), 0) AS seen_supplier,
       COALESCE(MAX(CASE WHEN r.supplier_id = ? AND LOWER(TRIM(rl.material_name_text)) = ? THEN 1 ELSE 0 END), 0) AS seen_name
     FROM receipt_lines rl
     JOIN receipts r ON r.id = rl.receipt_id
     WHERE rl.material_code = ? AND rl.receipt_id != ? AND rl.supply_kind IN ('first', 'regular')`
  )
    .bind(supplierId, supplierId, normalizeName(materialNameText), materialCode, receiptId)
    .first<{ seen_material: number; seen_supplier: number; seen_name: number }>();

  const scenario: ImportScenario = !history?.seen_material
    ? "new_material"
    : !history.seen_supplier
      ? "new_supplier"
      : !history.seen_name
        ? "new_name_variant"
        : "repeat";
  return { kind: scenario === "repeat" ? "regular" : "first", scenario };
}

/**
 * Draws the next code from a pool (RMS / RMF / RMP). The UPDATE ...
 * RETURNING is one statement, so two concurrent draws can't get the same
 * number. A number already used on another line (e.g. Quality set the
 * counter back, or typed that code by hand) is skipped.
 */
export async function drawPoolCode(env: Env, pool: CodePool): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await env.DB.prepare(
      `UPDATE code_pools SET current_sequence = current_sequence + 1
       WHERE kind = ?
       RETURNING current_sequence, pattern_template`
    )
      .bind(pool)
      .first<{ current_sequence: number; pattern_template: string }>();
    if (!row) throw new Error(`Code pool ${pool} isn't configured`);
    const code = renderPattern(row.pattern_template, { seq: row.current_sequence });
    if (!(await isImportCodeTaken(env, code))) return code;
  }
  throw new Error(`Couldn't find a free ${pool} code — check the ${pool} counter under Numbering Schemes`);
}

export type ReceiptNumberSeries = "warehouse" | "quality_sample";

/** The next receipt number: the warehouse's addition-note serial (2303,
 *  2304, ...) or Quality's own sample series (QS-0001, ...). Numbers
 *  already on a receipt — including ones the Access history used — are
 *  skipped, so a number is never issued twice. */
export async function nextReceiptNo(env: Env, series: ReceiptNumberSeries): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const row = await env.DB.prepare(
      `UPDATE receipt_number_series SET current_sequence = current_sequence + 1
       WHERE series = ?
       RETURNING current_sequence, prefix, width`
    )
      .bind(series)
      .first<{ current_sequence: number; prefix: string; width: number }>();
    if (!row) throw new Error(`Receipt number series ${series} isn't configured`);
    const receiptNo = `${row.prefix}${String(row.current_sequence).padStart(row.width, "0")}`;
    const taken = await env.DB.prepare("SELECT 1 FROM receipts WHERE receipt_no = ? LIMIT 1").bind(receiptNo).first();
    if (!taken) return receiptNo;
  }
  throw new Error(`Couldn't find a free ${series} receipt number`);
}

export async function isImportCodeTaken(env: Env, code: string, exceptLineId?: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM receipt_lines WHERE import_code = ? AND id != ? LIMIT 1")
    .bind(code, exceptLineId ?? -1)
    .first();
  return row !== null;
}
