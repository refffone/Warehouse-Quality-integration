import { sendPushToRole } from "./push";
import type { Env, ImportScenario, NotificationKind, Role, Supplier } from "./types";

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

  return renderPattern(pattern, {
    supplier_code: supplier.code,
    MMYY: periodKey,
    seq: sequence,
  });
}

/** Shared placeholder renderer for both the batch-number and import-code
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

export interface ImportCodeResult {
  code: string;
  scenario: ImportScenario;
}

/**
 * Detects which of the three novelty scenarios applies to a
 * (material_code, material_name_text, supplier) combination based on
 * already-reviewed receipt lines (import_code IS NOT NULL) — this drives
 * which pool the code is drawn from: any "new_*" scenario draws from the
 * RMF pool, a "repeat" draws from RMS. Each pool is a single, simple,
 * system-wide running count (matching Quality's current RMF/RMS ledger),
 * not scoped to any one material or supplier — only the scenario
 * detection itself looks at material/supplier/name history.
 */
export async function generateImportCode(
  env: Env,
  materialCode: string,
  materialNameText: string,
  supplier: Supplier
): Promise<ImportCodeResult> {
  const nameKey = normalizeName(materialNameText);

  const seenMaterial = await env.DB.prepare(
    "SELECT 1 FROM receipt_lines WHERE material_code = ? AND import_code IS NOT NULL LIMIT 1"
  )
    .bind(materialCode)
    .first();

  const seenSupplier = seenMaterial
    ? await env.DB.prepare(
        `SELECT 1 FROM receipt_lines rl
         JOIN receipts r ON r.id = rl.receipt_id
         WHERE rl.material_code = ? AND r.supplier_id = ? AND rl.import_code IS NOT NULL
         LIMIT 1`
      )
        .bind(materialCode, supplier.id)
        .first()
    : null;

  const seenNameVariant = seenSupplier
    ? await env.DB.prepare(
        `SELECT 1 FROM receipt_lines rl
         JOIN receipts r ON r.id = rl.receipt_id
         WHERE rl.material_code = ? AND r.supplier_id = ? AND rl.import_code IS NOT NULL
           AND LOWER(TRIM(rl.material_name_text)) = ?
         LIMIT 1`
      )
        .bind(materialCode, supplier.id, nameKey)
        .first()
    : null;

  const scenario: ImportScenario = !seenMaterial
    ? "new_material"
    : !seenSupplier
      ? "new_supplier"
      : !seenNameVariant
        ? "new_name_variant"
        : "repeat";

  const kind = scenario === "repeat" ? "RMS" : "RMF";
  const code = await drawImportCode(env, kind);

  return { code, scenario };
}

async function drawImportCode(env: Env, kind: "RMF" | "RMS"): Promise<string> {
  const schemeRow = await env.DB.prepare("SELECT pattern_template FROM import_code_schemes WHERE kind = ?")
    .bind(kind)
    .first<{ pattern_template: string }>();
  const pattern = schemeRow?.pattern_template ?? `${kind}{seq:04d}`;

  const counterRow = await env.DB.prepare(
    `INSERT INTO import_code_counters (kind, current_sequence)
     VALUES (?, 1)
     ON CONFLICT(kind) DO UPDATE SET current_sequence = current_sequence + 1
     RETURNING current_sequence`
  )
    .bind(kind)
    .first<{ current_sequence: number }>();
  const sequence = counterRow?.current_sequence ?? 1;

  return renderPattern(pattern, { seq: sequence });
}
