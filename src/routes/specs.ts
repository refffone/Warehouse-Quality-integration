import { error, json } from "../http";
import type {
  Env,
  NewSpecInput,
  ParameterInput,
  Spec,
  SpecParameter,
  SpecWithParameters,
  SubtypeSpecTemplateInput,
} from "../types";

/** Enforces the same shape the DB CHECK constraint requires, so a bad
 *  request comes back as a clear 400 instead of a raw SQLite error. */
function validateParameters(params: ParameterInput[]): string | null {
  for (const p of params) {
    if (!p.parameter_name || !p.param_type) return "Each parameter needs parameter_name and param_type";
    const needsBounds = p.param_type === "numeric_range" || p.param_type === "time_range";
    const hasBounds = p.min_value != null && p.max_value != null;
    if (needsBounds && !hasBounds) {
      return `${p.parameter_name}: ${p.param_type} requires min_value and max_value`;
    }
    if (!needsBounds && hasBounds) {
      return `${p.parameter_name}: ${p.param_type} must not have min_value/max_value`;
    }
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
  const specs = await env.DB.prepare(
    "SELECT * FROM specs WHERE material_code = ? ORDER BY version DESC"
  )
    .bind(materialCode)
    .all<Spec>();

  const detailed: SpecWithParameters[] = [];
  for (const spec of specs.results ?? []) {
    detailed.push(await getSpecWithParameters(env, spec.id));
  }
  return json(detailed);
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
