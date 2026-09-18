import type { LimitType } from "../public/specLimits.js";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ATTACHMENTS: R2Bucket;
  EXPIRY_ALERT_LEAD_DAYS: string;
  /** Owner-only Admin panel password (Worker secret, never in source —
   *  see src/routes/admin.ts). Local dev value lives in .dev.vars. */
  ADMIN_PASSWORD: string;
  /** Bearer token for the nightly backup export (see
   *  src/routes/backup.ts and .github/workflows/backup.yml) — deliberately
   *  separate from ADMIN_PASSWORD so a leaked CI secret can only ever read
   *  a data dump, never reach the admin panel. Worker secret, never in
   *  source. Backup is unreachable (401) when unset. */
  BACKUP_TOKEN?: string;
  /** VAPID keypair for Web Push (see src/push.ts). Worker secrets — never
   *  in source. Push is silently skipped when these are unset, so local
   *  dev works fine without them. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export type Role = "warehouse" | "quality";
export type ReceiptType = "import" | "sample";
export type ReceiptStatus = "pending" | "in_review" | "decided";
export type BatchStatus = "pending" | "approved" | "rejected" | "partial";
export type NotificationKind = "new_receipt" | "decision" | "expiry_alert";

/** One row's outcome from an Excel import preview or commit — "error" rows
 *  never reach the database; a commit is refused outright while any exist
 *  (see importSuppliers/importMaterials), so the client always fixes the
 *  file and re-previews rather than wondering which half of an import
 *  actually landed. */
export interface ImportRowResult {
  row: number;
  code: string;
  action: "insert" | "update" | "error";
  message?: string;
}

export interface ImportSummary {
  rows: ImportRowResult[];
  inserts: number;
  updates: number;
  errors: number;
  /** false for a preview (dry run) — nothing was written yet. */
  committed: boolean;
}

export interface SupplierWithStats extends Supplier {
  /** Total receipts ever logged against this supplier (any status) — the
   *  one at-a-glance number the plain Suppliers list needs; everything
   *  deeper (pass rate, weight variance) lives in the two assessment
   *  tabs instead of being crammed into this list too. */
  total_receipts: number;
}

/** Per material code (or the shared bucket for still-uncoded lines, where
 *  material_code is null and material_name falls back to whatever was
 *  typed on the receipt), how much a supplier's paperwork claimed vs what
 *  Warehouse actually weighed in, for every batch that's been through the
 *  finalize-weight step. Only Warehouse does that step, so only Warehouse
 *  sees this — Quality's own supplier assessment is a separate, pass/fail
 *  based view. */
export interface SupplierWeightVariance {
  material_code: string | null;
  material_name: string;
  unit: string;
  batches: number;
  qty_as_received: number;
  qty_actual_weighed: number;
  /** (actual − as received) ÷ as received, as a percentage — negative
   *  means the supplier under-delivered relative to their own paperwork,
   *  positive means they over-delivered. Null when as-received is 0
   *  (shouldn't happen in practice, guarded anyway). */
  variance_pct: number | null;
}

export interface SupplierWeightAssessment {
  supplier: Supplier;
  /** batch-weighted average of each material's own variance_pct, not a
   *  cross-material quantity sum — see getSupplierWeightAssessment. */
  overall: { batches: number; variance_pct: number | null };
  by_material: SupplierWeightVariance[];
}

export interface Supplier {
  id: number;
  code: string;
  name: string;
  /** Short prefix for internal batch numbers (e.g. "MHND"). */
  abbreviation: string | null;
}

export interface Material {
  code: string;
  name: string;
  unit: string;
  requires_expiry: 0 | 1;
  type_code: string | null;
  subtype_code: string | null;
  function_code: string | null;
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

/** Independent classification axis from Type/Subtype: what the material
 *  is used for (e.g. Solvent, Binder, Packaging), not hierarchical. */
export interface MaterialFunction {
  code: string;
  name: string;
}

/** How a spec parameter expresses its limit — see public/specLimits.js. */
export type ParamType = LimitType;

/** Supply specs apply to imports; sample specs to samples (falling back to
 *  the supply spec when a material has no sample spec). */
export type SpecScope = "supply" | "sample";

export interface ParameterInput {
  /** A test from the catalog; fills in name/method/unit when those are blank. */
  test_code?: string | null;
  parameter_name: string;
  param_type: ParamType;
  method?: string | null;
  /** Test conditions kept apart from the limit (cup, dilution, recipe). */
  conditions?: string | null;
  /** Numbers for numeric limits; seconds for time_range. */
  min_value?: number | null;
  max_value?: number | null;
  unit?: string | null;
  /** Expected appearance / what to compare against the reference sample. */
  expected_text?: string | null;
  /** target limit: the value, and (once known) the allowed ± tolerance. */
  target_value?: number | null;
  tolerance?: number | null;
  /** A note shown with the parameter, e.g. "As per TDS". */
  remarks?: string | null;
  sort_order?: number;
}

/** POST /api/receipt-lines/:id/spec — a spec for a line whose material has
 *  none: just for this line, or as the material's new version. */
export interface AddLineSpecInput {
  mode: "one_time" | "version";
  /** For "version": which of the material's specs to create. Defaults to
   *  the line's own (sample for a sample, supply otherwise). */
  scope?: SpecScope;
  title?: string | null;
  notes?: string | null;
  change_reason?: string | null;
  created_by: string;
  parameters: ParameterInput[];
}

export interface TestCatalogEntry {
  code: string;
  name: string;
  method_code: string | null;
  default_type: ParamType;
  default_unit: string | null;
  sort_order: number;
  active: 0 | 1;
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
  /** The Access record this receipt was migrated from, if any (the first
   *  one, when several Access records were one delivery). */
  legacy_ref: string | null;
  /** 1 when Access had no date: received_at then holds a placeholder. */
  received_at_unknown: 0 | 1;
  /** The receipt number people use: the warehouse addition-note serial, or
   *  QS-#### for a sample Quality received directly. Null for migrated
   *  records Access never numbered. */
  receipt_no: string | null;
  /** Who registered it. Quality-received samples are hidden from Warehouse. */
  received_by: Role;
}

export type ImportScenario = "new_material" | "new_supplier" | "new_name_variant" | "repeat";

/** The Access log's three kinds of record, each with its own code pool:
 *  sample -> RMS, first supply -> RMF, regular supply -> RMP. */
export type SupplyKind = "sample" | "first" | "regular";
export type CodePool = "RMS" | "RMF" | "RMP";

/** How the material physically arrived. Drives which breakdown fields
 *  (container_qty, per_unit_weight, qty_secondary) the wizard asks for. */
export type PackagingType = "drum" | "ibc" | "tank" | "bags_pallet" | "pallets";

/** Whether this line's supplier paperwork — and therefore its
 *  qty_as_received/qty_actual_weighed and every downstream weigh-in,
 *  variance, report, and COA figure — is a weight or a unit count.
 *  Fixed by packaging_type for tank (always "weight") and pallets
 *  (always "count"); a real choice for drum/ibc/bags_pallet, since a
 *  supplier can declare either "40 drums" or "1,000 kg" for the same
 *  shipment. */
export type QtyBasis = "weight" | "count";

export interface ReceiptLine {
  id: number;
  receipt_id: number;
  material_code: string | null;
  material_name_text: string;
  unit: string;
  packaging_type: PackagingType | null;
  qty_basis: QtyBasis | null;
  import_code: string | null;
  import_scenario: ImportScenario | null;
  supply_kind: SupplyKind | null;
  /** Quality-only product details (never sent to Warehouse). */
  product_description: string | null;
  manufacturer: string | null;
  origin: string | null;
  /** The Access record this line was migrated from ("access:RM Master
   *  Data:<ID>"), if any. */
  legacy_ref: string | null;
}

export interface LineProductInfoInput {
  product_description?: string | null;
  manufacturer?: string | null;
  origin?: string | null;
}

export interface ReceiptBatch {
  id: number;
  receipt_line_id: number;
  supplier_batch_no: string;
  /** The computed, warehouse-editable total in the line's qty_basis
   *  (e.g. containers × weight/unit, or containers × units/container) —
   *  the one figure every downstream weigh-in/variance/report/COA
   *  calculation reads, unchanged from before packaging types existed. */
  qty_as_received: number;
  /** Physically counted containers (drums/IBCs/pallets) — the raw
   *  breakdown behind qty_as_received, kept for reference only; not
   *  every batch fills it in (e.g. tank has none). */
  container_qty: number | null;
  /** Weight per drum/IBC/bag (only meaningful when qty_basis is "weight"). */
  per_unit_weight: number | null;
  /** Sub-units per container — bags per pallet, or units per pallet. */
  qty_secondary: number | null;
  qty_accepted: number | null;
  qty_rejected: number | null;
  qty_actual_weighed: number | null;
  status: BatchStatus;
  internal_batch_no: string | null;
  expiry_date: string | null;
  production_date: string | null;
  coa_remarks: string | null;
  decided_by: string | null;
  decided_at: string | null;
  tested_by: string | null;
  tested_at: string | null;
  /** Set when this batch is a resend/rework of a specific earlier
   *  rejected batch — e.g. the supplier fixed and resent the material. */
  retest_of_batch_id: number | null;
  /** 1 when approved as "accepted with concession" (مقبول بتجاوز). */
  concession: 0 | 1;
  concession_reason: string | null;
  concession_approved_by: string | null;
  /** Warehouse addition-note number (رقم اذن الاضافة). */
  addition_no: string | null;
}

export interface NewReceiptBatchInput {
  supplier_batch_no: string;
  qty_as_received: number;
  container_qty?: number | null;
  per_unit_weight?: number | null;
  qty_secondary?: number | null;
  retest_of_batch_id?: number | null;
}

export interface NewReceiptLineInput {
  material_code?: string | null;
  material_name_text: string;
  unit: string;
  packaging_type?: PackagingType | null;
  qty_basis?: QtyBasis | null;
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

export type TestResultOutcome = "pass" | "fail";

export interface TestResultInput {
  spec_parameter_id: number;
  measured_value?: string | null;
  /** null = recorded but not judged (needs a measured value). */
  result: TestResultOutcome | null;
  /** Required when `result` disagrees with the app's automatic judgement. */
  override_reason?: string | null;
}

export interface BatchTestResult {
  id: number;
  batch_id: number;
  spec_parameter_id: number;
  measured_value: string | null;
  /** null = not judged (e.g. an old Access value like "Colorless liquid"). */
  result: TestResultOutcome | null;
  auto_result: TestResultOutcome | null;
  override_reason: string | null;
  created_at: string;
}

export interface BatchDecisionInput {
  /** "concession" = accepted with concession (مقبول بتجاوز): stored as
   *  status "approved" with the concession flag set. */
  decision: "approve" | "concession" | "reject" | "partial";
  concession_reason?: string;
  concession_approved_by?: string;
  decided_by: string;
  qty_accepted?: number;
  qty_rejected?: number;
  expiry_date?: string | null;
  production_date?: string | null;
  internal_batch_no?: string; // override; auto-generated when omitted on approve/partial
  import_code?: string; // override; only applies to a line that has no code yet
  coa_remarks?: string | null;
}

export interface RecordTestResultsInput {
  tested_by: string;
  /** Measured value + pass/fail per spec parameter — the content of the
   *  batch's COA. Replaces any previously recorded results for this batch. */
  results: TestResultInput[];
}

export interface FinalizeWeightInput {
  qty_actual_weighed: number;
  /** Warehouse addition-note number (رقم اذن الاضافة). */
  addition_no?: string | null;
}

export interface SetLineClassificationInput {
  supply_kind: SupplyKind;
  /** Replaces the line's code instead of drawing the next one from the pool. */
  import_code?: string | null;
}

export type SpecStatus = "active" | "superseded";

export interface Spec {
  id: number;
  material_code: string;
  scope: SpecScope;
  /** null = the material's normal spec. A name (e.g. a manufacturer) marks
   *  an alternative spec for a code shared by two sources. */
  variant: string | null;
  version: number;
  status: SpecStatus;
  title: string;
  notes: string | null;
  change_reason: string | null;
  created_by: string;
  created_at: string;
  /** Set on a one-time spec: the received line it was written for. Null on
   *  the material's own specs. */
  receipt_line_id: number | null;
}

export interface SpecParameter {
  id: number;
  spec_id: number;
  test_code: string | null;
  parameter_name: string;
  param_type: ParamType;
  method: string | null;
  conditions: string | null;
  min_value: number | null;
  max_value: number | null;
  unit: string | null;
  expected_text: string | null;
  target_value: number | null;
  tolerance: number | null;
  remarks: string | null;
  sort_order: number;
}

export interface SpecWithParameters extends Spec {
  parameters: SpecParameter[];
}

export interface NewSpecInput {
  title: string;
  notes?: string | null;
  created_by: string;
  scope?: SpecScope;
  variant?: string | null;
  /** Why this version replaces the previous one. */
  change_reason?: string | null;
  /** Omit to auto-prefill from the material's subtype template, if any. */
  parameters?: ParameterInput[];
}

export interface SubtypeSpecTemplateInput {
  parameters: ParameterInput[];
}

export type AttachmentKind = "photo" | "tds" | "msds";

export interface Attachment {
  id: number;
  receipt_line_id: number;
  kind: AttachmentKind;
  filename: string;
  content_type: string;
  size_bytes: number;
  r2_key: string;
  uploaded_by: string;
  uploaded_at: string;
  deleted_at: string | null;
}

export interface DossierName {
  name: string;
  count: number;
  last_received_at: string;
}

export interface DossierBatchSummary {
  id: number;
  supplier_batch_no: string;
  status: BatchStatus;
  internal_batch_no: string | null;
  decided_at: string | null;
  concession: 0 | 1;
}

export interface DossierImportEntry {
  receipt_line_id: number;
  import_code: string;
  import_scenario: ImportScenario | null;
  material_name_text: string;
  product_description: string | null;
  manufacturer: string | null;
  origin: string | null;
  receipt_id: number;
  received_at: string;
  supplier_id: number;
  supplier_code: string;
  supplier_name: string;
  batches: DossierBatchSummary[];
  attachments: Attachment[];
}

export interface DossierStatusCounts {
  imports: number;
  approved: number;
  rejected: number;
  partial: number;
  pending: number;
  pass_rate: number | null;
}

export interface DossierSupplierMetrics extends DossierStatusCounts {
  supplier_id: number;
  supplier_code: string;
  supplier_name: string;
}

export interface MaterialDossier {
  material: Material;
  names: DossierName[];
  specs: SpecWithParameters[];
  rmf: DossierImportEntry[];
  rmp: DossierImportEntry[];
  rms: DossierImportEntry[];
  metrics: {
    overall: DossierStatusCounts;
    by_supplier: DossierSupplierMetrics[];
  };
}

export interface SupplierCodeMetrics extends DossierStatusCounts {
  material_code: string;
  material_name: string;
}

export interface SupplierRating {
  /** 0-5 stars, rounded from pass_rate. */
  stars: number;
  label: "Unrated" | "Very Poor" | "Poor" | "Fair" | "Good" | "Excellent";
  /** True when fewer than 5 decided batches back the rating — treat with caution. */
  low_volume: boolean;
}

export interface SupplierAssessment {
  supplier: Supplier;
  overall: DossierStatusCounts & { distinct_codes: number };
  rating: SupplierRating;
  codes: SupplierCodeMetrics[];
  best_code: SupplierCodeMetrics | null;
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
