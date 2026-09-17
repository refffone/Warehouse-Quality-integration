// Uploads the files extracted by extract-access-attachments.ps1 to the
// migrated records, through the app's own attachment API (so they land in
// R2 exactly like files Quality attaches by hand).
//
// Run it yourself — it signs in with a Quality account whose credentials
// come from environment variables and are never written anywhere:
//
//   $env:APP_URL = "https://<your app>"
//   $env:QUALITY_USER = "..."; $env:QUALITY_PASSWORD = "..."
//   node scripts/upload-access-attachments.mjs "C:\Users\me\access-attachments\manifest.csv"
//
// Safe to run again: a file already attached to that record (same kind and
// file name) is skipped. Add --dry-run to only report what would happen.
import { readFileSync } from "node:fs";
import path from "node:path";

const manifestPath = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
const user = process.env.QUALITY_USER;
const password = process.env.QUALITY_PASSWORD;
if (!manifestPath || !base || !user || !password) {
  console.error("Usage: set APP_URL, QUALITY_USER, QUALITY_PASSWORD, then: node scripts/upload-access-attachments.mjs <manifest.csv> [--dry-run]");
  process.exit(1);
}

const CONTENT_TYPES = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

/** The file's real type from its first bytes, and a name that says so:
 *  Access holds PDFs saved as "x.pdf.crdownload" or with no extension. */
function describe(filePath, name) {
  const bytes = readFileSync(filePath);
  const head = bytes.subarray(0, 4);
  const sniffed =
    head.toString("latin1") === "%PDF" ? ".pdf"
    : head[0] === 0xff && head[1] === 0xd8 ? ".jpg"
    : head[0] === 0x89 && head.toString("latin1", 1, 4) === "PNG" ? ".png"
    : null;
  let cleanName = name.replace(/\.crdownload$/i, "");
  const ext = path.extname(cleanName).toLowerCase();
  if (sniffed && !(ext in CONTENT_TYPES)) cleanName += sniffed;
  const type = CONTENT_TYPES[path.extname(cleanName).toLowerCase()] ?? "application/octet-stream";
  return { bytes, name: cleanName, type };
}

/** Minimal CSV reader for the manifest (quoted fields, no embedded newlines). */
function parseCsv(text) {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean).map((line) => {
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(cell); cell = ""; }
      else cell += ch;
    }
    cells.push(cell);
    return cells;
  });
  const [header, ...body] = rows;
  return body.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
}

const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: user, password, role: "quality" }),
});
if (!login.ok) {
  console.error(`Sign-in failed: ${login.status} ${await login.text()}`);
  process.exit(1);
}
const cookie = login.headers.get("set-cookie").split(";")[0];
const api = (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { cookie, ...(init.headers ?? {}) } });

const entries = parseCsv(readFileSync(manifestPath, "utf8"));
const byRecord = new Map();
for (const e of entries) {
  if (!byRecord.has(e.legacy_ref)) byRecord.set(e.legacy_ref, []);
  byRecord.get(e.legacy_ref).push(e);
}

const tally = { uploaded: 0, skipped: 0, noRecord: 0, failed: 0 };
const problems = [];

async function handleRecord(ref, files) {
  const found = await api(`/api/receipt-lines/by-legacy-ref?ref=${encodeURIComponent(ref)}`);
  if (!found.ok) {
    tally.noRecord += files.length;
    problems.push(`${ref}: record not in the app (${found.status}) — ${files.length} file(s) not uploaded`);
    return;
  }
  const { line_id: lineId } = await found.json();
  const existing = await (await api(`/api/receipt-lines/${lineId}/attachments`)).json();
  const have = new Set(existing.map((a) => `${a.kind}|${a.filename}`));

  for (const f of files) {
    const file = describe(f.path, f.file_name);
    if (have.has(`${f.kind}|${file.name}`)) { tally.skipped++; continue; }
    if (dryRun) { tally.uploaded++; continue; }
    const form = new FormData();
    form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
    form.append("kind", f.kind);
    form.append("uploaded_by", "Access import");
    const res = await api(`/api/receipt-lines/${lineId}/attachments`, { method: "POST", body: form });
    if (res.ok) tally.uploaded++;
    else {
      tally.failed++;
      problems.push(`${ref} ${f.kind} ${f.file_name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }
}

// A few records at a time: fast enough, gentle on the Worker.
const queue = [...byRecord.entries()];
let done = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const [ref, files] = queue.shift();
      await handleRecord(ref, files);
      if (++done % 100 === 0) console.log(`${done}/${byRecord.size} records…`);
    }
  })
);

console.log(`${dryRun ? "[dry run] would upload" : "Uploaded"} ${tally.uploaded}, already there ${tally.skipped}, record missing ${tally.noRecord}, failed ${tally.failed}`);
for (const p of problems) console.log("  " + p);
process.exit(tally.failed ? 1 : 0);
