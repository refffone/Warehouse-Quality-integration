-- Core master data

CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE materials (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  requires_expiry INTEGER NOT NULL DEFAULT 1 CHECK (requires_expiry IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE specs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_code TEXT NOT NULL REFERENCES materials(code),
  title TEXT NOT NULL,
  criteria TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_specs_material_code ON specs(material_code);

-- Internal batch numbering: pattern config (one row per supplier, or a
-- single supplier_id IS NULL row as the global default) and a separate
-- per supplier+month running counter incremented atomically.

CREATE TABLE batch_number_schemes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER REFERENCES suppliers(id),
  pattern_template TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_batch_number_schemes_supplier ON batch_number_schemes(supplier_id);

CREATE TABLE batch_number_counters (
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  period_key TEXT NOT NULL, -- e.g. "0926" for Sep 2026
  current_sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (supplier_id, period_key)
);

-- Receipts: Receipt -> ReceiptLine -> ReceiptBatch

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('import', 'sample')),
  received_at TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'decided')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_receipts_supplier ON receipts(supplier_id);
CREATE INDEX idx_receipts_status ON receipts(status);

CREATE TABLE receipt_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id),
  material_code TEXT REFERENCES materials(code),
  material_name_text TEXT NOT NULL,
  unit TEXT NOT NULL
);

CREATE INDEX idx_receipt_lines_receipt ON receipt_lines(receipt_id);
CREATE INDEX idx_receipt_lines_material ON receipt_lines(material_code);

CREATE TABLE receipt_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_line_id INTEGER NOT NULL REFERENCES receipt_lines(id),
  supplier_batch_no TEXT NOT NULL,
  qty_as_received REAL NOT NULL,
  qty_accepted REAL,
  qty_rejected REAL,
  qty_actual_weighed REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'partial')),
  internal_batch_no TEXT,
  expiry_date TEXT,
  coa_remarks TEXT,
  coa_file_ref TEXT,
  decided_by TEXT,
  decided_at TEXT
);

CREATE INDEX idx_receipt_batches_line ON receipt_batches(receipt_line_id);
CREATE INDEX idx_receipt_batches_status ON receipt_batches(status);
CREATE INDEX idx_receipt_batches_expiry ON receipt_batches(expiry_date);
CREATE UNIQUE INDEX idx_receipt_batches_internal_no ON receipt_batches(internal_batch_no);

-- Notifications

CREATE TABLE notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_role TEXT NOT NULL CHECK (target_role IN ('warehouse', 'quality')),
  receipt_id INTEGER REFERENCES receipts(id),
  batch_id INTEGER REFERENCES receipt_batches(id),
  kind TEXT NOT NULL CHECK (kind IN ('new_receipt', 'decision', 'expiry_alert')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TEXT
);

CREATE INDEX idx_notification_events_role_unread ON notification_events(target_role, read_at);

-- Expiry alerting: which lead times to alert on, and which (batch, lead
-- time) pairs have already fired so the daily job doesn't re-notify.

CREATE TABLE expiry_alerts_sent (
  batch_id INTEGER NOT NULL REFERENCES receipt_batches(id),
  lead_time_days INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (batch_id, lead_time_days)
);
