import { fetchByIds, resolveMaterialClassification } from "../db";
import { error, json } from "../http";
import { listSpecsForMaterial } from "./specs";
import type {
  Attachment,
  DossierBatchSummary,
  DossierImportEntry,
  DossierName,
  DossierStatusCounts,
  DossierSupplierMetrics,
  Env,
  Material,
  Supplier,
  SupplierCodeMetrics,
  SupplierRating,
} from "../types";

export async function listSuppliers(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM suppliers ORDER BY name").all();
  return json(rows.results ?? []);
}

export async function createSupplier(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{ code: string; name: string }>();
  if (!input.code || !input.name) return error("code and name are required");

  const row = await env.DB.prepare(
    "INSERT INTO suppliers (code, name) VALUES (?, ?) RETURNING id"
  )
    .bind(input.code, input.name)
    .first<{ id: number }>();
  return json({ id: row!.id }, 201);
}

export async function listMaterials(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM materials ORDER BY name").all();
  return json(rows.results ?? []);
}

export async function upsertMaterial(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{
    code: string;
    name: string;
    unit: string;
    requires_expiry?: boolean;
    type_code?: string | null;
    subtype_code?: string | null;
    function_code?: string | null;
  }>();
  if (!input.code || !input.name || !input.unit) {
    return error("code, name and unit are required");
  }

  const classification = await resolveMaterialClassification(env, input.type_code, input.subtype_code);
  if (!classification.ok) return error(classification.message, classification.status);
  input.type_code = classification.type_code;
  input.subtype_code = classification.subtype_code;

  if (input.function_code) {
    const fn = await env.DB.prepare("SELECT code FROM material_functions WHERE code = ?")
      .bind(input.function_code)
      .first();
    if (!fn) return error(`Unknown function code: ${input.function_code}`, 404);
  }

  await env.DB.prepare(
    `INSERT INTO materials (code, name, unit, requires_expiry, type_code, subtype_code, function_code)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, unit = excluded.unit,
       requires_expiry = excluded.requires_expiry, type_code = excluded.type_code,
       subtype_code = excluded.subtype_code, function_code = excluded.function_code`
  )
    .bind(
      input.code,
      input.name,
      input.unit,
      input.requires_expiry === false ? 0 : 1,
      input.type_code ?? null,
      input.subtype_code ?? null,
      input.function_code ?? null
    )
    .run();

  return json({ code: input.code }, 200);
}

export async function listMaterialFunctions(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM material_functions ORDER BY name").all();
  return json(rows.results ?? []);
}

export async function upsertMaterialFunction(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{ code: string; name: string }>();
  if (!input.code || !input.name) return error("code and name are required");

  await env.DB.prepare(
    `INSERT INTO material_functions (code, name) VALUES (?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name`
  )
    .bind(input.code, input.name)
    .run();

  return json({ code: input.code }, 200);
}

export async function listMaterialTypes(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM material_types ORDER BY name").all();
  return json(rows.results ?? []);
}

export async function upsertMaterialType(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{ code: string; name: string }>();
  if (!input.code || !input.name) return error("code and name are required");

  await env.DB.prepare(
    `INSERT INTO material_types (code, name) VALUES (?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name`
  )
    .bind(input.code, input.name)
    .run();

  return json({ code: input.code }, 200);
}

export async function listMaterialSubtypes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const typeCode = url.searchParams.get("type_code");
  const rows = await env.DB.prepare(
    `SELECT * FROM material_subtypes ${typeCode ? "WHERE type_code = ?" : ""} ORDER BY name`
  )
    .bind(...(typeCode ? [typeCode] : []))
    .all();
  return json(rows.results ?? []);
}

export async function upsertMaterialSubtype(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{ code: string; type_code: string; name: string }>();
  if (!input.code || !input.type_code || !input.name) {
    return error("code, type_code and name are required");
  }

  const type = await env.DB.prepare("SELECT code FROM material_types WHERE code = ?")
    .bind(input.type_code)
    .first();
  if (!type) return error(`Unknown type code: ${input.type_code}`, 404);

  await env.DB.prepare(
    `INSERT INTO material_subtypes (code, type_code, name) VALUES (?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET type_code = excluded.type_code, name = excluded.name`
  )
    .bind(input.code, input.type_code, input.name)
    .run();

  return json({ code: input.code }, 200);
}

/** Configure (or reconfigure) the internal batch-number pattern. Pass
 *  supplier_code to scope it to one supplier, or omit it to set the global
 *  default. Placeholders: {supplier_code}, {MMYY}, {seq:04d}. */
export async function setBatchNumberScheme(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{ supplier_code?: string; pattern_template: string }>();
  if (!input.pattern_template) return error("pattern_template is required");

  let supplierId: number | null = null;
  if (input.supplier_code) {
    const supplier = await env.DB.prepare("SELECT id FROM suppliers WHERE code = ?")
      .bind(input.supplier_code)
      .first<{ id: number }>();
    if (!supplier) return error(`Unknown supplier code: ${input.supplier_code}`, 404);
    supplierId = supplier.id;
  }

  // SQLite's UNIQUE index treats NULLs as distinct from one another, so
  // ON CONFLICT(supplier_id) can't dedupe the single global-default row
  // (supplier_id IS NULL). Handle that case with an explicit check.
  if (supplierId === null) {
    const existing = await env.DB.prepare(
      "SELECT id FROM batch_number_schemes WHERE supplier_id IS NULL"
    ).first<{ id: number }>();
    if (existing) {
      await env.DB.prepare("UPDATE batch_number_schemes SET pattern_template = ? WHERE id = ?")
        .bind(input.pattern_template, existing.id)
        .run();
    } else {
      await env.DB.prepare(
        "INSERT INTO batch_number_schemes (supplier_id, pattern_template) VALUES (NULL, ?)"
      )
        .bind(input.pattern_template)
        .run();
    }
  } else {
    await env.DB.prepare(
      `INSERT INTO batch_number_schemes (supplier_id, pattern_template)
       VALUES (?, ?)
       ON CONFLICT(supplier_id) DO UPDATE SET pattern_template = excluded.pattern_template`
    )
      .bind(supplierId, input.pattern_template)
      .run();
  }

  return json({ supplier_id: supplierId, pattern_template: input.pattern_template });
}

/** Two simple, system-wide ledger pools (mirroring Quality's current RMF/RMS
 *  labeling): RMF for any novel scenario, RMS for a regular repeat. Each is
 *  a plain prefix + running number, not scoped to a material or supplier.
 *  Placeholder: {seq:04d}. */
export async function listImportCodeSchemes(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM import_code_schemes ORDER BY kind").all();
  return json(rows.results ?? []);
}

export async function setImportCodeScheme(request: Request, env: Env, kind: string): Promise<Response> {
  if (kind !== "RMF" && kind !== "RMS") return error("kind must be RMF or RMS", 404);
  const input = await request.json<{ pattern_template: string }>();
  if (!input.pattern_template) return error("pattern_template is required");

  await env.DB.prepare("UPDATE import_code_schemes SET pattern_template = ? WHERE kind = ?")
    .bind(input.pattern_template, kind)
    .run();

  return json({ kind, pattern_template: input.pattern_template });
}

function passRate(approved: number, rejected: number): number | null {
  const decided = approved + rejected;
  return decided === 0 ? null : approved / decided;
}

/** Everything Quality knows about one material code: every name it's been
 *  received under, its full spec history, its import history split into
 *  novel (RMF) vs repeat (RMS) events with each event's batches/attachments,
 *  and pass-rate metrics overall and per supplier. */
export type MaterialDossier = Awaited<ReturnType<typeof getMaterialDossierData>>;

export async function getMaterialDossier(env: Env, materialCode: string): Promise<Response> {
  const dossier = await getMaterialDossierData(env, materialCode);
  if (!dossier) return error("Material not found", 404);
  return json(dossier);
}

export async function getMaterialDossierData(env: Env, materialCode: string) {
  const material = await env.DB.prepare("SELECT * FROM materials WHERE code = ?")
    .bind(materialCode)
    .first<Material>();
  if (!material) return null;

  const namesRows = await env.DB.prepare(
    `SELECT rl.material_name_text as name, COUNT(*) as count, MAX(r.received_at) as last_received_at
     FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id
     WHERE rl.material_code = ?
     GROUP BY rl.material_name_text
     ORDER BY count DESC`
  )
    .bind(materialCode)
    .all<DossierName>();

  const specs = await listSpecsForMaterial(env, materialCode);

  const [rmf, rms] = await Promise.all([
    getImportEntries(env, materialCode, "RMF"),
    getImportEntries(env, materialCode, "RMS"),
  ]);

  const overallRow = await env.DB.prepare(
    `SELECT COUNT(DISTINCT rl.id) as imports,
       SUM(CASE WHEN rb.status = 'approved' THEN 1 ELSE 0 END) as approved,
       SUM(CASE WHEN rb.status = 'rejected' THEN 1 ELSE 0 END) as rejected,
       SUM(CASE WHEN rb.status = 'partial' THEN 1 ELSE 0 END) as partial,
       SUM(CASE WHEN rb.status = 'pending' THEN 1 ELSE 0 END) as pending
     FROM receipt_lines rl
     LEFT JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     WHERE rl.material_code = ?`
  )
    .bind(materialCode)
    .first<Omit<DossierStatusCounts, "pass_rate">>();

  const overall: DossierStatusCounts = {
    imports: overallRow?.imports ?? 0,
    approved: overallRow?.approved ?? 0,
    rejected: overallRow?.rejected ?? 0,
    partial: overallRow?.partial ?? 0,
    pending: overallRow?.pending ?? 0,
    pass_rate: passRate(overallRow?.approved ?? 0, overallRow?.rejected ?? 0),
  };

  const bySupplierRows = await env.DB.prepare(
    `SELECT s.id as supplier_id, s.code as supplier_code, s.name as supplier_name,
       COUNT(DISTINCT rl.id) as imports,
       SUM(CASE WHEN rb.status = 'approved' THEN 1 ELSE 0 END) as approved,
       SUM(CASE WHEN rb.status = 'rejected' THEN 1 ELSE 0 END) as rejected,
       SUM(CASE WHEN rb.status = 'partial' THEN 1 ELSE 0 END) as partial,
       SUM(CASE WHEN rb.status = 'pending' THEN 1 ELSE 0 END) as pending
     FROM receipt_lines rl
     JOIN receipts r ON r.id = rl.receipt_id
     JOIN suppliers s ON s.id = r.supplier_id
     LEFT JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     WHERE rl.material_code = ?
     GROUP BY s.id
     ORDER BY imports DESC`
  )
    .bind(materialCode)
    .all<Omit<DossierSupplierMetrics, "pass_rate">>();

  const bySupplier: DossierSupplierMetrics[] = (bySupplierRows.results ?? []).map((row) => ({
    ...row,
    pass_rate: passRate(row.approved, row.rejected),
  }));

  return {
    material,
    names: namesRows.results ?? [],
    specs,
    rmf,
    rms,
    metrics: { overall, by_supplier: bySupplier },
  };
}

async function getImportEntries(
  env: Env,
  materialCode: string,
  prefix: "RMF" | "RMS"
): Promise<DossierImportEntry[]> {
  const lines = await env.DB.prepare(
    `SELECT rl.id as receipt_line_id, rl.import_code, rl.import_scenario, rl.material_name_text,
            r.id as receipt_id, r.received_at, s.id as supplier_id, s.code as supplier_code, s.name as supplier_name
     FROM receipt_lines rl
     JOIN receipts r ON r.id = rl.receipt_id
     JOIN suppliers s ON s.id = r.supplier_id
     WHERE rl.material_code = ? AND rl.import_code LIKE ?
     ORDER BY r.received_at DESC`
  )
    .bind(materialCode, `${prefix}%`)
    .all<Omit<DossierImportEntry, "batches" | "attachments">>();

  const lineRows = lines.results ?? [];
  if (!lineRows.length) return [];

  // Fetch batches/attachments for every line up front instead of one round
  // trip per line — a dossier with hundreds of import-code entries was
  // doing hundreds of sequential extra queries here.
  const lineIds = lineRows.map((l) => l.receipt_line_id);
  const [batchRows, attachmentRows] = await Promise.all([
    fetchByIds<DossierBatchSummary & { receipt_line_id: number }>(
      env,
      (ph) =>
        `SELECT id, receipt_line_id, supplier_batch_no, status, internal_batch_no, decided_at
         FROM receipt_batches WHERE receipt_line_id IN (${ph}) ORDER BY id`,
      lineIds
    ),
    fetchByIds<Attachment & { receipt_line_id: number }>(
      env,
      (ph) => `SELECT * FROM attachments WHERE receipt_line_id IN (${ph}) ORDER BY uploaded_at DESC`,
      lineIds
    ),
  ]);
  const batchesByLine = new Map<number, DossierBatchSummary[]>();
  for (const { receipt_line_id, ...rest } of batchRows) {
    if (!batchesByLine.has(receipt_line_id)) batchesByLine.set(receipt_line_id, []);
    batchesByLine.get(receipt_line_id)!.push(rest);
  }
  const attachmentsByLine = new Map<number, Attachment[]>();
  for (const a of attachmentRows) {
    if (!attachmentsByLine.has(a.receipt_line_id)) attachmentsByLine.set(a.receipt_line_id, []);
    attachmentsByLine.get(a.receipt_line_id)!.push(a);
  }

  return lineRows.map((line) => ({
    ...line,
    batches: batchesByLine.get(line.receipt_line_id) ?? [],
    attachments: attachmentsByLine.get(line.receipt_line_id) ?? [],
  }));
}

const RATING_LABELS: SupplierRating["label"][] = ["Unrated", "Very Poor", "Poor", "Fair", "Good", "Excellent"];

/** Stars are just the pass rate rounded onto a 0-5 scale — simple and
 *  transparent, not a hidden weighted score. Flagged low-volume under 5
 *  decided batches so a single lucky/unlucky batch doesn't read as proven
 *  performance. */
function rateSupplier(approved: number, rejected: number): SupplierRating {
  const decided = approved + rejected;
  if (decided === 0) return { stars: 0, label: "Unrated", low_volume: true };
  const stars = Math.round((approved / decided) * 5);
  return { stars, label: RATING_LABELS[stars], low_volume: decided < 5 };
}

/** Quality's read on one supplier: overall pass rate, a simple star rating,
 *  and a per-material-code breakdown so "which code do they supply best"
 *  is answerable at a glance rather than re-derived from raw receipts. */
export async function getSupplierAssessment(env: Env, supplierCode: string): Promise<Response> {
  const supplier = await env.DB.prepare("SELECT * FROM suppliers WHERE code = ?")
    .bind(supplierCode)
    .first<Supplier>();
  if (!supplier) return error("Supplier not found", 404);

  const overallRow = await env.DB.prepare(
    `SELECT COUNT(DISTINCT rl.id) as imports,
       COUNT(DISTINCT rl.material_code) as distinct_codes,
       SUM(CASE WHEN rb.status = 'approved' THEN 1 ELSE 0 END) as approved,
       SUM(CASE WHEN rb.status = 'rejected' THEN 1 ELSE 0 END) as rejected,
       SUM(CASE WHEN rb.status = 'partial' THEN 1 ELSE 0 END) as partial,
       SUM(CASE WHEN rb.status = 'pending' THEN 1 ELSE 0 END) as pending
     FROM receipts r
     JOIN receipt_lines rl ON rl.receipt_id = r.id
     LEFT JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     WHERE r.supplier_id = ?`
  )
    .bind(supplier.id)
    .first<Omit<DossierStatusCounts, "pass_rate"> & { distinct_codes: number }>();

  const overall = {
    imports: overallRow?.imports ?? 0,
    distinct_codes: overallRow?.distinct_codes ?? 0,
    approved: overallRow?.approved ?? 0,
    rejected: overallRow?.rejected ?? 0,
    partial: overallRow?.partial ?? 0,
    pending: overallRow?.pending ?? 0,
    pass_rate: passRate(overallRow?.approved ?? 0, overallRow?.rejected ?? 0),
  };

  const codeRows = await env.DB.prepare(
    `SELECT rl.material_code, COALESCE(m.name, '') as material_name,
       COUNT(DISTINCT rl.id) as imports,
       SUM(CASE WHEN rb.status = 'approved' THEN 1 ELSE 0 END) as approved,
       SUM(CASE WHEN rb.status = 'rejected' THEN 1 ELSE 0 END) as rejected,
       SUM(CASE WHEN rb.status = 'partial' THEN 1 ELSE 0 END) as partial,
       SUM(CASE WHEN rb.status = 'pending' THEN 1 ELSE 0 END) as pending
     FROM receipts r
     JOIN receipt_lines rl ON rl.receipt_id = r.id
     LEFT JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     LEFT JOIN materials m ON m.code = rl.material_code
     WHERE r.supplier_id = ? AND rl.material_code IS NOT NULL
     GROUP BY rl.material_code
     ORDER BY imports DESC`
  )
    .bind(supplier.id)
    .all<Omit<SupplierCodeMetrics, "pass_rate">>();

  const codes: SupplierCodeMetrics[] = (codeRows.results ?? []).map((row) => ({
    ...row,
    pass_rate: passRate(row.approved, row.rejected),
  }));

  const ranked = [...codes]
    .filter((c) => c.approved + c.rejected > 0)
    .sort((a, b) => (b.pass_rate ?? 0) - (a.pass_rate ?? 0) || b.imports - a.imports);
  const bestCode = ranked[0] ?? null;

  return json({
    supplier,
    overall,
    rating: rateSupplier(overall.approved, overall.rejected),
    codes,
    best_code: bestCode,
  });
}
