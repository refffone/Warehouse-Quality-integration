import { error, json } from "../http";
import type { Env } from "../types";

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
  }>();
  if (!input.code || !input.name || !input.unit) {
    return error("code, name and unit are required");
  }

  await env.DB.prepare(
    `INSERT INTO materials (code, name, unit, requires_expiry)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, unit = excluded.unit,
       requires_expiry = excluded.requires_expiry`
  )
    .bind(input.code, input.name, input.unit, input.requires_expiry === false ? 0 : 1)
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
