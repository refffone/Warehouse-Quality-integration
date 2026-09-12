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
  SpecWithParameters,
  SubtypeSpecTemplateInput,
} from "../types";

const PARAM_TYPES: ParamType[] = ["numeric_range", "pass_fail", "time_range", "text_value"];

/** Enforces the same shape the DB CHECK constraint requires, so a bad
 *  request comes back as a clear 400 instead of a raw SQLite error.
 *  Exported so importSpecs can attribute the same check to individual
 *  Excel rows instead of duplicating the bounds logic. */
export function validateParameter(p: ParameterInput): string | null {
  if (!p.parameter_name || !p.param_type) return "Each parameter needs parameter_name and param_type";
  const needsBounds = p.param_type === "numeric_range" || p.param_type === "time_range";
  const hasBounds = p.min_value != null && p.max_value != null;
  if (needsBounds && !hasBounds) {
    return `${p.parameter_name}: ${p.param_type} requires min_value and max_value`;
  }
  if (!needsBounds && hasBounds) {
    return `${p.parameter_name}: ${p.param_type} must not have min_value/max_value`;
  }
  return null;
}

function validateParameters(params: ParameterInput[]): string | null {
  for (const p of params) {
    const err = validateParameter(p);
    if (err) return err;
  }
  return null;
}

async function insertParameters(
  env: Env,
  specId: number,
  params: ParameterInput[]
): Promise<void> {
  if (params.length === 0) return;
  await env.DB.batch(
    params.map((p, i) =>
      env.DB.prepare(
        `INSERT INTO spec_parameters
           (spec_id, parameter_name, param_type, method, min_value, max_value, unit, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        specId,
        p.parameter_name,
        p.param_type,
        p.method ?? null,
        p.min_value ?? null,
        p.max_value ?? null,
        p.unit ?? null,
        p.sort_order ?? i
      )
    )
  );
}

async function getTemplateParameters(env: Env, subtypeCode: string): Promise<ParameterInput[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM subtype_spec_templates WHERE subtype_code = ? ORDER BY sort_order"
  )
    .bind(subtypeCode)
    .all<ParameterInput>();
  return rows.results ?? [];
}

export type CreateSpecResult =
  | { ok: true; spec: SpecWithParameters }
  | { ok: false; message: string; status: number };

/** Core "create a new active spec version" logic, shared by the
 *  POST /api/materials/:code/specs handler and associateCode's "new
 *  material" path — both need to create a material's first spec version,
 *  one via a dedicated request, the other inline within a single call. */
export async function createSpecVersion(
  env: Env,
  materialCode: string,
  input: NewSpecInput
): Promise<CreateSpecResult> {
  if (!input.title || !input.created_by) {
    return { ok: false, message: "title and created_by are required", status: 400 };
  }

  const material = await env.DB.prepare("SELECT code, subtype_code FROM materials WHERE code = ?")
    .bind(materialCode)
    .first<{ code: string; subtype_code: string | null }>();
  if (!material) return { ok: false, message: `Unknown material code: ${materialCode}`, status: 404 };

  let parameters = input.parameters;
  if (!parameters) {
    parameters = material.subtype_code ? await getTemplateParameters(env, material.subtype_code) : [];
  }

  const validationError = validateParameters(parameters);
  if (validationError) return { ok: false, message: validationError, status: 400 };

  const nextVersionRow = await env.DB.prepare(
    "SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM specs WHERE material_code = ?"
  )
    .bind(materialCode)
    .first<{ next_version: number }>();
  const nextVersion = nextVersionRow!.next_version;

  const [, insertResult] = await env.DB.batch<{ id: number }>([
    env.DB.prepare("UPDATE specs SET status = 'superseded' WHERE material_code = ? AND status = 'active'").bind(
      materialCode
    ),
    env.DB.prepare(
      `INSERT INTO specs (material_code, version, status, title, notes, created_by)
       VALUES (?, ?, 'active', ?, ?, ?)
       RETURNING id`
    ).bind(materialCode, nextVersion, input.title, input.notes ?? null, input.created_by),
  ]);
  const specId = insertResult.results[0].id;

  await insertParameters(env, specId, parameters);

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

export async function listSpecsForMaterial(env: Env, materialCode: string): Promise<SpecWithParameters[]> {
  const specs = await env.DB.prepare(
    "SELECT * FROM specs WHERE material_code = ? ORDER BY version DESC"
  )
    .bind(materialCode)
    .all<Spec>();

  const detailed: SpecWithParameters[] = [];
  for (const spec of specs.results ?? []) {
    detailed.push(await getSpecWithParameters(env, spec.id));
  }
  return detailed;
}

async function getSpecWithParameters(env: Env, specId: number): Promise<SpecWithParameters> {
  const spec = await env.DB.prepare("SELECT * FROM specs WHERE id = ?").bind(specId).first<Spec>();
  const params = await env.DB.prepare(
    "SELECT * FROM spec_parameters WHERE spec_id = ? ORDER BY sort_order"
  )
    .bind(specId)
    .all<SpecParameter>();
  return { ...spec!, parameters: params.results ?? [] };
}

export async function getActiveSpec(env: Env, materialCode: string): Promise<SpecWithParameters | null> {
  const spec = await env.DB.prepare("SELECT * FROM specs WHERE material_code = ? AND status = 'active'")
    .bind(materialCode)
    .first<Spec>();
  if (!spec) return null;
  return getSpecWithParameters(env, spec.id);
}

/** Bulk form of getActiveSpec, for a page rendering many receipt lines at
 *  once (e.g. a whole To Do/History bucket) — one pass instead of one
 *  query per distinct material code. */
export async function getActiveSpecsForMaterials(
  env: Env,
  materialCodes: string[]
): Promise<Map<string, SpecWithParameters>> {
  const map = new Map<string, SpecWithParameters>();
  const codes = [...new Set(materialCodes)];
  if (!codes.length) return map;

  const specs = await fetchByIds<Spec>(
    env,
    (ph) => `SELECT * FROM specs WHERE status = 'active' AND material_code IN (${ph})`,
    codes
  );
  if (!specs.length) return map;

  const specIds = specs.map((s) => s.id);
  const params = await fetchByIds<SpecParameter>(
    env,
    (ph) => `SELECT * FROM spec_parameters WHERE spec_id IN (${ph}) ORDER BY sort_order`,
    specIds
  );
  const paramsBySpec = new Map<number, SpecParameter[]>();
  for (const p of params) {
    if (!paramsBySpec.has(p.spec_id)) paramsBySpec.set(p.spec_id, []);
    paramsBySpec.get(p.spec_id)!.push(p);
  }
  for (const s of specs) {
    map.set(s.material_code, { ...s, parameters: paramsBySpec.get(s.id) ?? [] });
  }
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
  const validationError = validateParameters(input.parameters ?? []);
  if (validationError) return error(validationError);

  const subtype = await env.DB.prepare("SELECT code FROM material_subtypes WHERE code = ?")
    .bind(subtypeCode)
    .first();
  if (!subtype) return error(`Unknown subtype code: ${subtypeCode}`, 404);

  await env.DB.prepare("DELETE FROM subtype_spec_templates WHERE subtype_code = ?").bind(subtypeCode).run();

  const params = input.parameters ?? [];
  if (params.length > 0) {
    await env.DB.batch(
      params.map((p, i) =>
        env.DB.prepare(
          `INSERT INTO subtype_spec_templates
             (subtype_code, parameter_name, param_type, method, min_value, max_value, unit, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          subtypeCode,
          p.parameter_name,
          p.param_type,
          p.method ?? null,
          p.min_value ?? null,
          p.max_value ?? null,
          p.unit ?? null,
          p.sort_order ?? i
        )
      )
    );
  }

  return getSubtypeSpecTemplate(env, subtypeCode);
}

const SPEC_IMPORT_COLUMNS = [
  { key: "material_code", header: "Material Code" },
  { key: "title", header: "Title" },
  { key: "notes", header: "Notes" },
  { key: "created_by", header: "Created By" },
  { key: "parameter_name", header: "Parameter Name" },
  { key: "param_type", header: "Param Type" },
  { key: "method", header: "Method" },
  { key: "min_value", header: "Min Value" },
  { key: "max_value", header: "Max Value" },
  { key: "unit", header: "Unit" },
];

/** One row per parameter of each material's currently *active* spec — the
 *  editable snapshot a client re-imports as a brand-new version (specs are
 *  append-only history, so import never edits a row in place, it always
 *  creates the next version). A material with no active spec yet simply
 *  has no rows here; add one manually to create its first spec. */
export async function specsImportTemplate(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT s.material_code, s.title, s.notes, s.created_by,
            sp.parameter_name, sp.param_type, sp.method, sp.min_value, sp.max_value, sp.unit
     FROM specs s
     JOIN spec_parameters sp ON sp.spec_id = s.id
     WHERE s.status = 'active'
     ORDER BY s.material_code, sp.sort_order`
  ).all<Record<string, unknown>>();
  const bytes = buildTemplateXlsx(SPEC_IMPORT_COLUMNS, rows.results ?? []);
  return templateResponse(bytes, "specs-import-template.xlsx");
}

/** Unlike Suppliers/Materials (upsert by code), a spec import can never
 *  "update" an existing row — every commit creates a brand-new version via
 *  the same `createSpecVersion` the manual "new spec version" form uses,
 *  so a material with an active spec already just gets superseded, same as
 *  usual. Rows are grouped into one new spec per distinct Material Code
 *  (all its parameter rows), so this only supports one new spec per
 *  material per import file — a second block for the same material in one
 *  file merges into the first rather than creating two versions. */
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

  interface Group {
    materialCode: string;
    title: string;
    notes: string | null;
    createdBy: string;
    parameters: ParameterInput[];
  }
  const groups = new Map<string, Group>();
  const results: ImportRowResult[] = [];
  const rowErrors = new Map<number, string>();
  const materialsWithRowError = new Set<string>();

  parsedRows.forEach((row, i) => {
    const rowNum = i + 1;
    const materialCode = (row["Material Code"] ?? "").trim();
    const title = (row["Title"] ?? "").trim();
    const createdBy = (row["Created By"] ?? "").trim();
    const notes = (row["Notes"] ?? "").trim() || null;
    const method = (row["Method"] ?? "").trim() || null;
    const unit = (row["Unit"] ?? "").trim() || null;
    const minStr = (row["Min Value"] ?? "").trim();
    const maxStr = (row["Max Value"] ?? "").trim();

    results.push({ row: rowNum, code: materialCode || "(blank)", action: "insert" });

    const fail = (message: string) => {
      rowErrors.set(rowNum, message);
      if (materialCode) materialsWithRowError.add(materialCode);
    };

    if (!materialCode) return fail("Material Code is required");
    if (!validMaterials.has(materialCode)) return fail(`Unknown material code: ${materialCode}`);
    if (!title) return fail("Title is required");
    if (!createdBy) return fail("Created By is required");

    const parameter: ParameterInput = {
      parameter_name: (row["Parameter Name"] ?? "").trim(),
      param_type: (row["Param Type"] ?? "").trim() as ParamType,
      method,
      unit,
      min_value: minStr === "" ? null : Number(minStr),
      max_value: maxStr === "" ? null : Number(maxStr),
    };
    if (!PARAM_TYPES.includes(parameter.param_type)) {
      return fail(`Unknown Param Type: ${parameter.param_type || "(blank)"}`);
    }
    if (minStr !== "" && Number.isNaN(parameter.min_value)) return fail(`Min Value isn't a number: ${minStr}`);
    if (maxStr !== "" && Number.isNaN(parameter.max_value)) return fail(`Max Value isn't a number: ${maxStr}`);
    const paramError = validateParameter(parameter);
    if (paramError) return fail(paramError);

    if (!groups.has(materialCode)) {
      groups.set(materialCode, { materialCode, title, notes, createdBy, parameters: [] });
    }
    parameter.sort_order = groups.get(materialCode)!.parameters.length;
    groups.get(materialCode)!.parameters.push(parameter);
  });

  results.forEach((r, idx) => {
    const rowNum = idx + 1;
    if (rowErrors.has(rowNum)) {
      results[idx] = { ...r, action: "error", message: rowErrors.get(rowNum) };
    } else if (materialsWithRowError.has(r.code)) {
      results[idx] = { ...r, action: "error", message: "Not created — another row for this material has an error" };
    }
  });

  const errors = results.filter((r) => r.action === "error").length;
  if (commit && errors > 0) return error("Fix the rows with errors before importing", 400);

  if (commit) {
    for (const group of groups.values()) {
      if (materialsWithRowError.has(group.materialCode)) continue;
      const created = await createSpecVersion(env, group.materialCode, {
        title: group.title,
        notes: group.notes,
        created_by: group.createdBy,
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
