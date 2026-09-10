-- Who physically sent a sample (may differ from a full supplier contact).
-- Only meaningful for type='sample' receipts.
ALTER TABLE receipts ADD COLUMN sample_sent_by TEXT;

-- Defensive: never let an import carry this field.
-- (SQLite table-level CHECK constraints can't be added via ALTER TABLE,
-- so this is enforced in application code instead — see setSampleSender
-- and createReceipt in src/routes/receipts.ts.)
