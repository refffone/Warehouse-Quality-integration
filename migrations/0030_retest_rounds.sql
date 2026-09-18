-- Retesting a decided batch. A retest is a new round on the same batch
-- (not a new receipt): receipt_batches always holds the round in
-- progress or the latest decided one; each finished earlier round is kept
-- in batch_rounds, and its test results keep their round number.
-- (The existing "retest of" link is a different thing: a new delivery that
-- replaces a rejected batch.)

-- (Fails on a re-run, stopping the file before anything below repeats.)
ALTER TABLE receipt_batches ADD COLUMN current_round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE receipt_batches ADD COLUMN retest_reason TEXT
  CHECK (retest_reason IS NULL OR retest_reason IN ('shelf_life', 'complaint', 'doubt', 'other'));
ALTER TABLE receipt_batches ADD COLUMN retest_note TEXT;
ALTER TABLE receipt_batches ADD COLUMN retest_started_by TEXT;
ALTER TABLE receipt_batches ADD COLUMN retest_started_at TEXT;
-- Stock held while a retest runs (shown to Warehouse); lifted on decision.
ALTER TABLE receipt_batches ADD COLUMN on_hold INTEGER NOT NULL DEFAULT 0 CHECK (on_hold IN (0, 1));

-- NULL = the batch's current round.
ALTER TABLE batch_test_results ADD COLUMN round_no INTEGER;
DROP INDEX IF EXISTS idx_batch_test_results_batch_param;
CREATE UNIQUE INDEX idx_batch_test_results_batch_param
  ON batch_test_results(batch_id, spec_parameter_id, COALESCE(round_no, 0));

-- A finished round, as it was decided.
CREATE TABLE batch_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES receipt_batches(id),
  round_no INTEGER NOT NULL,
  -- Why this round was run; NULL for round 1 (the batch was received).
  reason TEXT,
  note TEXT,
  started_by TEXT,
  started_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('approved', 'rejected', 'partial')),
  concession INTEGER NOT NULL DEFAULT 0,
  concession_reason TEXT,
  concession_approved_by TEXT,
  qty_accepted REAL,
  qty_rejected REAL,
  internal_batch_no TEXT,
  expiry_date TEXT,
  production_date TEXT,
  coa_remarks TEXT,
  decided_by TEXT,
  decided_at TEXT,
  tested_by TEXT,
  tested_at TEXT,
  archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_batch_rounds_batch_round ON batch_rounds(batch_id, round_no);
