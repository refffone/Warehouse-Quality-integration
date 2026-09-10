-- Testing and deciding are now separate actions: Quality can record test
-- results on a pending batch before making an approve/reject/partial call.
ALTER TABLE receipt_batches ADD COLUMN tested_by TEXT;
ALTER TABLE receipt_batches ADD COLUMN tested_at TEXT;
