import { validateLimit, LIMIT_TYPES } from "../../public/specLimits.js";
import { fetchByIds } from "../db";
import { error, json } from "../http";
import { buildTemplateXlsx, parseXlsxRows, templateResponse } from "../xlsxImport";
import { isUploadedFile } from "./attachments";
import type {
  Env,
  ImportRowResult,
  ImportSummary,
  NewSpecInput,
  ParamType,
  ParameterInput,
  Spec,
  SpecParameter,
  SpecScope,
  SpecWithParameters,
  SubtypeSpecTemplateInput,
  TestCatalogEntry,
} from "../types";

const SCOPES: SpecScope[] = ["supply", "sample"];

export function isSpecScope(value: unknown): value is SpecScope {
  return SCOPES.includes(value as SpecScope);
}

/** Same rules as the DB CHECK constraints (and the browser's own form
 *  validation), so a bad request comes back as a clear 400. */
export function validateParameter(p: ParameterInput): string | null {
  return validateLimit(p);
}

async function loadCatalog(env: Env): Promise<Map<string, TestCatalogEntry>> {
  const rows = await env.DB.prepare("SELECT * FROM test_catalog").all<TestCatalogEntry>();
  return new Map((rows.results ?? []).map((r) => [r.code, r]));
}

/** Fills a parameter's blanks from its catalog test (name, method code,
 *  unit) and checks it. Returns the completed parameter or an error. */
function completeParameter(
  p: ParameterInput,
  catalog: Map<string, TestCatalogEntry>
): { ok: true; param: ParameterInput } | { ok: false; message: string } {
  const testCode = p.test_code?.trim() || null;
  const test = testCode ? catalog.get(testCode) : undefined;
  if (testCode && !test) return { ok: false, message: `Unknown test: ${testCode}` };
  const clean = (v: string | null | undefined) => (v == null ? null : String(v).trim() || null);
  const param: ParameterInput = {
    test_code: testCode,
    parameter_name: clean(p.parameter_name) ?? test?.name ?? "",
    param_type: p.param_type,
    method: clean(p.method) ?? test?.method_code ?? null,
    conditions: clean(p.conditions),
    min_value: p.min_value ?? null,
    max_value: p.max_value ?? null,
    unit: clean(p.unit) ?? (p.param_type === "time_range" ? null : (test?.default_unit ?? null)),
    expected_text: clean(p.expected_text),
    target_value: p.target_value ?? null,
    tolerance: p.tolerance ?? null,
    remarks: clean(p.remarks),
    sort_order: p.sort_order,
  };
  const problem = validateParameter(param);
  return problem ? { ok: false, message: problem } : { ok: true, param };
}

async function completeParameters(
  env: Env,
  params: ParameterInput[]
): Promise<{ ok: true; params: ParameterInput[] } | { ok: false; message: string }> {
  const catalog = await loadCatalog(env);
  const out: ParameterInput[] = [];
  for (const p of params) {
    const r = completeParameter(p, catalog);
    if (!r.ok) return r;
    out.push(r.param);
  }
  return { ok: true, params: out };
}

const PARAM_COLUMNS =
  "test_code, parameter_name, param_type, method, conditions, min_value, max_value, unit, expected_text, target_value, tolerance, remarks, sort_order";
const PARAM_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

function paramValues(p: ParameterInput, i: number): unknown[] {
  return [
    p.test_code ?? null,
    p.parameter_name,
    p.param_type,
    p.method ?? null,
    p.conditions ?? null,
    p.min_value ?? null,
    p.max_value ?? null,
    p.unit ?? null,
    p.expected_text ?? null,
    p.target_value ?? null,
    p.tolerance ?? null,
    p.remarks ?? null,
    p.sort_order ?? i,
  ];
}

async function insertParameters(env: Env, specId: number, params: ParameterInput[]): Promise<void> {
  if (params.length === 0) return;
  await env.DB.batch(
    params.map((p, i) =>
      env.DB.prepare(`INSERT INTO spec_parameters (spec_id, ${PARAM_COLUMNS}) VALUES (?, ${PARAM_PLACEHOLDERS})`).bind(
        specId,
        ...paramValues(p, i)
      )
    )
  );
}

async function getTemplateParameters(env: Env, subtypeCode: string): Promise<ParameterInput[]> {
  const rows = await env.DB.prepare(
    `SELECT ${PARAM_COLUMNS} FROM subtype_spec_templates WHERE subtype_code = ? ORDER BY sort_order`
  )
    .bind(subtypeCode)
    .all<ParameterInput>();
  return rows.results ?? [];
}

export type CreateSpecResult =
  | { ok: true; spec: SpecWithParameters }
  | { ok: false; message: string; status: number };

/** Core "create a new active spec version" logic, shared by the
 *  POST /api/materials/:code/specs handler, associateCode's "new material"
 *  path, and the Excel import. Versions are numbered per scope: a
 *  material's supply spec and sample spec each have their own history. */
export async function createSpecVersion(
  env: Env,
  materialCode: string,
  input: NewSpecInput
): Promise<CreateSpecResult> {
  if (!input.title || !input.created_by) {
    return { ok: false, message: "title and created_by are required", status: 400 };
  }
  const scope = input.scope ?? "supply";
  if (!isSpecScope(scope)) return { ok: false, message: "scope must be supply or sample", status: 400 };
  const variant = input.variant?.trim() || null;

  const material = await env.DB.prepare("SELECT code, subtype_code FROM materials WHERE code = ?")
    .bind(materialCode)
    .first<{ code: string; subtype_code: string | null }>();
  if (!material) return { ok: false, message: `Unknown material code: ${materialCode}`, status: 404 };

  let parameters = input.parameters;
  if (!parameters) {
    parameters = material.subtype_code ? await getTemplateParameters(env, material.subtype_code) : [];
  }
  const completed = await completeParameters(env, parameters);
  if (!completed.ok) return { ok: false, message: completed.message, status: 400 };

  const nextVersionRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM specs
     WHERE material_code = ? AND scope = ? AND COALESCE(variant, '') = ? AND receipt_line_id IS NULL`
  )
    .bind(materialCode, scope, variant ?? "")
    .first<{ next_version: number }>();
  const nextVersion = nextVersionRow!.next_version;

  const [, insertResult] = await env.DB.batch<{ id: number }>([
    env.DB.prepare(
      `UPDATE specs SET status = 'superseded'
       WHERE material_code = ? AND scope = ? AND COALESCE(variant, '') = ? AND status = 'active'
         AND receipt_line_id IS NULL`
    ).bind(materialCode, scope, variant ?? ""),
    env.DB.prepare(
      `INSERT INTO specs (material_code, scope, variant, version, status, title, notes, change_reason, created_by)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
       RETURNING id`
    ).bind(
      materialCode,
      scope,
      variant,
      nextVersion,
      input.title,
      input.notes ?? null,
      input.change_reason?.trim() || null,
      input.created_by
    ),
  ]);
  const specId = insertResult.results[0].id;

  await insertParameters(env, specId, completed.params);

  return { ok: true, spec: await getSpecWithParameters(env, specId) };
}

export async function createSpec(request: Request, env: Env, materialCode: string): Promise<Response> {
  const input = await request.json<NewSpecInput>();
  const result = await createSpecVersion(env, materialCode, input);
  if (!result.ok) return error(result.message, result.status);
  return json(result.spec, 201);
}

export async function listSpecs(env: Env, materialCode: string): Promise<Response> {
  return json(await listSpecsForMaterial(env, materialCode));
}

/** Every version of both scopes, newest first within each scope. One-time
 *  specs (written for a single received line) aren't the material's. */
export async function listSpecsForMaterial(env: Env, materialCode: string): Promise<SpecWithParameters[]> {
  const specs = await env.DB.prepare(
    `SELECT * FROM specs WHERE material_code = ? AND receipt_line_id IS NULL
     ORDER BY scope DESC, COALESCE(variant, '') ASC, version DESC`
  )
    .bind(materialCode)
    .all<Spec>();
  return attachParameters(env, specs.results ?? []);
}

async function attachParameters(env: Env, specs: Spec[]): Promise<SpecWithParameters[]> {
  if (!specs.length) return [];
  const params = await fetchByIds<SpecParameter>(
    env,
    (ph) => `SELECT * FROM spec_parameters WHERE spec_id IN (${ph}) ORDER BY sort_order, id`,
    specs.map((s) => s.id)
  );
  const bySpec = new Map<number, SpecParameter[]>();
  for (const p of params) {
    if (!bySpec.has(p.spec_id)) bySpec.set(p.spec_id, []);
    bySpec.get(p.spec_id)!.push(p);
  }
  return specs.map((s) => ({ ...s, parameters: bySpec.get(s.id) ?? [] }));
}

async function getSpecWithParameters(env: Env, specId: number): Promise<SpecWithParameters> {
  const spec = await env.DB.prepare("SELECT * FROM specs WHERE id = ?").bind(specId).first<Spec>();
  return (await attachParameters(env, [spec!]))[0];
}

/** The spec a batch is tested against: for a sample, the material's sample
 *  spec if it has one, otherwise its supply spec (as in Access, a sample
 *  spec only exists where Quality wrote one). */
export async function getActiveSpec(
  env: Env,
  materialCode: string,
  scope: SpecScope = "supply"
): Promise<SpecWithParameters | null> {
  return (await getActiveSpecsForMaterials(env, [materialCode], scope)).get(materialCode) ?? null;
}

/** Bulk form of getActiveSpec, for a page rendering many receipt lines at
 *  once (e.g. a whole To Do/History bucket). */
export async function getActiveSpecsForMaterials(
  env: Env,
  materialCodes: string[],
  scope: SpecScope = "supply"
): Promise<Map<string, SpecWithParameters>> {
  const map = new Map<string, SpecWithParameters>();
  const codes = [...new Set(materialCodes)];
  if (!codes.length) return map;

  const specs = await fetchByIds<Spec>(
    env,
    // Variants aren't picked for receipts yet — that needs the receipt to
    // say which manufacturer it came from — so testing uses the normal spec.
    (ph) =>
      `SELECT * FROM specs
       WHERE status = 'active' AND variant IS NULL AND receipt_line_id IS NULL AND material_code IN (${ph})`,
    codes
  );
  // Prefer the requested scope; a sample falls back to the supply spec.
  const chosen = new Map<string, Spec>();
  for (const s of specs) {
    if (s.scope === scope) chosen.set(s.material_code, s);
  }
  if (scope === "sample") {
    for (const s of specs) {
      if (s.scope === "supply" && !chosen.has(s.material_code)) chosen.set(s.material_code, s);
    }
  }
  for (const spec of await attachParameters(env, [...chosen.values()])) {
    map.set(spec.material_code, spec);
  }
  return map;
}

/** A spec written for one received line only — for a material that has no
 *  spec yet but whose sample or supply needs testing and a COA now. It
 *  never becomes the material's spec (see migration 0028). */
export async function createOneTimeSpec(
  env: Env,
  line: { id: number; material_code: string },
  scope: SpecScope,
  input: { title: string; notes?: string | null; created_by: string; parameters: ParameterInput[] }
): Promise<CreateSpecResult> {
  if (!input.title || !input.created_by) {
    return { ok: false, message: "title and created_by are required", status: 400 };
  }
  const completed = await completeParameters(env, input.parameters);
  if (!completed.ok) return { ok: false, message: completed.message, status: 400 };

  const row = await env.DB.prepare(
    `INSERT INTO specs (material_code, scope, variant, version, status, title, notes, created_by, receipt_line_id)
     VALUES (?, ?, NULL, 1, 'active', ?, ?, ?, ?)
     RETURNING id`
  )
    .bind(line.material_code, scope, input.title, input.notes ?? null, input.created_by, line.id)
    .first<{ id: number }>();
  await insertParameters(env, row!.id, completed.params);
  return { ok: true, spec: await getSpecWithParameters(env, row!.id) };
}

/** One-time specs of the given lines, by line id. */
export async function getOneTimeSpecsForLines(env: Env, lineIds: number[]): Promise<Map<number, SpecWithParameters>> {
  const map = new Map<number, SpecWithParameters>();
  if (!lineIds.length) return map;
  const specs = await fetchByIds<Spec>(env, (ph) => `SELECT * FROM specs WHERE receipt_line_id IN (${ph})`, lineIds);
  for (const spec of await attachParameters(env, specs)) map.set(spec.receipt_line_id!, spec);
  return map;
}

export async function getSubtypeSpecTemplate(env: Env, subtypeCode: string): Promise<Response> {
  const params = await getTemplateParameters(env, subtypeCode);
  return json({ subtype_code: subtypeCode, parameters: params });
}

export async function setSubtypeSpecTemplate(
  request: Request,
  env: Env,
  subtypeCode: string
): Promise<Response> {
  const input = await request.json<SubtypeSpecTemplateInput>();
  const completed = await completeParameters(env, input.parameters ?? []);
  if (!completed.ok) return error(completed.message);

  const subtype = await env.DB.prepare("SELECT code FROM material_subtypes WHERE code = ?")
    .bind(subtypeCode)
    .first();
  if (!subtype) return error(`Unknown subtype code: ${subtypeCode}`, 404);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM subtype_spec_templates WHERE subtype_code = ?").bind(subtypeCode),
    ...completed.params.map((p, i) =>
      env.DB.prepare(
        `INSERT INTO subtype_spec_templates (subtype_code, ${PARAM_COLUMNS}) VALUES (?, ${PARAM_PLACEHOLDERS})`
      ).bind(subtypeCode, ...paramValues(p, i))
    ),
  ]);

  return getSubtypeSpecTemplate(env, subtypeCode);
}

// ---------------------------------------------------------------- test catalog

export async function listTestCatalog(env: Env): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM test_catalog ORDER BY active DESC, sort_order, name").all();
  return json(rows.results ?? []);
}

/** Adds or edits one test. The code is the stable key specs refer to. */
export async function upsertTestCatalogEntry(request: Request, env: Env): Promise<Response> {
  const input = await request.json<Partial<TestCatalogEntry>>();
  const code = input.code?.trim().toUpperCase();
  const name = input.name?.trim();
  if (!code || !/^[A-Z0-9_]{1,40}$/.test(code)) return error("code must be letters, digits or _", 400);
  if (!name) return error("name is required", 400);
  if (!LIMIT_TYPES.includes(input.default_type as ParamType)) return error("Unknown default_type", 400);

  await env.DB.prepare(
    `INSERT INTO test_catalog (code, name, method_code, default_type, default_unit, sort_order, active)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM test_catalog)), ?)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name, method_code = excluded.method_code, default_type = excluded.default_type,
       default_unit = excluded.default_unit, sort_order = excluded.sort_order, active = excluded.active`
  )
    .bind(
      code,
      name,
      input.method_code?.trim() || null,
      input.default_type,
      input.default_unit?.trim() || null,
      input.sort_order ?? null,
      input.active === 0 ? 0 : 1
    )
    .run();
  return json(await env.DB.prepare("SELECT * FROM test_catalog WHERE code = ?").bind(code).first());
}

// ---------------------------------------------------------------- Excel import/export

const SPEC_IMPORT_COLUMNS = [
  { key: "material_code", header: "Material Code" },
  { key: "scope", header: "Scope" },
  { key: "variant", header: "Variant" },
  { key: "title", header: "Title" },
  { key: "notes", header: "Notes" },
  { key: "change_reason", header: "Change Reason" },
  { key: "created_by", header: "Created By" },
  { key: "test_code", header: "Test Code" },
  { key: "parameter_name", header: "Parameter Name" },
  { key: "param_type", header: "Limit Type" },
  { key: "method", header: "Method" },
  { key: "conditions", header: "Conditions" },
  { key: "min_value", header: "Min" },
  { key: "max_value", header: "Max" },
  { key: "unit", header: "Unit" },
  { key: "expected_text", header: "Expected" },
  { key: "target_value", header: "Target" },
  { key: "tolerance", header: "Tolerance" },
  { key: "remarks", header: "Remarks" },
];

/** One row per parameter of each material's currently *active* specs (both
 *  scopes) — the editable snapshot a client re-imports as new versions.
 *  Time limits are written as m:ss, the way Quality reads them. */
export async function specsImportTemplate(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT s.material_code, s.scope, s.variant, s.title, s.notes, NULL AS change_reason, s.created_by,
            sp.test_code, sp.parameter_name, sp.param_type, sp.method, sp.conditions,
            sp.min_value, sp.max_value, sp.unit, sp.expected_text, sp.target_value, sp.tolerance, sp.remarks
     FROM specs s
     JOIN spec_parameters sp ON sp.spec_id = s.id
     WHERE s.status = 'active' AND s.receipt_line_id IS NULL
     ORDER BY s.material_code, s.scope DESC, COALESCE(s.variant, ''), sp.sort_order`
  ).all<Record<string, unknown>>();
  const shaped = (rows.results ?? []).map((r) =>
    r.param_type === "time_range" ? { ...r, min_value: toClock(r.min_value), max_value: toClock(r.max_value) } : r
  );
  const bytes = buildTemplateXlsx(SPEC_IMPORT_COLUMNS, shaped);
  return templateResponse(bytes, "specs-import-template.xlsx");
}

function toClock(seconds: unknown): string {
  const t = Math.round(Number(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** A Min/Max cell: a plain number, or m:ss for a time limit (stored as seconds). */
function parseLimitCell(raw: string, type: ParamType): number | null | "invalid" {
  if (raw === "") return null;
  if (type === "time_range") {
    const m = /^(\d+):(\d{1,2})$/.exec(raw);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
  }
  const n = Number(raw.replace(",", "."));
  return Number.isNaN(n) ? "invalid" : n;
}

/** Every commit creates brand-new versions via the same createSpecVersion
 *  the manual form uses — never edits a row in place. Rows are grouped into
 *  one new spec per (Material Code, Scope). */
export async function importSpecs(request: Request, env: Env, commit: boolean): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");
  if (!isUploadedFile(file)) return error("file is required", 400);

  let parsedRows: Record<string, string>[];
  try {
    parsedRows = parseXlsxRows(await file.arrayBuffer());
  } catch {
    return error("Couldn't read that file — make sure it's a valid .xlsx export", 400);
  }

  const materialRows = await env.DB.prepare("SELECT code FROM materials").all<{ code: string }>();
  const validMaterials = new Set((materialRows.results ?? []).map((r) => r.code));
  const catalog = await loadCatalog(env);

  interface Group {
    materialCode: string;
    scope: SpecScope;
    variant: string | null;
    title: string;
    notes: string | null;
    changeReason: string | null;
    createdBy: string;
    parameters: ParameterInput[];
  }
  const groups = new Map<string, Group>();
  const results: ImportRowResult[] = [];
  const rowErrors = new Map<number, string>();
  const groupsWithRowError = new Set<string>();
  const rowGroup = new Map<number, string>();

  parsedRows.forEach((row, i) => {
    const rowNum = i + 1;
    const cell = (h: string) => (row[h] ?? "").trim();
    const materialCode = cell("Material Code");
    const scope = (cell("Scope").toLowerCase() || "supply") as SpecScope;
    const variant = cell("Variant") || null;
    const key = `${materialCode}|${scope}|${variant ?? ""}`;
    rowGroup.set(rowNum, key);
    const label = `${materialCode} (${scope}${variant ? `, ${variant}` : ""})`;
    results.push({ row: rowNum, code: materialCode ? label : "(blank)", action: "insert" });

    const fail = (message: string) => {
      rowErrors.set(rowNum, message);
      if (materialCode) groupsWithRowError.add(key);
    };

    if (!materialCode) return fail("Material Code is required");
    if (!validMaterials.has(materialCode)) return fail(`Unknown material code: ${materialCode}`);
    if (!isSpecScope(scope)) return fail(`Scope must be supply or sample, not "${cell("Scope")}"`);
    const title = cell("Title");
    const createdBy = cell("Created By");
    if (!title) return fail("Title is required");
    if (!createdBy) return fail("Created By is required");

    const type = cell("Limit Type") as ParamType;
    if (!LIMIT_TYPES.includes(type)) return fail(`Unknown Limit Type: ${type || "(blank)"}`);
    const min = parseLimitCell(cell("Min"), type);
    const max = parseLimitCell(cell("Max"), type);
    if (min === "invalid") return fail(`Min isn't a number: ${cell("Min")}`);
    if (max === "invalid") return fail(`Max isn't a number: ${cell("Max")}`);
    const target = parseLimitCell(cell("Target"), "numeric_range");
    const tolerance = parseLimitCell(cell("Tolerance"), "numeric_range");
    if (target === "invalid") return fail(`Target isn't a number: ${cell("Target")}`);
    if (tolerance === "invalid") return fail(`Tolerance isn't a number: ${cell("Tolerance")}`);

    const completed = completeParameter(
      {
        test_code: cell("Test Code") || null,
        parameter_name: cell("Parameter Name"),
        param_type: type,
        method: cell("Method") || null,
        conditions: cell("Conditions") || null,
        min_value: min,
        max_value: max,
        unit: cell("Unit") || null,
        expected_text: cell("Expected") || null,
        target_value: target,
        tolerance,
        remarks: cell("Remarks") || null,
      },
      catalog
    );
    if (!completed.ok) return fail(completed.message);

    if (!groups.has(key)) {
      groups.set(key, {
        materialCode,
        scope,
        variant,
        title,
        notes: cell("Notes") || null,
        changeReason: cell("Change Reason") || null,
        createdBy,
        parameters: [],
      });
    }
    const group = groups.get(key)!;
    completed.param.sort_order = group.parameters.length;
    group.parameters.push(completed.param);
  });

  results.forEach((r, idx) => {
    const rowNum = idx + 1;
    if (rowErrors.has(rowNum)) {
      results[idx] = { ...r, action: "error", message: rowErrors.get(rowNum) };
    } else if (groupsWithRowError.has(rowGroup.get(rowNum)!)) {
      results[idx] = { ...r, action: "error", message: "Not created — another row for this spec has an error" };
    }
  });

  const errors = results.filter((r) => r.action === "error").length;
  if (commit && errors > 0) return error("Fix the rows with errors before importing", 400);

  if (commit) {
    for (const [key, group] of groups) {
      if (groupsWithRowError.has(key)) continue;
      const created = await createSpecVersion(env, group.materialCode, {
        title: group.title,
        notes: group.notes,
        change_reason: group.changeReason,
        created_by: group.createdBy,
        scope: group.scope,
        variant: group.variant,
        parameters: group.parameters,
      });
      if (!created.ok) return error(created.message, created.status);
    }
  }

  const summary: ImportSummary = {
    rows: results,
    inserts: results.filter((r) => r.action === "insert").length,
    updates: 0,
    errors,
    committed: commit,
  };
  return json(summary);
}
