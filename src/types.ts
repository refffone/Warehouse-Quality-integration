export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  EXPIRY_ALERT_LEAD_DAYS: string;
}

export type Role = "warehouse" | "quality";
export type ReceiptType = "import" | "sample";
export type ReceiptStatus = "pending" | "in_review" | "decided";
export type BatchStatus = "pending" | "approved" | "rejected" | "partial";
export type NotificationKind = "new_receipt" | "decision" | "expiry_alert";

export interface Supplier {
  id: number;
  code: string;
  name: string;
}

export interface Material {
  code: string;
  name: string;
  unit: string;
  requires_expiry: 0 | 1;
  created_at: string;
}

export interface Receipt {
  id: number;
  type: ReceiptType;
  received_at: string;
  supplier_id: number;
  created_by: string;
  status: ReceiptStatus;
  created_at: string;
}

export interface ReceiptLine {
  id: number;
  receipt_id: number;
  material_code: string | null;
  material_name_text: string;
  unit: string;
}

export interface ReceiptBatch {
  id: number;
  receipt_line_id: number;
  supplier_batch_no: string;
  qty_as_received: number;
  qty_accepted: number | null;
  qty_rejected: number | null;
  qty_actual_weighed: number | null;
  status: BatchStatus;
  internal_batch_no: string | null;
  expiry_date: string | null;
  coa_remarks: string | null;
  coa_file_ref: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

export interface NewReceiptBatchInput {
  supplier_batch_no: string;
  qty_as_received: number;
}

export interface NewReceiptLineInput {
  material_code?: string | null;
  material_name_text: string;
  unit: string;
  batches: NewReceiptBatchInput[];
}

export interface NewReceiptInput {
  type: ReceiptType;
  received_at: string;
  supplier_code: string;
  created_by: string;
  lines: NewReceiptLineInput[];
}

export interface BatchDecisionInput {
  decision: "approve" | "reject" | "partial";
  decided_by: string;
  qty_accepted?: number;
  qty_rejected?: number;
  expiry_date?: string | null;
  internal_batch_no?: string; // override; auto-generated when omitted on approve/partial
  coa_remarks?: string | null;
}

export interface FinalizeWeightInput {
  qty_actual_weighed: number;
}
