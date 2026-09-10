import type { Env, NotificationKind, Role, Supplier } from "./types";

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
}

/**
 * Resolve the batch-number pattern for a supplier (falling back to the
 * global default scheme where supplier_id IS NULL), atomically bump that
 * supplier's counter for the given period, and render the final string.
 *
 * The INSERT ... ON CONFLICT ... RETURNING round-trip is a single
 * statement, so two concurrent receipts for the same supplier/month can't
 * observe the same sequence value.
 */
export async function generateInternalBatchNo(
  env: Env,
  supplier: Supplier,
  periodDate: Date
): Promise<string> {
  // Prefer a supplier-specific scheme, falling back to the single
  // supplier_id IS NULL default row. UNION ALL without ORDER BY preserves
  // branch order in SQLite, so LIMIT 1 picks the supplier-specific row
  // when one exists.
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

  const pattern = scheme?.pattern_template ?? "{supplier_code}{MMYY}{seq:04d}";

  const mm = String(periodDate.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(periodDate.getUTCFullYear() % 100).padStart(2, "0");
  const periodKey = `${mm}${yy}`;

  const counterRow = await env.DB.prepare(
    `INSERT INTO batch_number_counters (supplier_id, period_key, current_sequence)
     VALUES (?, ?, 1)
     ON CONFLICT(supplier_id, period_key)
     DO UPDATE SET current_sequence = current_sequence + 1
     RETURNING current_sequence`
  )
    .bind(supplier.id, periodKey)
    .first<{ current_sequence: number }>();

  const sequence = counterRow?.current_sequence ?? 1;

  return renderBatchNoPattern(pattern, {
    supplier_code: supplier.code,
    MMYY: periodKey,
    seq: sequence,
  });
}

function renderBatchNoPattern(
  pattern: string,
  values: { supplier_code: string; MMYY: string; seq: number }
): string {
  return pattern.replace(/\{(\w+)(?::(\d+)d)?\}/g, (_match, key: string, padLenRaw?: string) => {
    if (key === "supplier_code") return values.supplier_code;
    if (key === "MMYY") return values.MMYY;
    if (key === "seq") {
      const padLen = padLenRaw ? parseInt(padLenRaw, 10) : 1;
      return String(values.seq).padStart(padLen, "0");
    }
    return "";
  });
}
