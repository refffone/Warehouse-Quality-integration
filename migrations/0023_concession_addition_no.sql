-- "Accepted with concession" (مقبول بتجاوز) from the Access log: the batch
-- is released for use (status stays 'approved', so every downstream
-- weigh-in/expiry/report rule treats it as accepted) but is flagged, with
-- the reason and who authorized it — in Access that was typed into the
-- free-text notes ("بمعرفة م/فاروق ...").
ALTER TABLE receipt_batches ADD COLUMN concession INTEGER NOT NULL DEFAULT 0 CHECK (concession IN (0, 1));
ALTER TABLE receipt_batches ADD COLUMN concession_reason TEXT;
ALTER TABLE receipt_batches ADD COLUMN concession_approved_by TEXT;

-- Warehouse addition-note number (رقم اذن الاضافة), recorded when the
-- warehouse finalizes the actual quantity.
ALTER TABLE receipt_batches ADD COLUMN addition_no TEXT;
