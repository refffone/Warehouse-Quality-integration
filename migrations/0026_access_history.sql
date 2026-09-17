-- Room for the inspection history migrated from Quality's Access log
-- (RM Master Data):
--   * receipts.legacy_ref — the Access record a receipt came from
--     ("access:RM Master Data:<ID>"). Unique, so the import can be run
--     again without duplicating anything.
--   * receipts.received_at_unknown — 686 Access records have no date.
--     They keep a placeholder received_at (1970-01-01) that the app shows
--     as "date unknown" and date-based reports never match.
--   * batch_test_results.result may be NULL ("not judged"): Access stored
--     measured values only, and a value like "Colorless liquid" can't be
--     judged automatically.
--
-- Re-run safe: the first ALTER fails on a repeat run and stops the file.

ALTER TABLE receipts ADD COLUMN legacy_ref TEXT;
ALTER TABLE receipts ADD COLUMN received_at_unknown INTEGER NOT NULL DEFAULT 0 CHECK (received_at_unknown IN (0, 1));
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_legacy_ref ON receipts(legacy_ref) WHERE legacy_ref IS NOT NULL;

-- Nothing references batch_test_results, so it can be rebuilt directly.
PRAGMA defer_foreign_keys = on;
CREATE TABLE batch_test_results_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES receipt_batches(id),
  spec_parameter_id INTEGER NOT NULL REFERENCES spec_parameters(id),
  measured_value TEXT,
  result TEXT CHECK (result IN ('pass', 'fail')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  auto_result TEXT CHECK (auto_result IN ('pass', 'fail')),
  override_reason TEXT,
  -- a result nobody judged still has to say what was measured
  CHECK (result IS NOT NULL OR measured_value IS NOT NULL)
);
INSERT INTO batch_test_results_new (id, batch_id, spec_parameter_id, measured_value, result, created_at, auto_result, override_reason)
SELECT id, batch_id, spec_parameter_id, measured_value, result, created_at, auto_result, override_reason FROM batch_test_results;
DROP TABLE batch_test_results;
ALTER TABLE batch_test_results_new RENAME TO batch_test_results;
CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_test_results_batch_param ON batch_test_results(batch_id, spec_parameter_id);
PRAGMA defer_foreign_keys = off;
