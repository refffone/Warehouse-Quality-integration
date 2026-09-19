import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as XLSX from "xlsx";
import type { Branding } from "./routes/admin";
import type { Env } from "./types";

/** Shared report layout for every PDF/Excel export (received log, history,
 *  code spec, master data, suppliers, codes list) — one place for the
 *  branding header, pagination, and table drawing instead of reimplementing
 *  it per report, the way the COA export already does on its own. */

export interface ReportColumn {
  key: string;
  header: string;
  width: number;
}

type Row = Record<string, string | number | null | undefined>;

// The standard PDF fonts only cover the WinAnsi character set; drawing
// anything outside it (Arabic, "≥") throws and fails the whole export.
const WIN_ANSI_EXTRAS = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const PDF_REPLACEMENTS: Record<string, string> = { "≥": ">=", "≤": "<=", "≠": "!=", "±": "+/-", " ": " " };

/** Makes text drawable with the standard fonts: known symbols are spelled
 *  out, anything else unsupported becomes "?", line breaks become spaces. */
export function pdfText(text: string): string {
  let out = "";
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    if (PDF_REPLACEMENTS[ch] !== undefined) out += PDF_REPLACEMENTS[ch];
    else {
      const code = ch.codePointAt(0)!;
      out += (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRAS.has(ch) ? ch : "?";
    }
  }
  return out;
}

// ---------------------------------------------------------------- Arabic

/** Embeds the Arabic-capable body face (Cairo — the same one used on the
 *  web UI's RTL layout, for visual consistency) from the bundled static
 *  asset. pdf-lib's standard fonts (Helvetica) only cover WinAnsi, so
 *  Arabic text needs a real font with Arabic OpenType tables; fontkit
 *  (registered here) then does correct shaping/joining automatically once
 *  that font is embedded — see splitArabicRuns()/drawMixedText() below. */
export async function embedArabicFont(doc: PDFDocument, env: Env): Promise<PDFFont> {
  doc.registerFontkit(fontkit);
  const res = await env.ASSETS.fetch(new Request("https://assets.internal/fonts/Cairo-Variable.ttf"));
  const bytes = await res.arrayBuffer();
  return doc.embedFont(bytes, { subset: true });
}

const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

/** Splits text into consecutive runs of Arabic-script vs. everything else,
 *  each run keeping its original character order. This document's paragraph
 *  direction is always English/LTR (every label is English; only a free-text
 *  *value* — a person's name, a supplier, a rejection reason — might be
 *  Arabic), so runs never need reordering relative to each other: only the
 *  characters *within* an Arabic run need right-to-left, joined shaping,
 *  which pdf-lib's fontkit-backed layout already does correctly on its own
 *  once a font with real Arabic OpenType tables is embedded — it just
 *  doesn't segment a *mixed* string by script first, which is all this
 *  does. (Confirmed empirically: feeding fontkit a pure-Arabic run renders
 *  it correctly shaped and ordered with zero extra work; feeding it a
 *  mixed English+Arabic string in one call does not.) */
function splitArabicRuns(text: string): string[] {
  const runs: string[] = [];
  let current = "";
  let currentIsArabic: boolean | null = null;
  for (const ch of text) {
    const isArabic = ARABIC_RE.test(ch);
    if (currentIsArabic !== null && isArabic !== currentIsArabic) {
      runs.push(current);
      current = "";
    }
    current += ch;
    currentIsArabic = isArabic;
  }
  if (current) runs.push(current);
  return runs;
}

interface MixedTextFonts {
  size: number;
  font: PDFFont;
  arabicFont: PDFFont;
}

/** Width of `text` as drawMixedText() would draw it — each run measured
 *  with whichever font would render it (Arabic runs count as unshaped
 *  length here, which very slightly overstates a joined run's real width;
 *  fine for wrapping decisions, which only need to stay on the safe side). */
function widthOfMixedText(text: string, opts: MixedTextFonts): number {
  let width = 0;
  for (const run of splitArabicRuns(text)) {
    const isArabic = ARABIC_RE.test(run);
    const f = isArabic ? opts.arabicFont : opts.font;
    width += f.widthOfTextAtSize(isArabic ? run : pdfText(run), opts.size);
  }
  return width;
}

/** Draws `text` left to right, routing each Arabic run to `arabicFont` (an
 *  embedded font with real Arabic glyph coverage, drawn as-is) and every
 *  other run to `font` (drawn through pdfText(), same as always — zero
 *  behavior change for non-Arabic content). */
export function drawMixedText(
  page: PDFPage,
  text: string,
  opts: { x: number; y: number; color?: ReturnType<typeof rgb> } & MixedTextFonts
): void {
  let x = opts.x;
  for (const run of splitArabicRuns(text)) {
    const isArabic = ARABIC_RE.test(run);
    const f = isArabic ? opts.arabicFont : opts.font;
    const drawn = isArabic ? run : pdfText(run);
    page.drawText(drawn, { x, y: opts.y, size: opts.size, font: f, color: opts.color });
    x += f.widthOfTextAtSize(drawn, opts.size);
  }
}

/** Greedy word-wrap: breaks `text` on spaces into lines that each fit
 *  `maxWidth`, measured the same way drawMixedText() draws (so Arabic runs
 *  are accounted for correctly). A single word wider than the column on its
 *  own (a long unbroken code with no spaces) gets hard-broken by character
 *  instead of overflowing forever. */
export function wrapText(text: string, maxWidth: number, opts: MixedTextFonts): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && widthOfMixedText(candidate, opts) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
    // A lone word already wider than the column: break it by character so
    // it doesn't just run past maxWidth forever on its own line.
    while (widthOfMixedText(line, opts) > maxWidth && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && widthOfMixedText(line.slice(0, cut), opts) > maxWidth) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

/** Wraps and draws `text` inside `maxWidth`, one line per `lineHeight`
 *  starting at (x, y) and moving downward. Returns the number of lines
 *  drawn, so the caller can advance past the tallest cell in a row. */
export function drawWrappedMixedText(
  page: PDFPage,
  text: string,
  opts: { x: number; y: number; maxWidth: number; lineHeight: number; color?: ReturnType<typeof rgb> } & MixedTextFonts
): number {
  const lines = wrapText(text, opts.maxWidth, opts);
  lines.forEach((line, i) => drawMixedText(page, line, { ...opts, y: opts.y - i * opts.lineHeight }));
  return lines.length;
}

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; kind: "png" | "jpg" } | null {
  const match = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!match) return null;
  const kind = match[1] === "png" ? "png" : "jpg";
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, kind };
}

export class ReportPdf {
  private doc!: PDFDocument;
  private page!: PDFPage;
  private font!: PDFFont;
  private bold!: PDFFont;
  private logo: PDFImage | null = null;
  private y = 0;
  private readonly left = 50;
  private readonly right = 545.28;
  private readonly top = 800;
  private readonly bottom = 55;
  /** Set while drawing a table's body so a page break mid-table redraws
   *  the column headers on the new page instead of just resuming rows. */
  private onPageBreak: (() => void) | null = null;

  static async create(branding: Branding, title: string, subtitle?: string): Promise<ReportPdf> {
    const r = new ReportPdf();
    r.doc = await PDFDocument.create();
    r.font = await r.doc.embedFont(StandardFonts.Helvetica);
    r.bold = await r.doc.embedFont(StandardFonts.HelveticaBold);
    if (branding.logo_data_url) {
      const decoded = decodeDataUrl(branding.logo_data_url);
      if (decoded) {
        try {
          r.logo = decoded.kind === "png" ? await r.doc.embedPng(decoded.bytes) : await r.doc.embedJpg(decoded.bytes);
        } catch {
          r.logo = null; // a corrupt/unsupported image shouldn't fail the whole export
        }
      }
    }
    r.newPage();
    r.drawBrandHeader(branding, title, subtitle);
    return r;
  }

  private newPage() {
    this.page = this.doc.addPage([595.28, 841.89]); // A4
    this.y = this.top;
  }

  private ensureSpace(needed: number) {
    if (this.y - needed < this.bottom) {
      this.newPage();
      this.onPageBreak?.();
    }
  }

  private drawBrandHeader(branding: Branding, title: string, subtitle?: string) {
    if (this.logo) {
      const dims = this.logo.scale(28 / this.logo.height);
      this.page.drawImage(this.logo, { x: this.left, y: this.y - 28, width: dims.width, height: 28 });
    }
    const textX = this.logo ? this.left + this.logo.scale(28 / this.logo.height).width + 10 : this.left;
    if (branding.company_name) {
      this.page.drawText(pdfText(branding.company_name), {
        x: textX,
        y: this.y - 12,
        size: 12,
        font: this.bold,
        color: rgb(0.13, 0.12, 0.18),
      });
      this.page.drawText(pdfText(new Date().toLocaleString()), {
        x: textX,
        y: this.y - 26,
        size: 8,
        font: this.font,
        color: rgb(0.55, 0.53, 0.63),
      });
    } else {
      this.page.drawText(pdfText(new Date().toLocaleString()), {
        x: textX,
        y: this.y - 12,
        size: 8,
        font: this.font,
        color: rgb(0.55, 0.53, 0.63),
      });
    }
    this.y -= 44;
    this.page.drawText(pdfText(title), { x: this.left, y: this.y, size: 18, font: this.bold, color: rgb(0.13, 0.12, 0.18) });
    this.y -= 22;
    if (subtitle) {
      this.page.drawText(pdfText(subtitle), { x: this.left, y: this.y, size: 10, font: this.font, color: rgb(0.42, 0.41, 0.5) });
      this.y -= 18;
    }
    this.y -= 8;
  }

  heading(text: string) {
    this.ensureSpace(28);
    this.y -= 6;
    this.page.drawText(pdfText(text), { x: this.left, y: this.y, size: 13, font: this.bold, color: rgb(0.13, 0.12, 0.18) });
    this.y -= 18;
  }

  paragraph(text: string) {
    this.ensureSpace(16);
    this.page.drawText(pdfText(text), { x: this.left, y: this.y, size: 9.5, font: this.font, color: rgb(0.3, 0.28, 0.38) });
    this.y -= 15;
  }

  keyValue(pairs: Array<[string, string]>) {
    for (const [k, v] of pairs) {
      this.ensureSpace(15);
      this.page.drawText(pdfText(k), { x: this.left, y: this.y, size: 9.5, font: this.bold, color: rgb(0.42, 0.41, 0.5) });
      this.page.drawText(pdfText(v), { x: this.left + 130, y: this.y, size: 9.5, font: this.font, color: rgb(0.13, 0.12, 0.18) });
      this.y -= 15;
    }
    this.y -= 6;
  }

  /** Empty-state line for a section that legitimately has no rows. */
  emptyNote(text: string) {
    this.ensureSpace(15);
    this.page.drawText(pdfText(text), { x: this.left, y: this.y, size: 9, font: this.font, color: rgb(0.55, 0.53, 0.63) });
    this.y -= 18;
  }

  table(columns: ReportColumn[], rows: Row[]) {
    const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);
    const usableWidth = this.right - this.left;
    if (totalWidth > usableWidth) {
      // Fails loudly instead of silently printing the rightmost columns
      // past the page edge — caught exactly this bug while building the
      // first few reports (two column sets summed past the page width).
      throw new Error(
        `Report table columns total ${totalWidth}pt, wider than the ${usableWidth}pt page width — narrow them`
      );
    }
    const drawHeaderRow = () => {
      this.ensureSpace(20);
      let x = this.left;
      for (const col of columns) {
        this.page.drawText(pdfText(col.header), { x, y: this.y, size: 8.5, font: this.bold, color: rgb(0.42, 0.41, 0.5) });
        x += col.width;
      }
      this.y -= 14;
      this.page.drawLine({
        start: { x: this.left, y: this.y + 4 },
        end: { x: this.right, y: this.y + 4 },
        thickness: 0.5,
        color: rgb(0.85, 0.84, 0.9),
      });
      this.y -= 4;
    };

    drawHeaderRow();
    if (!rows.length) {
      this.emptyNote("No records for this selection.");
      return;
    }
    this.onPageBreak = drawHeaderRow;
    for (const row of rows) {
      this.ensureSpace(16);
      let x = this.left;
      for (const col of columns) {
        const value = row[col.key];
        const text = value === null || value === undefined ? "—" : String(value);
        this.page.drawText(pdfText(truncate(text, col.width)), { x, y: this.y, size: 8.5, font: this.font, color: rgb(0.13, 0.12, 0.18) });
        x += col.width;
      }
      this.y -= 14;
    }
    this.onPageBreak = null;
    this.y -= 8;
  }

  async save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}

/** Rough width-per-char in Helvetica scales close to linearly with size —
 *  4.6pt/char was measured at size 8.5, so other call sites (the COA PDF's
 *  own table, at size 9) pass their own size instead of inheriting a
 *  slightly-too-generous estimate. */
export function truncate(text: string, colWidth: number, size = 8.5): string {
  const maxChars = Math.floor(colWidth / (4.6 * (size / 8.5)));
  return text.length > maxChars ? text.slice(0, Math.max(0, maxChars - 1)) + "…" : text;
}

// ---------------------------------------------------------------- xlsx

export interface XlsxSection {
  heading?: string;
  keyValue?: Array<[string, string]>;
  table?: { columns: ReportColumn[]; rows: Row[] };
}

export function buildReportXlsx(branding: Branding, title: string, subtitle: string | undefined, sections: XlsxSection[]): Uint8Array {
  const aoa: unknown[][] = [];
  if (branding.company_name) aoa.push([branding.company_name]);
  aoa.push([title]);
  if (subtitle) aoa.push([subtitle]);
  aoa.push([`Generated ${new Date().toLocaleString()}`]);
  aoa.push([]);

  for (const section of sections) {
    if (section.heading) {
      aoa.push([section.heading]);
    }
    if (section.keyValue) {
      for (const [k, v] of section.keyValue) aoa.push([k, v]);
      aoa.push([]);
    }
    if (section.table) {
      aoa.push(section.table.columns.map((c) => c.header));
      if (section.table.rows.length) {
        for (const row of section.table.rows) {
          aoa.push(section.table.columns.map((c) => row[c.key] ?? ""));
        }
      } else {
        aoa.push(["No records for this selection."]);
      }
      aoa.push([]);
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = Array.from({ length: 8 }, () => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, "Report");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

export function reportFilename(base: string, format: "pdf" | "xlsx"): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}-${stamp}.${format}`;
}

export function reportResponse(bytes: Uint8Array, filename: string, format: "pdf" | "xlsx"): Response {
  const contentType =
    format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return new Response(bytes, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
