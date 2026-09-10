import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "xlsx";
import { error } from "../http";
import { getBatchTestResults, type TestResultWithParameter } from "./receipts";
import type { Env } from "../types";

interface CoaData {
  receiptId: number;
  supplierName: string;
  supplierBatchNo: string;
  internalBatchNo: string | null;
  materialCode: string;
  materialName: string;
  unit: string;
  status: string;
  qtyAsReceived: number;
  qtyAccepted: number | null;
  qtyActualWeighed: number | null;
  expiryDate: string | null;
  productionDate: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  results: TestResultWithParameter[];
}

async function getCoaData(env: Env, batchId: number): Promise<CoaData | null> {
  const row = await env.DB.prepare(
    `SELECT rb.supplier_batch_no, rb.internal_batch_no, rb.status, rb.qty_as_received, rb.qty_accepted,
            rb.qty_actual_weighed, rb.expiry_date, rb.production_date, rb.decided_by, rb.decided_at,
            rl.unit, rl.material_code, r.id as receipt_id, s.name as supplier_name,
            COALESCE(m.name, rl.material_name_text) as material_name
     FROM receipt_batches rb
     JOIN receipt_lines rl ON rl.id = rb.receipt_line_id
     JOIN receipts r ON r.id = rl.receipt_id
     JOIN suppliers s ON s.id = r.supplier_id
     LEFT JOIN materials m ON m.code = rl.material_code
     WHERE rb.id = ?`
  )
    .bind(batchId)
    .first<{
      supplier_batch_no: string;
      internal_batch_no: string | null;
      status: string;
      qty_as_received: number;
      qty_accepted: number | null;
      qty_actual_weighed: number | null;
      expiry_date: string | null;
      production_date: string | null;
      decided_by: string | null;
      decided_at: string | null;
      unit: string;
      material_code: string | null;
      receipt_id: number;
      supplier_name: string;
      material_name: string;
    }>();
  if (!row || !row.material_code) return null;

  const results = await getBatchTestResults(env, batchId);

  return {
    receiptId: row.receipt_id,
    supplierName: row.supplier_name,
    supplierBatchNo: row.supplier_batch_no,
    internalBatchNo: row.internal_batch_no,
    materialCode: row.material_code,
    materialName: row.material_name,
    unit: row.unit,
    status: row.status,
    qtyAsReceived: row.qty_as_received,
    qtyAccepted: row.qty_accepted,
    qtyActualWeighed: row.qty_actual_weighed,
    expiryDate: row.expiry_date,
    productionDate: row.production_date,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    results,
  };
}

function specText(r: TestResultWithParameter): string {
  if (r.param_type === "numeric_range" || r.param_type === "time_range") {
    return `${r.min_value ?? ""}–${r.max_value ?? ""}${r.unit ? ` ${r.unit}` : ""}`;
  }
  if (r.param_type === "pass_fail") return "Pass/Fail";
  return r.unit ?? "";
}

function quantityLine(data: CoaData): string {
  const base = `${data.qtyAsReceived} ${data.unit} as received`;
  return data.qtyActualWeighed != null ? `${base}, ${data.qtyActualWeighed} ${data.unit} actual` : base;
}

async function buildCoaPdf(data: CoaData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const pageSize: [number, number] = [595.28, 841.89]; // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = 50;
  const top = 800;
  const bottom = 60;

  let page = doc.addPage(pageSize);
  let y = top;

  const line = (text: string, opts: { size?: number; f?: typeof font; color?: ReturnType<typeof rgb> } = {}) => {
    const size = opts.size ?? 11;
    if (y < bottom) {
      page = doc.addPage(pageSize);
      y = top;
    }
    page.drawText(text, { x: left, y, size, font: opts.f ?? font, color: opts.color ?? rgb(0.13, 0.12, 0.18) });
    y -= size + 7;
  };

  line("Certificate of Analysis", { size: 20, f: bold });
  y -= 6;
  line(`Material: ${data.materialName} (${data.materialCode})`);
  line(`Internal Batch #: ${data.internalBatchNo ?? "—"}`);
  line(`Supplier Batch #: ${data.supplierBatchNo}`);
  line(`Supplier: ${data.supplierName}`);
  line(`Status: ${data.status}`);
  if (data.productionDate) line(`Production Date: ${data.productionDate}`);
  if (data.expiryDate) line(`Expiry Date: ${data.expiryDate}`);
  line(`Quantity: ${quantityLine(data)}`);
  line(`Decided by: ${data.decidedBy ?? "—"} on ${data.decidedAt ?? "—"}`);
  y -= 10;
  line("Test Results", { size: 14, f: bold });
  y -= 4;

  const cols = [left, left + 150, left + 260, left + 360, left + 450];
  const headerRow = () => {
    ["Parameter", "Method", "Spec", "Measured", "Result"].forEach((h, i) =>
      page.drawText(h, { x: cols[i], y, size: 9, font: bold, color: rgb(0.42, 0.41, 0.5) })
    );
    y -= 14;
  };
  headerRow();

  for (const r of data.results) {
    if (y < bottom) {
      page = doc.addPage(pageSize);
      y = top;
      headerRow();
    }
    const resultColor = r.result === "fail" ? rgb(0.71, 0.25, 0.42) : rgb(0.25, 0.48, 0.43);
    page.drawText(r.parameter_name, { x: cols[0], y, size: 9, font });
    page.drawText(r.method ?? "—", { x: cols[1], y, size: 9, font });
    page.drawText(specText(r), { x: cols[2], y, size: 9, font });
    page.drawText(r.measured_value ?? "—", { x: cols[3], y, size: 9, font });
    page.drawText(r.result.toUpperCase(), { x: cols[4], y, size: 9, font: bold, color: resultColor });
    y -= 14;
  }

  if (data.results.length === 0) {
    page.drawText("No test results recorded.", { x: left, y, size: 9, font, color: rgb(0.45, 0.43, 0.5) });
  }

  return doc.save();
}

function buildCoaXlsx(data: CoaData): Uint8Array {
  const rows: unknown[][] = [
    ["Certificate of Analysis"],
    [],
    ["Material", `${data.materialName} (${data.materialCode})`],
    ["Internal Batch #", data.internalBatchNo ?? ""],
    ["Supplier Batch #", data.supplierBatchNo],
    ["Supplier", data.supplierName],
    ["Status", data.status],
    ["Production Date", data.productionDate ?? ""],
    ["Expiry Date", data.expiryDate ?? ""],
    ["Quantity", quantityLine(data)],
    ["Decided by", `${data.decidedBy ?? ""} on ${data.decidedAt ?? ""}`],
    [],
    ["Parameter", "Method", "Spec", "Measured Value", "Result"],
    ...data.results.map((r) => [r.parameter_name, r.method ?? "", specText(r), r.measured_value ?? "", r.result.toUpperCase()]),
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 18 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, "COA");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

export async function downloadCoa(env: Env, batchId: number, format: string): Promise<Response> {
  const data = await getCoaData(env, batchId);
  if (!data) return error("Batch not found, or its line has no material code associated", 404);
  if (data.status === "pending") return error("This batch hasn't been decided yet — nothing to export", 400);

  const filename = `COA-${data.internalBatchNo ?? data.supplierBatchNo}`;

  if (format === "xlsx") {
    const bytes = buildCoaXlsx(data);
    return new Response(bytes, {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${filename}.xlsx"`,
      },
    });
  }
  if (format === "pdf") {
    const bytes = await buildCoaPdf(data);
    return new Response(bytes, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}.pdf"`,
      },
    });
  }
  return error("format must be 'pdf' or 'xlsx'", 400);
}
