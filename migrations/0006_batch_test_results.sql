-- Structured test results, per spec parameter, per batch — the content of
-- a batch's COA. Entered by Quality alongside its decision (any outcome,
-- not just approve — a fail belongs on the record too).
CREATE TABLE batch_test_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES receipt_batches(id),
  spec_parameter_id INTEGER NOT NULL REFERENCES spec_parameters(id),
  measured_value TEXT,
  result TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_batch_test_results_batch_param ON batch_test_results(batch_id, spec_parameter_id);
