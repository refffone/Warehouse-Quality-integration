-- Links a new batch to the specific rejected batch it's a retest of (e.g.
-- the supplier reworked/resent material after a rejection). Nullable and
-- one-directional (points from the new batch back to the old one) — the
-- reverse view ("this old batch was retested as X") is derived by lookup,
-- not stored twice.
ALTER TABLE receipt_batches ADD COLUMN retest_of_batch_id INTEGER REFERENCES receipt_batches(id);
