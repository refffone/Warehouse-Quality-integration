import * as XLSX from "xlsx";

/** A plain, undecorated header-row + data-rows sheet — deliberately not
 *  reusing buildReportXlsx's branded report layout (company name, title,
 *  "Generated" timestamp, blank rows), since those extra rows would sit
 *  between the real header and the data and break a naive re-import.
 *  This is the thing a client edits and hands back, not something meant
 *  to be read standalone. */
export function buildTemplateXlsx(columns: { key: string; header: string }[], rows: Record<string, unknown>[]): Uint8Array {
  const aoa: unknown[][] = [columns.map((c) => c.header)];
  for (const row of rows) aoa.push(columns.map((c) => row[c.key] ?? ""));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = columns.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

export function templateResponse(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** Parses the first sheet of an uploaded workbook into plain row objects
 *  keyed by the (trimmed, case-insensitive-matched by the caller) header
 *  text in row 1 — the mirror image of buildTemplateXlsx's layout. Every
 *  cell comes back as a trimmed string; callers parse numbers/booleans
 *  themselves since Excel round-trips those inconsistently (a column a
 *  client typed "TRUE"/"1"/"yes" into, or left as an actual checkbox-like
 *  boolean, all need to resolve the same way). */
export function parseXlsxRows(bytes: ArrayBuffer): Record<string, string>[] {
  const wb = XLSX.read(bytes, { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  return raw.map((row) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      out[key.trim()] = String(value ?? "").trim();
    }
    return out;
  });
}

/** Accepts the common spellings a client might type for a yes/no column
 *  (including what Excel shows for an actual boolean cell) rather than
 *  requiring one exact string. Anything unrecognized defaults to false
 *  rather than throwing, since this field already defaults to "on" for
 *  new materials elsewhere in the app and a blank cell shouldn't block
 *  an otherwise-valid row. */
export function parseImportBoolean(value: string): boolean {
  return ["true", "1", "yes", "y"].includes(value.trim().toLowerCase());
}
