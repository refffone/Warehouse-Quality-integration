import { error, json } from "../http";
import type { Attachment, AttachmentKind, Env } from "../types";

const KINDS: AttachmentKind[] = ["photo", "tds", "msds"];

// The pinned @cloudflare/workers-types version types FormData.get() as
// string | null (it doesn't know about File), even though the Workers
// runtime returns an actual File for a file field. Narrow structurally
// instead of `instanceof File`.
export interface UploadedFile {
  name: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UploadedFile).arrayBuffer === "function" &&
    typeof (value as UploadedFile).name === "string"
  );
}

export async function uploadAttachment(request: Request, env: Env, receiptLineId: number): Promise<Response> {
  const line = await env.DB.prepare("SELECT id, import_code FROM receipt_lines WHERE id = ?")
    .bind(receiptLineId)
    .first<{ id: number; import_code: string | null }>();
  if (!line) return error("Receipt line not found", 404);
  if (!line.import_code) {
    return error("This line has no import code yet — decide its first batch before attaching files", 400);
  }

  const form = await request.formData();
  const file = form.get("file");
  const kind = form.get("kind");
  const uploadedBy = form.get("uploaded_by");
  if (!isUploadedFile(file)) return error("file is required", 400);
  if (typeof kind !== "string" || !KINDS.includes(kind as AttachmentKind)) {
    return error(`kind must be one of: ${KINDS.join(", ")}`, 400);
  }
  if (typeof uploadedBy !== "string" || !uploadedBy.trim()) return error("uploaded_by is required", 400);

  const r2Key = `attachments/${receiptLineId}/${crypto.randomUUID()}-${file.name}`;
  const bytes = await file.arrayBuffer();
  await env.ATTACHMENTS.put(r2Key, bytes, {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  const row = await env.DB.prepare(
    `INSERT INTO attachments (receipt_line_id, kind, filename, content_type, size_bytes, r2_key, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id`
  )
    .bind(receiptLineId, kind, file.name, file.type || "application/octet-stream", bytes.byteLength, r2Key, uploadedBy)
    .first<{ id: number }>();

  return json({ id: row!.id }, 201);
}

export async function listAttachmentsForLine(env: Env, receiptLineId: number): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT * FROM attachments WHERE receipt_line_id = ? ORDER BY uploaded_at DESC"
  )
    .bind(receiptLineId)
    .all<Attachment>();
  return json(rows.results ?? []);
}

export async function downloadAttachment(env: Env, attachmentId: number): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(attachmentId)
    .first<Attachment>();
  if (!row) return error("Attachment not found", 404);

  const object = await env.ATTACHMENTS.get(row.r2_key);
  if (!object) return error("File missing from storage", 404);

  return new Response(object.body, {
    headers: {
      "content-type": row.content_type,
      "content-disposition": `attachment; filename="${row.filename}"`,
    },
  });
}

export async function deleteAttachment(env: Env, attachmentId: number): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(attachmentId)
    .first<Attachment>();
  if (!row) return error("Attachment not found", 404);

  await env.ATTACHMENTS.delete(row.r2_key);
  await env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(attachmentId).run();

  return json({ id: attachmentId, deleted: true });
}
