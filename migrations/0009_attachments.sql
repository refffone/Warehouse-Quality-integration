-- Supporting reference files (photo, TDS, MSDS) attached to a specific
-- import code, i.e. a specific (material, name, supplier) novelty event —
-- surfaced in the Master Data dossier per RMF/RMS. Actual file bytes live
-- in R2 (binding ATTACHMENTS); this row is metadata + the R2 object key.
CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_line_id INTEGER NOT NULL REFERENCES receipt_lines(id),
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'tds', 'msds')),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_attachments_receipt_line ON attachments(receipt_line_id);
