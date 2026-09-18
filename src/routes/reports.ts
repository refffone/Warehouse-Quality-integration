import { getBranding } from "./admin";
import { isStandInCode } from "../../public/materialCodes.js";
import { getMaterialDossierData } from "./masterdata";
import { historyRowsForExport } from "./history";
import { formatLimit } from "../../public/specLimits.js";
import { getActiveSpec, listSpecsForMaterial } from "./specs";
import { error } from "../http";
import { ReportPdf, buildReportXlsx, reportFilename, reportResponse, type ReportColumn } from "../reportBuilders";
import type { Env, Role } from "../types";

type Format = "pdf" | "xlsx";

/** Report columns are narrow (many columns per row) — a raw ISO timestamp
 *  ("2026-09-11T11:07:14.123Z") doesn't fit and gets mid-string truncated,
 *  so every date value going into a table is formatted through here first. */
function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${fmtDate(value)}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function parseFormat(url: URL): Format | null {
  const format = url.searchParams.get("format");
  return format === "pdf" || format === "xlsx" ? format : null;
}

/** `from`/`to` are ISO datetime strings the frontend computes from the
 *  browser's local "today" — the backend just filters by range, so there's
 *  no server/client timezone ambiguity to resolve here. */
function parseRange(url: URL): { from: string; to: string } | null {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return null;
  return { from, to };
}

async function renderTable(
  env: Env,
  format: Format,
  title: string,
  subtitle: string | undefined,
  columns: ReportColumn[],
  rows: Record<string, string | number | null | undefined>[],
  filenameBase: string
): Promise<Response> {
  const branding = await getBranding(env);
  if (format === "pdf") {
    const pdf = await ReportPdf.create(branding, title, subtitle);
    pdf.table(columns, rows);
    return reportResponse(await pdf.save(), reportFilename(filenameBase, "pdf"), "pdf");
  }
  const xlsx = buildReportXlsx(branding, title, subtitle, [{ table: { columns, rows } }]);
  return reportResponse(xlsx, reportFilename(filenameBase, "xlsx"), "xlsx");
}

// ---------------------------------------------------------------- Warehouse: received log

const RECEIVED_LOG_COLUMNS: ReportColumn[] = [
  { key: "receipt_id", header: "Receipt #", width: 45 },
  { key: "type", header: "Type", width: 45 },
  { key: "received_at", header: "Received", width: 125 },
  { key: "supplier", header: "Supplier", width: 85 },
  { key: "material", header: "Material", width: 100 },
  { key: "batch_no", header: "Batch #", width: 60 },
  { key: "qty", header: "Qty", width: 35 },
];

export async function exportReceivedLog(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const format = parseFormat(url);
  if (!format) return error("format must be 'pdf' or 'xlsx'");
  const range = parseRange(url);
  if (!range) return error("from and to are required");

  const rows = await env.DB.prepare(
    `SELECT COALESCE(r.receipt_no, '—') as receipt_id, r.type, r.received_at, s.name as supplier,
            COALESCE(m.name, rl.material_name_text) as material, rl.material_code,
            rb.supplier_batch_no as batch_no, rb.qty_as_received as qty, rl.unit
     FROM receipts r
     JOIN receipt_lines rl ON rl.receipt_id = r.id
     JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     JOIN suppliers s ON s.id = r.supplier_id
     LEFT JOIN materials m ON m.code = rl.material_code
     WHERE r.received_by = 'warehouse'
       AND datetime(r.received_at) >= datetime(?) AND datetime(r.received_at) <= datetime(?)
     ORDER BY r.received_at DESC`
  )
    .bind(range.from, range.to)
    .all<Record<string, string | number | null>>();

  const shaped = (rows.results ?? []).map((r) => ({
    ...r,
    received_at: receivedLabel(r.received_at as string, fmtDateTime),
    // Warehouse's own log: a real material code, or just the name until
    // Quality links one (never a stand-in record number).
    material: r.material_code && !isStandInCode(r.material_code) ? `${r.material} (${r.material_code})` : String(r.material),
    qty: `${r.qty} ${r.unit}`,
  }));

  return renderTable(
    env,
    format,
    "Received Log",
    `${fmtRangeLabel(range.from, range.to)} · ${shaped.length} line${shaped.length === 1 ? "" : "s"}`,
    RECEIVED_LOG_COLUMNS,
    shaped,
    "received-log"
  );
}

// ---------------------------------------------------------------- Quality: To Do (now)

const TODO_COLUMNS: ReportColumn[] = [
  { key: "receipt_id", header: "Receipt #", width: 45 },
  { key: "type", header: "Type", width: 45 },
  { key: "received_at", header: "Received", width: 115 },
  { key: "supplier", header: "Supplier", width: 80 },
  { key: "material", header: "Material", width: 105 },
  { key: "batch_no", header: "Batch #", width: 60 },
  { key: "task", header: "Needs", width: 45 },
];

export async function exportTodos(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const format = parseFormat(url);
  if (!format) return error("format must be 'pdf' or 'xlsx'");

  const rows = await env.DB.prepare(
    `SELECT COALESCE(r.receipt_no, '—') as receipt_id, r.type, r.received_at, s.name as supplier,
            COALESCE(m.name, rl.material_name_text) as material, rl.material_code,
            rb.supplier_batch_no as batch_no,
            (SELECT COUNT(*) FROM batch_test_results WHERE batch_id = rb.id AND round_no IS NULL) as test_count
     FROM receipts r
     JOIN receipt_lines rl ON rl.receipt_id = r.id
     JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     JOIN suppliers s ON s.id = r.supplier_id
     LEFT JOIN materials m ON m.code = rl.material_code
     WHERE rb.status = 'pending'
     ORDER BY r.received_at ASC`
  )
    .all<Record<string, string | number | null>>();

  const shaped = (rows.results ?? []).map((r) => ({
    ...r,
    received_at: receivedLabel(r.received_at as string, fmtDateTime),
    material: r.material_code ? `${r.material} (${r.material_code})` : "Uncoded — needs Associate a Code",
    task: r.material_code ? (Number(r.test_count) > 0 ? "Decision" : "Testing") : "Coding",
  }));

  return renderTable(env, format, "To Do", `As of ${new Date().toLocaleString()} · ${shaped.length} pending`, TODO_COLUMNS, shaped, "todo");
}

// ---------------------------------------------------------------- Quality: history (period)

const HISTORY_COLUMNS: ReportColumn[] = [
  { key: "receipt_id", header: "Receipt #", width: 35 },
  { key: "type", header: "Type", width: 35 },
  { key: "material", header: "Material", width: 95 },
  { key: "batch_no", header: "Batch #", width: 50 },
  { key: "status", header: "Status", width: 45 },
  { key: "internal_batch_no", header: "Internal #", width: 65 },
  { key: "import_code", header: "Code", width: 45 },
  { key: "decided_at", header: "Decided", width: 125 },
];

export async function exportHistory(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const format = parseFormat(url);
  if (!format) return error("format must be 'pdf' or 'xlsx'");
  const range = parseRange(url);
  if (!range) return error("from and to are required");

  const rows = await env.DB.prepare(
    `SELECT COALESCE(r.receipt_no, '—') as receipt_id, r.type, COALESCE(m.name, rl.material_name_text) as material, rl.material_code,
            rb.supplier_batch_no as batch_no,
            CASE WHEN rb.concession = 1 THEN 'approved (concession)' ELSE rb.status END as status,
            rb.internal_batch_no, rl.import_code, rb.decided_at
     FROM receipts r
     JOIN receipt_lines rl ON rl.receipt_id = r.id
     JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
     LEFT JOIN materials m ON m.code = rl.material_code
     WHERE rb.status != 'pending' AND datetime(rb.decided_at) >= datetime(?) AND datetime(rb.decided_at) <= datetime(?)
     ORDER BY rb.decided_at DESC`
  )
    .bind(range.from, range.to)
    .all<Record<string, string | number | null>>();

  const shaped = (rows.results ?? []).map((r) => ({
    ...r,
    decided_at: fmtDateTime(r.decided_at as string),
    material: r.material_code ? `${r.material} (${r.material_code})` : String(r.material),
  }));

  return renderTable(
    env,
    format,
    "History",
    `${fmtRangeLabel(range.from, range.to)} · ${shaped.length} decided batch${shaped.length === 1 ? "" : "es"}`,
    HISTORY_COLUMNS,
    shaped,
    "history"
  );
}

/** Access records with no date carry a 1970 placeholder (receipts.received_at_unknown). */
function receivedLabel(value: string, format: (v: string) => string): string {
  return String(value ?? "").startsWith("1970-01-01") ? "date unknown" : format(value);
}

// ---------------------------------------------------------------- Quality: code spec

export async function exportCodeSpec(request: Request, env: Env, materialCode: string): Promise<Response> {
  const url = new URL(request.url);
  const format = parseFormat(url);
  if (!format) return error("format must be 'pdf' or 'xlsx'");

  const material = await env.DB.prepare("SELECT * FROM materials WHERE code = ?").bind(materialCode).first<{
    code: string;
    name: string;
    unit: string;
  }>();
  if (!material) return error("Material not found", 404);

  // Only a real sample spec counts here — getActiveSpec's fallback to the
  // supply spec is for testing, not for printing the same sheet twice.
  const supplySpec = await getActiveSpec(env, materialCode, "supply");
  const sampleCandidate = await getActiveSpec(env, materialCode, "sample");
  const sampleSpec = sampleCandidate?.scope === "sample" ? sampleCandidate : null;
  const branding = await getBranding(env);
  const subtitle = `${material.name} (${material.code})`;
  const columns: ReportColumn[] = [
    { key: "parameter_name", header: "Test", width: 90 },
    { key: "method", header: "Method", width: 65 },
    { key: "limit", header: "Limit", width: 110 },
    { key: "conditions", header: "Conditions", width: 105 },
    { key: "remarks", header: "Remarks", width: 70 },
  ];
  // Named variants (e.g. per manufacturer) print after the normal specs.
  const variantSpecs = (await listSpecsForMaterial(env, materialCode)).filter((s) => s.status === "active" && s.variant);
  const sections = [
    { label: "Supply specification", spec: supplySpec },
    { label: "Sample specification", spec: sampleSpec },
    ...variantSpecs.map((v) => ({
      label: `${v.scope === "sample" ? "Sample" : "Supply"} specification — ${v.variant}`,
      spec: v as typeof supplySpec,
    })),
  ].filter((s) => s.spec);
  const describe = (spec: NonNullable<typeof supplySpec>): Array<[string, string]> => [
    ["Version", String(spec.version)],
    ["Title", spec.title],
    ["Created by", `${spec.created_by}, ${fmtDate(spec.created_at)}`],
    ...(spec.change_reason ? ([["Reason for change", spec.change_reason]] as Array<[string, string]>) : []),
    ...(spec.notes ? ([["Notes", spec.notes]] as Array<[string, string]>) : []),
  ];
  const rowsFor = (spec: NonNullable<typeof supplySpec>) =>
    spec.parameters.map((p) => ({
      parameter_name: p.parameter_name,
      method: p.method ?? "—",
      limit: formatLimit(p),
      conditions: p.conditions ?? "—",
      remarks: p.remarks ?? "—",
    }));

  if (format === "pdf") {
    const pdf = await ReportPdf.create(branding, "Specification Sheet", subtitle);
    if (!sections.length) pdf.emptyNote("No active specification for this material.");
    for (const { label, spec } of sections) {
      pdf.heading(label);
      pdf.keyValue(describe(spec!));
      pdf.table(columns, rowsFor(spec!));
    }
    return reportResponse(await pdf.save(), reportFilename(`spec-${materialCode}`, "pdf"), "pdf");
  }

  const xlsx = buildReportXlsx(
    branding,
    "Specification Sheet",
    subtitle,
    sections.length
      ? sections.map(({ label, spec }) => ({
          heading: label,
          keyValue: describe(spec!),
          table: { columns, rows: rowsFor(spec!) },
        }))
      : [{ keyValue: [["Status", "No active specification for this material."]] }]
  );
  return reportResponse(xlsx, reportFilename(`spec-${materialCode}`, "xlsx"), "xlsx");
}

// ---------------------------------------------------------------- Quality: master data for a code

export async function exportMasterData(request: Request, env: Env, materialCode: string): Promise<Response> {
  const url = new URL(request.url);
  const format = parseFormat(url);
  if (!format) return error("format must be 'pdf' or 'xlsx'");

  const dossier = await getMaterialDossierData(env, materialCode);
  if (!dossier) return error("Material not found", 404);
  const branding = await getBranding(env);
  const subtitle = `${dossier.material.name} (${dossier.material.code})`;

  const supplierColumns: ReportColumn[] = [
    { key: "supplier_name", header: "Supplier", width: 110 },
    { key: "imports", header: "Imports", width: 55 },
    { key: "approved", header: "Approved", width: 60 },
    { key: "rejected", header: "Rejected", width: 60 },
    { key: "pass_rate", header: "Pass Rate", width: 60 },
  ];
  const supplierRows = dossier.metrics.by_supplier.map((s) => ({
    supplier_name: `${s.supplier_name} (${s.supplier_code})`,
    imports: s.imports,
    approved: s.approved,
    rejected: s.rejected,
    pass_rate: s.pass_rate != null ? `${Math.round(s.pass_rate * 100)}%` : "—",
  }));

  const importColumns: ReportColumn[] = [
    { key: "import_code", header: "Code", width: 60 },
    { key: "supplier_name", header: "Supplier", width: 90 },
    { key: "received_at", header: "Received", width: 90 },
    { key: "batches", header: "Batches", width: 200 },
  ];
  const rmfRows = dossier.rmf.map(formatImportEntryRow);
  const rmpRows = dossier.rmp.map(formatImportEntryRow);
  const rmsRows = dossier.rms.map(formatImportEntryRow);

  const overall = dossier.metrics.overall;
  const overallKv: Array<[string, string]> = [
    ["Total imports", String(overall.imports)],
    ["Approved", String(overall.approved)],
    ["Rejected", String(overall.rejected)],
    ["Partial", String(overall.partial)],
    ["Pending", String(overall.pending)],
    ["Pass rate", overall.pass_rate != null ? `${Math.round(overall.pass_rate * 100)}%` : "—"],
    ["Unit", dossier.material.unit],
  ];

  if (format === "pdf") {
    const pdf = await ReportPdf.create(branding, "Material Dossier", subtitle);
    pdf.heading("Overview");
    pdf.keyValue(overallKv);
    pdf.heading("By Supplier");
    pdf.table(supplierColumns, supplierRows);
    pdf.heading("RMF — First Supplies");
    pdf.table(importColumns, rmfRows);
    pdf.heading("RMP — Regular Supplies");
    pdf.table(importColumns, rmpRows);
    pdf.heading("RMS — Samples");
    pdf.table(importColumns, rmsRows);
    return reportResponse(await pdf.save(), reportFilename(`master-data-${materialCode}`, "pdf"), "pdf");
  }

  const xlsx = buildReportXlsx(branding, "Material Dossier", subtitle, [
    { heading: "Overview", keyValue: overallKv },
    { heading: "By Supplier", table: { columns: supplierColumns, rows: supplierRows } },
    { heading: "RMF — First Supplies", table: { columns: importColumns, rows: rmfRows } },
    { heading: "RMP — Regular Supplies", table: { columns: importColumns, rows: rmpRows } },
    { heading: "RMS — Samples", table: { columns: importColumns, rows: rmsRows } },
  ]);
  return reportResponse(xlsx, reportFilename(`master-data-${materialCode}`, "xlsx"), "xlsx");
}

function formatImportEntryRow(entry: {
  import_code: string | null;
  manufacturer: string | null;
  origin: string | null;
  supplier_name: string;
  supplier_code: string;
  received_at: string;
  batches: Array<{ supplier_batch_no: string; status: string; internal_batch_no: string | null; concession: 0 | 1 }>;
}) {
  return {
    import_code: entry.import_code ?? "—",
    supplier_name: [
      `${entry.supplier_name} (${entry.supplier_code})`,
      [entry.manufacturer, entry.origin].filter(Boolean).join(", "),
    ]
      .filter(Boolean)
      .join(" · "),
    received_at: receivedLabel(entry.received_at, fmtDate),
    batches: entry.batches.map((b) => `${b.supplier_batch_no}: ${b.concession ? "approved (concession)" : b.status}${b.internal_batch_no ? ` (${b.internal_batch_no})` : ""}`).join("; "),
  };
}

// ---------------------------------------------------------------- Quality: suppliers list

const SUPPLIERS_COLUMNS: ReportColumn[] = [
  { key: "code", header: "Code", width: 90 },
  { key: "name", header: "Name", width: 300 },
];

export async function exportSuppliersList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const format = parseFormat(url);
  if (!format) return error("format must be 'pdf' or 'xlsx'");

  const rows = await env.DB.prepare("SELECT code, name FROM suppliers ORDER BY name").all<{
    code: string;
    name: string;
  }>();

  return renderTable(env, format, "Suppliers", `${rows.results?.length ?? 0} suppliers`, SUPPLIERS_COLUMNS, rows.results ?? [], "suppliers");
}

// ---------------------------------------------------------------- Quality: codes list (filtered)

const CODES_COLUMNS: ReportColumn[] = [
  { key: "code", header: "Code", width: 65 },
  { key: "name", header: "Name", width: 110 },
  { key: "function_code", header: "Function", width: 65 },
  { key: "type_code", header: "Type", width: 50 },
  { key: "subtype_code", header: "Subtype", width: 60 },
  { key: "unit", header: "Unit", width: 40 },
];

export async function exportCodesList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const format = parseFormat(url);
  if (!format) return error("format must be 'pdf' or 'xlsx'");

  const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
  const typeFilter = url.searchParams.get("type") ?? "";
  const subtypeFilter = url.searchParams.get("subtype") ?? "";
  const functionFilter = url.searchParams.get("function") ?? "";

  const rows = await env.DB.prepare(
    "SELECT * FROM materials WHERE code NOT GLOB 'RM[SFP][0-9][0-9][0-9][0-9]*' ORDER BY code"
  ).all<{
    code: string;
    name: string;
    unit: string;
    type_code: string | null;
    subtype_code: string | null;
    function_code: string | null;
  }>();

  const filtered = (rows.results ?? []).filter((m) => {
    if (typeFilter && m.type_code !== typeFilter) return false;
    if (subtypeFilter && m.subtype_code !== subtypeFilter) return false;
    if (functionFilter && m.function_code !== functionFilter) return false;
    if (query && !m.code.toLowerCase().includes(query) && !m.name.toLowerCase().includes(query)) return false;
    return true;
  });

  const shaped = filtered.map((m) => ({ ...m, function_code: m.function_code ?? "—", type_code: m.type_code ?? "—", subtype_code: m.subtype_code ?? "—" }));

  return renderTable(env, format, "Codes", `${shaped.length} code${shaped.length === 1 ? "" : "s"}`, CODES_COLUMNS, shaped, "codes");
}

function fmtRangeLabel(from: string, to: string): string {
  const f = new Date(from);
  const t = new Date(to);
  const sameDay = f.toDateString() === t.toDateString();
  return sameDay ? f.toLocaleDateString() : `${f.toLocaleDateString()} – ${t.toLocaleDateString()}`;
}

// ---------------------------------------------------------------- History register (both roles, filtered)

const QUALITY_REGISTER_COLUMNS: ReportColumn[] = [
  { key: "decided", header: "Decided", width: 58 },
  { key: "record", header: "Record", width: 42 },
  { key: "material", header: "Material", width: 100 },
  { key: "supplier", header: "Supplier", width: 70 },
  { key: "receipt", header: "Receipt #", width: 32 },
  { key: "batch", header: "Batch #", width: 48 },
  { key: "internal", header: "Internal #", width: 55 },
  { key: "accepted", header: "Accepted", width: 42 },
  { key: "decision", header: "Decision", width: 45 },
];

const WAREHOUSE_REGISTER_COLUMNS: ReportColumn[] = [
  { key: "decided", header: "Decided", width: 58 },
  { key: "material", header: "Material", width: 110 },
  { key: "supplier", header: "Supplier", width: 72 },
  { key: "receipt", header: "Receipt #", width: 32 },
  { key: "batch", header: "Batch #", width: 48 },
  { key: "as_received", header: "As received", width: 45 },
  { key: "actual", header: "Actual", width: 45 },
  { key: "difference", header: "Difference", width: 38 },
  { key: "decision", header: "Decision", width: 45 },
];

/** What History shows, as PDF or Excel, with the same filters as the screen. */
export async function exportHistoryRegister(request: Request, env: Env, role: Role): Promise<Response> {
  const url = new URL(request.url);
  const format = parseFormat(url);
  if (!format) return error("format must be 'pdf' or 'xlsx'");
  const rows = await historyRowsForExport(url, env, role);
  const qty = (v: unknown, unit: unknown) => (v == null ? "" : `${v} ${unit ?? ""}`.trim());
  const decision = (r: Record<string, unknown>) =>
    r.status == null ? "" : r.concession ? "approved (concession)" : String(r.status);
  const shaped = rows.map((r) => {
    const name = String(r.material_name ?? r.material_name_text ?? "");
    const base = {
      decided: r.decided_at ? fmtDateTime(r.decided_at as string) : "—",
      material: r.material_code ? `${name} (${r.material_code})` : name,
      supplier: String(r.supplier_name ?? ""),
      receipt: String(r.receipt_no ?? "—"),
      batch: String(r.supplier_batch_no ?? ""),
      decision: decision(r),
    };
    if (role === "quality") {
      const accepted = r.status === "rejected" ? 0 : (r.qty_accepted ?? r.qty_as_received);
      return { ...base, record: String(r.import_code ?? ""), internal: String(r.internal_batch_no ?? ""), accepted: qty(accepted, r.unit) };
    }
    const asReceived = Number(r.qty_as_received);
    const actual = r.qty_actual_weighed == null ? null : Number(r.qty_actual_weighed);
    return {
      ...base,
      as_received: qty(r.qty_as_received, r.unit),
      actual: qty(actual, r.unit),
      difference: actual == null || !asReceived ? "" : `${(((actual - asReceived) / asReceived) * 100).toFixed(1)}%`,
    };
  });
  return renderTable(
    env,
    format,
    "History",
    `${shaped.length} decided batch${shaped.length === 1 ? "" : "es"}${rows.length >= 5000 ? " (first 5,000)" : ""}`,
    role === "quality" ? QUALITY_REGISTER_COLUMNS : WAREHOUSE_REGISTER_COLUMNS,
    shaped,
    "history"
  );
}
