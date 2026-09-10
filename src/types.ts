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
  type_code: string | null;
  subtype_code: string | null;
  created_at: string;
}

export interface MaterialType {
  code: string;
  name: string;
}

export interface MaterialSubtype {
  code: string;
  type_code: string;
  name: string;
}

export type ParamType = "numeric_range" | "pass_fail" | "time_range" | "text_value";

export interface ParameterInput {
  parameter_name: string;
  param_type: ParamType;
  method?: string | null;
  min_value?: number | null;
  max_value?: number | null;
  unit?: string | null;
  sort_order?: number;
}

export interface Receipt {
  id: number;
  type: ReceiptType;
  received_at: string;
  supplier_id: number;
  created_by: string;
  status: ReceiptStatus;
  created_at: string;
  /** Who physically sent the sample. Only meaningful when type is "sample". */
  sample_sent_by: string | null;
}

export type ImportScenario = "new_material" | "new_supplier" | "new_name_variant" | "repeat";

export interface ReceiptLine {
  id: number;
  receipt_id: number;
  material_code: string | null;
  material_name_text: string;
  unit: string;
  import_code: string | null;
  import_scenario: ImportScenario | null;
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
  production_date: string | null;
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
  /** Sample tab only. If omitted here, warehouse loses the ability to add
   *  it later — only Quality can fill it in after the fact. */
  sample_sent_by?: string | null;
}

export interface SetSampleSenderInput {
  sample_sent_by: string;
}

export interface BatchDecisionInput {
  decision: "approve" | "reject" | "partial";
  decided_by: string;
  qty_accepted?: number;
  qty_rejected?: number;
  expiry_date?: string | null;
  production_date?: string | null;
  internal_batch_no?: string; // override; auto-generated when omitted on approve/partial
  import_code?: string; // override; auto-generated when omitted, only on the line's first decision
  coa_remarks?: string | null;
}

export interface FinalizeWeightInput {
  qty_actual_weighed: number;
}

export type SpecStatus = "active" | "superseded";

export interface Spec {
  id: number;
  material_code: string;
  version: number;
  status: SpecStatus;
  title: string;
  notes: string | null;
  created_by: string;
  created_at: string;
}

export interface SpecParameter {
  id: number;
  spec_id: number;
  parameter_name: string;
  param_type: ParamType;
  method: string | null;
  min_value: number | null;
  max_value: number | null;
  unit: string | null;
  sort_order: number;
}

export interface SpecWithParameters extends Spec {
  parameters: SpecParameter[];
}

export interface NewSpecInput {
  title: string;
  notes?: string | null;
  created_by: string;
  /** Omit to auto-prefill from the material's subtype template, if any. */
  parameters?: ParameterInput[];
}

export interface SubtypeSpecTemplateInput {
  parameters: ParameterInput[];
}

/** Quality associates an uncoded receipt line to a material code — either
 *  an existing one (whose active spec then applies) or a brand-new one,
 *  which requires creating its first spec version in the same step. */
export type AssociateCodeInput =
  | { mode: "existing"; material_code: string }
  | {
      mode: "new";
      new_material: {
        code: string;
        name: string;
        unit: string;
        requires_expiry?: boolean;
        type_code?: string | null;
        subtype_code?: string | null;
      };
      spec: { title: string; notes?: string | null; created_by: string; parameters?: ParameterInput[] };
    };
