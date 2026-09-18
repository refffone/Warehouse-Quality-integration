-- One-time specs: a spec written for a single received line, for a
-- material that has no spec yet (typically a sample or a first supply that
-- needs a printable COA). It is tested against and printed like any spec,
-- but never becomes the material's spec: it doesn't appear on the
-- Specifications screen, has no version history, and doesn't count when
-- the material's own versions are numbered.
--
-- A one-time spec is a spec with receipt_line_id set; the material's own
-- specs have none. (Rebuilding specs to add a status value isn't possible
-- on D1: dropping the old table trips the foreign keys pointing at it.)

-- (Fails on a re-run, stopping the file before anything below repeats.)
ALTER TABLE specs ADD COLUMN receipt_line_id INTEGER REFERENCES receipt_lines(id);

-- The material's rules apply to its own specs only.
DROP INDEX IF EXISTS idx_specs_one_active_per_scope;
CREATE UNIQUE INDEX idx_specs_one_active_per_scope
  ON specs(material_code, scope, COALESCE(variant, ''))
  WHERE status = 'active' AND receipt_line_id IS NULL;
DROP INDEX IF EXISTS idx_specs_scope_version;
CREATE UNIQUE INDEX idx_specs_scope_version
  ON specs(material_code, scope, COALESCE(variant, ''), version)
  WHERE receipt_line_id IS NULL;

-- At most one one-time spec per line.
CREATE UNIQUE INDEX idx_specs_one_time_line ON specs(receipt_line_id) WHERE receipt_line_id IS NOT NULL;
