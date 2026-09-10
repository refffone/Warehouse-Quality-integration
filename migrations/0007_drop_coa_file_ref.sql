-- COA is generated on demand from recorded test results (PDF/Excel export),
-- not uploaded — this column was speculative scaffolding for an upload
-- feature the user decided against. Drop it rather than leave it dead.
ALTER TABLE receipt_batches DROP COLUMN coa_file_ref;
