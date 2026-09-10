-- Production date, alongside the expiry date already captured at decision time.
ALTER TABLE receipt_batches ADD COLUMN production_date TEXT;

-- Import code: flags novelty of (material_code, material_name, supplier) at
-- Quality's first review of a receipt line. Separate from internal_batch_no
-- (assigned per batch, only on approve/partial) — this is per line, assigned
-- regardless of decision outcome.
ALTER TABLE receipt_lines ADD COLUMN import_code TEXT;
ALTER TABLE receipt_lines ADD COLUMN import_scenario TEXT
  CHECK (import_scenario IN ('new_material', 'new_supplier', 'new_name_variant', 'repeat'));

CREATE UNIQUE INDEX idx_receipt_lines_import_code ON receipt_lines(import_code)
  WHERE import_code IS NOT NULL;

-- Atomic counter of "how many times this material has been received from
-- this supplier" (name is NOT part of the key: it's used for scenario
-- detection only, in generateImportCode's existence checks, not for a
-- separate count — keying the counter by name too would let two different
-- name variants under the same material+supplier both start at seq 1 and
-- collide on the same generated code).
CREATE TABLE import_code_sequences (
  material_code TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  current_sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (material_code, supplier_id)
);

-- Single global, Quality-editable pattern (mirrors batch_number_schemes).
CREATE TABLE import_code_scheme (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pattern_template TEXT NOT NULL DEFAULT '{material_code}-{supplier_code}-{seq:03d}'
);
INSERT INTO import_code_scheme (id, pattern_template) VALUES (1, '{material_code}-{supplier_code}-{seq:03d}');
