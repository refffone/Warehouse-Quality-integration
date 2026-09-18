-- Matching samples to materials. A sample of an unknown material carries a
-- stand-in material (its own RMS number, see public/materialCodes.js) until
-- Quality matches it: to an existing material (an alternative), or — when
-- the supplier's first supply arrives — to a new code created for that
-- supply. This records which supply a sample led to.

-- (Fails on a re-run, stopping the file before anything below repeats.)
ALTER TABLE receipt_lines ADD COLUMN matched_supply_line_id INTEGER REFERENCES receipt_lines(id);
CREATE INDEX idx_receipt_lines_matched_supply ON receipt_lines(matched_supply_line_id)
  WHERE matched_supply_line_id IS NOT NULL;

-- Samples registered without a material code get their stand-in now, so
-- they can be tested like every other sample.
INSERT OR IGNORE INTO materials (code, name, unit, requires_expiry)
SELECT rl.import_code, rl.material_name_text, rl.unit, 0
FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id
WHERE r.type = 'sample' AND rl.material_code IS NULL AND rl.import_code IS NOT NULL;
UPDATE receipt_lines SET material_code = import_code
WHERE material_code IS NULL AND import_code IS NOT NULL
  AND receipt_id IN (SELECT id FROM receipts WHERE type = 'sample');
