-- Internal batch numbers in Access look like MHND000926: a short supplier
-- abbreviation, then a 4-digit sequence, then the 2-digit year. The
-- sequence counts batches of *one material* from that abbreviation in that
-- year (GF1000 and VX1001 from the same supplier each have their own 0001),
-- so the same batch number legitimately appears on different materials.
--
-- Re-run safe: only the ALTER errors on a repeat run.

ALTER TABLE suppliers ADD COLUMN abbreviation TEXT;

-- scope is the supplier's abbreviation (upper-cased), or "#<supplier id>"
-- for a supplier that doesn't have one yet. Keyed by abbreviation rather
-- than supplier id because Access counts per abbreviation.
CREATE TABLE IF NOT EXISTS batch_seq_counters (
  scope TEXT NOT NULL,
  material_code TEXT NOT NULL,
  period_key TEXT NOT NULL, -- "2026" for a yearly pattern, "0926" for a monthly one
  current_sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, material_code, period_key)
);

-- Batch numbers are now unique per material, not across the whole
-- database — enforced in decideBatch, since the material code lives on
-- receipt_lines and an index can't span two tables.
DROP INDEX IF EXISTS idx_receipt_batches_internal_no;
CREATE INDEX IF NOT EXISTS idx_receipt_batches_internal_no_lookup ON receipt_batches(internal_batch_no);

-- Switch the global default to the Access format, but only if it's still
-- the old built-in default — a pattern Quality deliberately customized is
-- left alone.
UPDATE batch_number_schemes
SET pattern_template = '{supplier_abbr}{seq:04d}{YY}'
WHERE supplier_id IS NULL AND pattern_template = '{supplier_code}{MMYY}{seq:04d}';
