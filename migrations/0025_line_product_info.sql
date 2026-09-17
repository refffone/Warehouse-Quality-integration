-- Product details Quality records for what actually arrived, as the Access
-- "RM MS Data" form did per inspection record: a product description
-- (usually from the TDS), the manufacturer and the country of origin.
-- Kept per received line, not per material code, because one code arrives
-- under different product names and suppliers (87 codes in Access carry
-- more than one description). Quality-only: never sent to Warehouse.
--
-- Re-run safe: the first ALTER fails on a repeat run and stops the file.
ALTER TABLE receipt_lines ADD COLUMN product_description TEXT;
ALTER TABLE receipt_lines ADD COLUMN manufacturer TEXT;
ALTER TABLE receipt_lines ADD COLUMN origin TEXT;
