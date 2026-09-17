import { fetchByIds, resolveMaterialClassification } from "../db";
import { error, json } from "../http";
import { buildTemplateXlsx, parseImportBoolean, parseXlsxRows, templateResponse } from "../xlsxImport";
import { isUploadedFile } from "./attachments";
import { listSpecsForMaterial } from "./specs";
import type {
  Attachment,
  DossierBatchSummary,
  DossierImportEntry,
  DossierName,
  DossierStatusCounts,
  DossierSupplierMetrics,
  Env,
  ImportRowResult,
  ImportSummary,
  Material,
  Role,
  Supplier,
  SupplierCodeMetrics,
  SupplierRating,
  SupplierWeightVariance,
  SupplyKind,
} from "../types";

export async function listSuppliers(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT s.*, COUNT(r.id) as total_receipts
     FROM suppliers s
     LEFT JOIN receipts r ON r.supplier_id = s.id
     GROUP BY s.id
     ORDER BY s.name`
  ).all();
  return json(rows.results ?? []);
}

export async function createSupplier(request: Request, env: Env, role: Role): Promise<Response> {
  const input = await request.json<{ code: string; name: string; abbreviation?: string | null }>();
  if (!input.code || !input.name) return error("code and name are required");
  const abbreviation = normalizeAbbreviation(input.abbreviation);
  if (abbreviation && role !== "quality") {
    return error("Only quality can set a supplier's abbreviation", 403);
  }
  if (abbreviation && !isValidAbbreviation(abbreviation)) {
    return error("Abbreviation must be 1-10 letters or digits", 400);
  }

  const taken = await env.DB.prepare("SELECT 1 FROM suppliers WHERE code = ?").bind(input.code).first();
  if (taken) return error(`Supplier code ${input.code} already exists`, 409);

  const row = await env.DB.prepare(
    "INSERT INTO suppliers (code, name, abbreviation) VALUES (?, ?, ?) RETURNING id"
  )
    .bind(input.code, input.name, abbreviation)
    .first<{ id: number }>();
  return json({ id: row!.id }, 201);
}

/** Batch-number prefixes are upper-case letters/digits (MHND, ALMAS). */
function normalizeAbbreviation(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toUpperCase();
  return v || null;
}

function isValidAbbreviation(value: string): boolean {
  return /^[A-Z0-9]{1,10}$/.test(value);
}

/** Quality edits a supplier's name and/or batch-number abbreviation. */
export async function updateSupplier(request: Request, env: Env, code: string): Promise<Response> {
  const input = await request.json<{ name?: string; abbreviation?: string | null }>();
  const supplier = await env.DB.prepare("SELECT id FROM suppliers WHERE code = ?").bind(code).first<{ id: number }>();
  if (!supplier) return error(`Unknown supplier code: ${code}`, 404);

  if (input.name !== undefined && !input.name.trim()) return error("name can't be blank", 400);
  const abbreviation = input.abbreviation === undefined ? undefined : normalizeAbbreviation(input.abbreviation);
  if (abbreviation && !isValidAbbreviation(abbreviation)) {
    return error("Abbreviation must be 1-10 letters or digits", 400);
  }

  await env.DB.prepare(
    `UPDATE suppliers SET
       name = COALESCE(?, name),
       abbreviation = CASE WHEN ? THEN ? ELSE abbreviation END
     WHERE id = ?`
  )
    .bind(input.name?.trim() ?? null, abbreviation !== undefined ? 1 : 0, abbreviation ?? null, supplier.id)
    .run();
  return json({ code, name: input.name, abbreviation });
}

export async function suppliersImportTemplate(env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT code, name, abbreviation FROM suppliers ORDER BY name").all<{
    code: string;
    name: string;
    abbreviation: string | null;
  }>();
  const bytes = buildTemplateXlsx(
    [
      { key: "code", header: "Code" },
      { key: "name", header: "Name" },
      { key: "abbreviation", header: "Abbreviation" },
    ],
    rows.results ?? []
  );
  return templateResponse(bytes, "suppliers-import-template.xlsx");
}

/** `commit: false` is a dry run — validates and reports what *would*
 *  happen without writing anything, so the UI can show a preview before
 *  the client commits to it. A commit is refused outright (400) while any
 *  row still has an error, rather than silently applying the valid rows
 *  and skipping the rest — so "did my import work?" always has a clean
 *  yes/no answer instead of "partially." */
export async function importSuppliers(request: Request, env: Env, role: Role, commit: boolean): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  if (!isUploadedFile(file)) return error("file is required", 400);

  let parsedRows: Record<string, string>[];
  try {
    parsedRows = parseXlsxRows(await file.arrayBuffer());
  } catch {
    return error("Couldn't read that file — make sure it's a valid .xlsx export", 400);
  }

  const existingRows = await env.DB.prepare("SELECT code FROM suppliers").all<{ code: string }>();
  const existingCodes = new Set((existingRows.results ?? []).map((r) => r.code));
  const seenInFile = new Set<string>();

  const results: ImportRowResult[] = [];
  const toWrite: Array<{ code: string; name: string; abbreviation: string | null }> = [];

  parsedRows.forEach((row, i) => {
    const rowNum = i + 1;
    const code = (row["Code"] ?? "").trim();
    const name = (row["Name"] ?? "").trim();

    if (!code || !name) {
      results.push({ row: rowNum, code: code || "(blank)", action: "error", message: "Code and Name are required" });
      return;
    }
    if (seenInFile.has(code)) {
      results.push({ row: rowNum, code, action: "error", message: "Duplicate code — already on an earlier row in this file" });
      return;
    }
    // A blank Abbreviation leaves any existing one alone. Only Quality can
    // set one, since it decides Quality's internal batch numbers.
    const abbreviation = normalizeAbbreviation(row["Abbreviation"]);
    if (abbreviation && role !== "quality") {
      results.push({ row: rowNum, code, action: "error", message: "Only Quality can set supplier abbreviations — leave that column blank" });
      return;
    }
    if (abbreviation && !isValidAbbreviation(abbreviation)) {
      results.push({ row: rowNum, code, action: "error", message: "Abbreviation must be 1-10 letters or digits" });
      return;
    }
    seenInFile.add(code);
    results.push({ row: rowNum, code, action: existingCodes.has(code) ? "update" : "insert" });
    toWrite.push({ code, name, abbreviation });
  });

  const errors = results.filter((r) => r.action === "error").length;
  if (commit && errors > 0) return error("Fix the rows with errors before importing", 400);

  if (commit && toWrite.length > 0) {
    await env.DB.batch(
      toWrite.map((r) =>
        env.DB.prepare(
          `INSERT INTO suppliers (code, name, abbreviation) VALUES (?, ?, ?)
           ON CONFLICT(code) DO UPDATE SET
             name = excluded.name,
             abbreviation = COALESCE(excluded.abbreviation, suppliers.abbreviation)`
        ).bind(r.code, r.name, r.abbreviation)
      )
    );
  }

  const summary: ImportSummary = {
    rows: results,
    inserts: results.filter((r) => r.action === "insert").length,
    updates: results.filter((r) => r.action === "update").length,
    errors,
    committed: commit,
  };
  return json(summary);
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

export async function materialsImportTemplate(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT code, name, function_code, type_code, subtype_code, unit, requires_expiry FROM materials ORDER BY name"
  ).all<{
    code: string;
    name: string;
    function_code: string | null;
    type_code: string | null;
    subtype_code: string | null;
    unit: string;
    requires_expiry: number;
  }>();
  const bytes = buildTemplateXlsx(
    [
      { key: "code", header: "Code" },
      { key: "name", header: "Name" },
      { key: "function_code", header: "Function" },
      { key: "type_code", header: "Type" },
      { key: "subtype_code", header: "Subtype" },
      { key: "unit", header: "Unit" },
      { key: "requires_expiry", header: "Requires Expiry" },
    ],
    (rows.results ?? []).map((r) => ({ ...r, requires_expiry: r.requires_expiry ? "Yes" : "No" }))
  );
  return templateResponse(bytes, "materials-import-template.xlsx");
}

/** Same dry-run/commit shape as importSuppliers, but with an extra layer
 *  of validation: Type/Subtype/Function are foreign keys into Quality's
 *  own classification tables (src/routes/masterdata.ts's Codes screens),
 *  not free text, so a row referencing a code that doesn't exist there is
 *  an error rather than silently creating an orphaned reference. All
 *  three lookup tables are small (Quality manages them by hand), so
 *  they're loaded once up front instead of a query per row. */
export async function importMaterials(request: Request, env: Env, commit: boolean): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  if (!isUploadedFile(file)) return error("file is required", 400);

  let parsedRows: Record<string, string>[];
  try {
    parsedRows = parseXlsxRows(await file.arrayBuffer());
  } catch {
    return error("Couldn't read that file — make sure it's a valid .xlsx export", 400);
  }

  const [existingRows, typeRows, subtypeRows, functionRows] = await Promise.all([
    env.DB.prepare("SELECT code FROM materials").all<{ code: string }>(),
    env.DB.prepare("SELECT code FROM material_types").all<{ code: string }>(),
    env.DB.prepare("SELECT code, type_code FROM material_subtypes").all<{ code: string; type_code: string }>(),
    env.DB.prepare("SELECT code FROM material_functions").all<{ code: string }>(),
  ]);
  const existingCodes = new Set((existingRows.results ?? []).map((r) => r.code));
  const validTypes = new Set((typeRows.results ?? []).map((r) => r.code));
  const subtypeToType = new Map((subtypeRows.results ?? []).map((r) => [r.code, r.type_code]));
  const validFunctions = new Set((functionRows.results ?? []).map((r) => r.code));

  const seenInFile = new Set<string>();
  const results: ImportRowResult[] = [];
  const toWrite: Array<{
    code: string;
    name: string;
    unit: string;
    requires_expiry: number;
    type_code: string | null;
    subtype_code: string | null;
    function_code: string | null;
  }> = [];

  parsedRows.forEach((row, i) => {
    const rowNum = i + 1;
    const code = (row["Code"] ?? "").trim();
    const name = (row["Name"] ?? "").trim();
    const unit = (row["Unit"] ?? "").trim();
    const functionCode = (row["Function"] ?? "").trim() || null;
    const typeCode = (row["Type"] ?? "").trim() || null;
    const subtypeCode = (row["Subtype"] ?? "").trim() || null;
    const requiresExpiry = parseImportBoolean(row["Requires Expiry"] ?? "");

    const fail = (message: string) => results.push({ row: rowNum, code: code || "(blank)", action: "error", message });

    if (!code || !name || !unit) return fail("Code, Name and Unit are required");
    if (seenInFile.has(code)) return fail("Duplicate code — already on an earlier row in this file");
    if (subtypeCode && !subtypeToType.has(subtypeCode)) return fail(`Unknown subtype code: ${subtypeCode}`);
    if (subtypeCode && typeCode && subtypeToType.get(subtypeCode) !== typeCode) {
      return fail(`Subtype ${subtypeCode} belongs to type ${subtypeToType.get(subtypeCode)}, not ${typeCode}`);
    }
    if (!subtypeCode && typeCode && !validTypes.has(typeCode)) return fail(`Unknown type code: ${typeCode}`);
    if (functionCode && !validFunctions.has(functionCode)) return fail(`Unknown function code: ${functionCode}`);

    seenInFile.add(code);
    results.push({ row: rowNum, code, action: existingCodes.has(code) ? "update" : "insert" });
    toWrite.push({
      code,
      name,
      unit,
      requires_expiry: requiresExpiry ? 1 : 0,
      type_code: subtypeCode ? subtypeToType.get(subtypeCode)! : typeCode,
      subtype_code: subtypeCode,
      function_code: functionCode,
    });
  });

  const errors = results.filter((r) => r.action === "error").length;
  if (commit && errors > 0) return error("Fix the rows with errors before importing", 400);

  if (commit && toWrite.length > 0) {
    await env.DB.batch(
      toWrite.map((r) =>
        env.DB.prepare(
          `INSERT INTO materials (code, name, unit, requires_expiry, type_code, subtype_code, function_code)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(code) DO UPDATE SET name = excluded.name, unit = excluded.unit,
             requires_expiry = excluded.requires_expiry, type_code = excluded.type_code,
             subtype_code = excluded.subtype_code, function_code = excluded.function_code`
        ).bind(r.code, r.name, r.unit, r.requires_expiry, r.type_code, r.subtype_code, r.function_code)
      )
    );
  }

  const summary: ImportSummary = {
    rows: results,
    inserts: results.filter((r) => r.action === "insert").length,
    updates: results.filter((r) => r.action === "update").length,
    errors,
    committed: commit,
  };
  return json(summary);
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
 *  default. Placeholders: {supplier_abbr}, {supplier_code}, {material_code},
 *  {YY}, {YYYY}, {MM}, {MMYY}, {seq:04d}. The counter restarts monthly if the
 *  pattern has a month in it, yearly if it only has a year. */
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

/** The three code pools, matching the Access log: RMS for samples, RMF for
 *  first supplies, RMP for regular supplies. Each is a pattern plus a plain
 *  running number (placeholder: {seq:04d}), not scoped to any material or
 *  supplier. */
export async function listImportCodeSchemes(_request: Request, env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT kind, pattern_template, current_sequence FROM code_pools ORDER BY CASE kind WHEN 'RMS' THEN 1 WHEN 'RMF' THEN 2 ELSE 3 END"
  ).all();
  return json(rows.results ?? []);
}

/** Updates a pool's pattern and/or its last-used number — the latter so
 *  numbering can continue from where the Access log left off. */
export async function setImportCodeScheme(request: Request, env: Env, kind: string): Promise<Response> {
  if (kind !== "RMS" && kind !== "RMF" && kind !== "RMP") return error("kind must be RMS, RMF or RMP", 404);
  const input = await request.json<{ pattern_template?: string; current_sequence?: number }>();
  const pattern = input.pattern_template?.trim() || null;
  const sequence = input.current_sequence;
  if (!pattern && sequence === undefined) return error("Provide pattern_template and/or current_sequence", 400);
  if (pattern && !pattern.includes("{seq")) return error("The pattern needs a {seq} placeholder, e.g. RMP{seq:04d}", 400);
  if (sequence !== undefined && (!Number.isInteger(sequence) || sequence < 0)) {
    return error("current_sequence must be a whole number, 0 or more", 400);
  }

  await env.DB.prepare(
    `UPDATE code_pools SET
       pattern_template = COALESCE(?, pattern_template),
       current_sequence = COALESCE(?, current_sequence)
     WHERE kind = ?`
  )
    .bind(pattern, sequence ?? null, kind)
    .run();

  const row = await env.DB.prepare("SELECT kind, pattern_template, current_sequence FROM code_pools WHERE kind = ?")
    .bind(kind)
    .first();
  return json(row);
}

/** Weighted by accepted/rejected quantity rather than a flat per-batch
 *  count, so a partial approval counts proportionally to how much of it
 *  actually passed instead of being ignored (or crudely counted as half a
 *  batch regardless of whether 90% or 10% of it was accepted). Pending
 *  batches contribute 0/0 to both sums and drop out on their own. */
function passRate(qtyAccepted: number, qtyRejected: number): number | null {
  const decided = qtyAccepted + qtyRejected;
  return decided === 0 ? null : qtyAccepted / decided;
}

/** Everything Quality knows about one material code: every name it's been
 *  received under, its full spec history, its receipt history split into
 *  first supplies (RMF), regular supplies (RMP) and samples (RMS) with each
 *  entry's batches/attachments,
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

  const [rmf, rmp, rms] = await Promise.all([
    getImportEntries(env, materialCode, "first"),
    getImportEntries(env, materialCode, "regular"),
    getImportEntries(env, materialCode, "sample"),
  ]);

  const overallRow = await env.DB.prepare(
    `SELECT COUNT(DISTINCT rl.id) as imports,
       SUM(CASE WHEN rb.status = 'approved' THEN 1 ELSE 0 END) as approved,
       SUM(CASE WHEN rb.status = 'rejected' THEN 1 ELSE 0 END) as rejected,
       SUM(CASE WHEN rb.status = 'partial' THEN 1 ELSE 0 END) as partial,
       SUM(CASE WHEN rb.status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(COALESCE(rb.qty_accepted, 0)) as qty_accepted,
       SUM(COALESCE(rb.qty_rejected, 0)) as qty_rejected
     FROM receipt_lines rl
     LEFT JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     WHERE rl.material_code = ?`
  )
    .bind(materialCode)
    .first<Omit<DossierStatusCounts, "pass_rate"> & { qty_accepted: number; qty_rejected: number }>();

  const overall: DossierStatusCounts = {
    imports: overallRow?.imports ?? 0,
    approved: overallRow?.approved ?? 0,
    rejected: overallRow?.rejected ?? 0,
    partial: overallRow?.partial ?? 0,
    pending: overallRow?.pending ?? 0,
    pass_rate: passRate(overallRow?.qty_accepted ?? 0, overallRow?.qty_rejected ?? 0),
  };

  const bySupplierRows = await env.DB.prepare(
    `SELECT s.id as supplier_id, s.code as supplier_code, s.name as supplier_name,
       COUNT(DISTINCT rl.id) as imports,
       SUM(CASE WHEN rb.status = 'approved' THEN 1 ELSE 0 END) as approved,
       SUM(CASE WHEN rb.status = 'rejected' THEN 1 ELSE 0 END) as rejected,
       SUM(CASE WHEN rb.status = 'partial' THEN 1 ELSE 0 END) as partial,
       SUM(CASE WHEN rb.status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(COALESCE(rb.qty_accepted, 0)) as qty_accepted,
       SUM(COALESCE(rb.qty_rejected, 0)) as qty_rejected
     FROM receipt_lines rl
     JOIN receipts r ON r.id = rl.receipt_id
     JOIN suppliers s ON s.id = r.supplier_id
     LEFT JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     WHERE rl.material_code = ?
     GROUP BY s.id
     ORDER BY imports DESC`
  )
    .bind(materialCode)
    .all<Omit<DossierSupplierMetrics, "pass_rate"> & { qty_accepted: number; qty_rejected: number }>();

  const bySupplier: DossierSupplierMetrics[] = (bySupplierRows.results ?? []).map(
    ({ qty_accepted, qty_rejected, ...row }) => ({
      ...row,
      pass_rate: passRate(qty_accepted, qty_rejected),
    })
  );

  return {
    material,
    names: namesRows.results ?? [],
    specs,
    rmf,
    rmp,
    rms,
    metrics: { overall, by_supplier: bySupplier },
  };
}

async function getImportEntries(
  env: Env,
  materialCode: string,
  kind: SupplyKind
): Promise<DossierImportEntry[]> {
  // Classify by the real supply_kind column, not by pattern-matching the
  // code's text prefix — the code format is user-configurable (Codes >
  // Numbering Schemes), so a prefix match would silently drop entries.
  const lines = await env.DB.prepare(
    `SELECT rl.id as receipt_line_id, rl.import_code, rl.import_scenario, rl.material_name_text,
            rl.product_description, rl.manufacturer, rl.origin,
            r.id as receipt_id, r.received_at, s.id as supplier_id, s.code as supplier_code, s.name as supplier_name
     FROM receipt_lines rl
     JOIN receipts r ON r.id = rl.receipt_id
     JOIN suppliers s ON s.id = r.supplier_id
     WHERE rl.material_code = ? AND rl.supply_kind = ? AND rl.import_code IS NOT NULL
     ORDER BY r.received_at DESC`
  )
    .bind(materialCode, kind)
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
        `SELECT id, receipt_line_id, supplier_batch_no, status, internal_batch_no, decided_at, concession
         FROM receipt_batches WHERE receipt_line_id IN (${ph}) ORDER BY id`,
      lineIds
    ),
    fetchByIds<Attachment & { receipt_line_id: number }>(
      env,
      (ph) => `SELECT * FROM attachments WHERE receipt_line_id IN (${ph}) AND deleted_at IS NULL ORDER BY uploaded_at DESC`,
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
/** decidedBatches is a batch *count* (approved + rejected + partial) — used
 *  only for the low-volume-history caveat, since that's about how many
 *  independent decisions back the rating, not how much material they
 *  covered. The stars themselves come from the same quantity-weighted
 *  pass_rate shown elsewhere, so the badge never disagrees with the number
 *  next to it. */
function rateSupplier(passRateValue: number | null, decidedBatches: number): SupplierRating {
  if (passRateValue === null) return { stars: 0, label: "Unrated", low_volume: true };
  const stars = Math.round(passRateValue * 5);
  return { stars, label: RATING_LABELS[stars], low_volume: decidedBatches < 5 };
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
       SUM(CASE WHEN rb.status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(COALESCE(rb.qty_accepted, 0)) as qty_accepted,
       SUM(COALESCE(rb.qty_rejected, 0)) as qty_rejected
     FROM receipts r
     JOIN receipt_lines rl ON rl.receipt_id = r.id
     LEFT JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     WHERE r.supplier_id = ?`
  )
    .bind(supplier.id)
    .first<Omit<DossierStatusCounts, "pass_rate"> & { distinct_codes: number; qty_accepted: number; qty_rejected: number }>();

  const overall = {
    imports: overallRow?.imports ?? 0,
    distinct_codes: overallRow?.distinct_codes ?? 0,
    approved: overallRow?.approved ?? 0,
    rejected: overallRow?.rejected ?? 0,
    partial: overallRow?.partial ?? 0,
    pending: overallRow?.pending ?? 0,
    pass_rate: passRate(overallRow?.qty_accepted ?? 0, overallRow?.qty_rejected ?? 0),
  };

  const codeRows = await env.DB.prepare(
    `SELECT rl.material_code, COALESCE(m.name, '') as material_name,
       COUNT(DISTINCT rl.id) as imports,
       SUM(CASE WHEN rb.status = 'approved' THEN 1 ELSE 0 END) as approved,
       SUM(CASE WHEN rb.status = 'rejected' THEN 1 ELSE 0 END) as rejected,
       SUM(CASE WHEN rb.status = 'partial' THEN 1 ELSE 0 END) as partial,
       SUM(CASE WHEN rb.status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(COALESCE(rb.qty_accepted, 0)) as qty_accepted,
       SUM(COALESCE(rb.qty_rejected, 0)) as qty_rejected
     FROM receipts r
     JOIN receipt_lines rl ON rl.receipt_id = r.id
     LEFT JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     LEFT JOIN materials m ON m.code = rl.material_code
     WHERE r.supplier_id = ? AND rl.material_code IS NOT NULL
     GROUP BY rl.material_code
     ORDER BY imports DESC`
  )
    .bind(supplier.id)
    .all<Omit<SupplierCodeMetrics, "pass_rate"> & { qty_accepted: number; qty_rejected: number }>();

  const codes: SupplierCodeMetrics[] = (codeRows.results ?? []).map(({ qty_accepted, qty_rejected, ...row }) => ({
    ...row,
    pass_rate: passRate(qty_accepted, qty_rejected),
  }));

  const ranked = [...codes]
    .filter((c) => c.approved + c.rejected + c.partial > 0)
    .sort((a, b) => (b.pass_rate ?? 0) - (a.pass_rate ?? 0) || b.imports - a.imports);
  const bestCode = ranked[0] ?? null;

  return json({
    supplier,
    overall,
    rating: rateSupplier(overall.pass_rate, overall.approved + overall.rejected + overall.partial),
    codes,
    best_code: bestCode,
  });
}

function weightVariance(asReceived: number, actualWeighed: number): number | null {
  return asReceived === 0 ? null : ((actualWeighed - asReceived) / asReceived) * 100;
}

/** Warehouse's own supplier scorecard — separate from Quality's pass/fail
 *  assessment above, because it answers a different question: not "did
 *  the material meet spec" but "did the supplier actually ship what their
 *  paperwork claimed." Only batches that have been through the
 *  finalize-weight step (Warehouse physically re-weighing after Quality's
 *  decision) have an actual figure to compare against, so anything still
 *  pending that step is excluded rather than counted as a 0. */
export async function getSupplierWeightAssessment(env: Env, supplierCode: string): Promise<Response> {
  const supplier = await env.DB.prepare("SELECT * FROM suppliers WHERE code = ?")
    .bind(supplierCode)
    .first<Supplier>();
  if (!supplier) return error("Supplier not found", 404);

  const byMaterialRows = await env.DB.prepare(
    `SELECT rl.material_code,
       COALESCE(m.name, rl.material_name_text) as material_name,
       -- rl.unit is what the batch was actually logged/weighed in; m.unit
       -- (the code's canonical unit) is only a fallback for display when a
       -- line somehow has none of its own.
       COALESCE(rl.unit, m.unit) as unit,
       COUNT(*) as batches,
       COALESCE(SUM(rb.qty_as_received), 0) as qty_as_received,
       COALESCE(SUM(rb.qty_actual_weighed), 0) as qty_actual_weighed
     FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     JOIN receipts r ON r.id = rl.receipt_id
     LEFT JOIN materials m ON m.code = rl.material_code
     WHERE r.supplier_id = ? AND rb.qty_actual_weighed IS NOT NULL
     GROUP BY rl.material_code
     ORDER BY batches DESC`
  )
    .bind(supplier.id)
    .all<{
      material_code: string | null;
      material_name: string;
      unit: string;
      batches: number;
      qty_as_received: number;
      qty_actual_weighed: number;
    }>();

  const byMaterial: SupplierWeightVariance[] = (byMaterialRows.results ?? []).map((row) => ({
    ...row,
    variance_pct: weightVariance(row.qty_as_received, row.qty_actual_weighed),
  }));

  // A supplier that ships several material codes can ship them in
  // different units (KG, L, PCS, ...) — summing raw quantities across
  // codes to get one "overall" figure would silently add kilograms to
  // pallet counts. Each material's own variance_pct is unit-agnostic
  // (it's a ratio within that one material), so "overall" is a
  // batch-weighted average of those instead of a cross-unit sum.
  const totalBatches = byMaterial.reduce((sum, m) => sum + m.batches, 0);
  const weightedVarianceSum = byMaterial.reduce(
    (sum, m) => sum + (m.variance_pct ?? 0) * m.batches,
    0
  );
  const overall = {
    batches: totalBatches,
    variance_pct: totalBatches === 0 ? null : weightedVarianceSum / totalBatches,
  };

  return json({ supplier, overall, by_material: byMaterial });
}
