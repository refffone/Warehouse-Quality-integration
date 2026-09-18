-- Receipt numbers, Quality-received samples, and grouping the Access history
-- into the deliveries it was actually received as.
--
-- 1. Every receipt gets a human receipt number (receipt_no). A warehouse
--    delivery's number is the addition note (رقم اذن الاضافة): the app
--    issues it, continuing the serial Quality's Access log was using. A
--    sample Quality receives directly gets its own series (QS-0001, ...)
--    so it never collides with the warehouse serial.
-- 2. received_by says who registered the receipt. Quality-received samples
--    are hidden from Warehouse entirely.
-- 3. The Access log has one record per material; records that share an
--    addition number, supplier and receiving day were one delivery, and are
--    merged here into one receipt with several lines. Each Access record's
--    reference moves to its line so it stays findable after the merge.

-- (Fails on a re-run, stopping the file before anything below repeats.)
ALTER TABLE receipts ADD COLUMN receipt_no TEXT;
ALTER TABLE receipts ADD COLUMN received_by TEXT NOT NULL DEFAULT 'warehouse'
  CHECK (received_by IN ('warehouse', 'quality'));

ALTER TABLE receipt_lines ADD COLUMN legacy_ref TEXT;
UPDATE receipt_lines
   SET legacy_ref = (SELECT r.legacy_ref FROM receipts r WHERE r.id = receipt_lines.receipt_id)
 WHERE legacy_ref IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipt_lines_legacy_ref
  ON receipt_lines(legacy_ref) WHERE legacy_ref IS NOT NULL;

-- A migrated record Access marked "not conforming" whose quantities still
-- split (e.g. 900 accepted, 180 rejected) was a partial acceptance. The
-- first import filed it as a full rejection.
UPDATE receipt_batches SET status = 'partial'
 WHERE status = 'rejected' AND qty_accepted > 0 AND qty_rejected > 0
   AND receipt_line_id IN (SELECT id FROM receipt_lines WHERE legacy_ref IS NOT NULL);

-- Numbering series. The warehouse serial continues below.
CREATE TABLE IF NOT EXISTS receipt_number_series (
  series TEXT PRIMARY KEY CHECK (series IN ('warehouse', 'quality_sample')),
  prefix TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  current_sequence INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO receipt_number_series (series, prefix, width, current_sequence) VALUES
  ('warehouse', '', 0, 0),
  ('quality_sample', 'QS-', 4, 0);

-- Migrated records: the addition number Access stored on the batch is the
-- receipt number.
UPDATE receipts
   SET receipt_no = (
     SELECT MIN(TRIM(rb.addition_no))
       FROM receipt_lines rl
       JOIN receipt_batches rb ON rb.receipt_line_id = rl.id
      WHERE rl.receipt_id = receipts.id
        AND rb.addition_no IS NOT NULL AND TRIM(rb.addition_no) NOT IN ('', '0')
   )
 WHERE legacy_ref IS NOT NULL AND receipt_no IS NULL;

-- Merge migrated records received together: same addition number, same
-- supplier, same kind (supply/sample) and same receiving day. Undated
-- records are never merged. The oldest receipt of each group is kept.
CREATE TABLE IF NOT EXISTS _receipt_merge (id INTEGER PRIMARY KEY, keeper INTEGER NOT NULL);
DELETE FROM _receipt_merge;
INSERT INTO _receipt_merge (id, keeper)
SELECT r.id,
       (SELECT MIN(k.id) FROM receipts k
         WHERE k.legacy_ref IS NOT NULL AND k.received_at_unknown = 0
           AND k.receipt_no = r.receipt_no AND k.supplier_id = r.supplier_id
           AND k.type = r.type AND date(k.received_at) = date(r.received_at))
  FROM receipts r
 WHERE r.legacy_ref IS NOT NULL AND r.received_at_unknown = 0 AND r.receipt_no IS NOT NULL;
DELETE FROM _receipt_merge WHERE id = keeper;

-- The kept receipt covers the whole delivery: earliest time, and still open
-- if any merged record was.
UPDATE receipts
   SET received_at = (SELECT MIN(x.received_at) FROM receipts x
                       WHERE x.id = receipts.id OR x.id IN (SELECT id FROM _receipt_merge WHERE keeper = receipts.id)),
       status = CASE WHEN EXISTS (SELECT 1 FROM receipts x JOIN _receipt_merge m ON m.id = x.id
                                   WHERE m.keeper = receipts.id AND x.status != 'decided')
                     THEN 'pending' ELSE status END
 WHERE id IN (SELECT keeper FROM _receipt_merge);

UPDATE receipt_lines
   SET receipt_id = (SELECT keeper FROM _receipt_merge WHERE id = receipt_lines.receipt_id)
 WHERE receipt_id IN (SELECT id FROM _receipt_merge);
UPDATE notification_events
   SET receipt_id = (SELECT keeper FROM _receipt_merge WHERE id = notification_events.receipt_id)
 WHERE receipt_id IN (SELECT id FROM _receipt_merge);
DELETE FROM receipts WHERE id IN (SELECT id FROM _receipt_merge);
DROP TABLE _receipt_merge;

-- Continue the warehouse serial from the most recent migrated delivery
-- (by date, not the largest number: Access has a few mistyped outliers).
-- New numbers skip any that are already taken, so an old number is never
-- reissued.
UPDATE receipt_number_series
   SET current_sequence = MAX(current_sequence, COALESCE((
     SELECT CAST(receipt_no AS INTEGER) FROM receipts
      WHERE legacy_ref IS NOT NULL AND receipt_no GLOB '[0-9]*' AND received_at_unknown = 0
      ORDER BY received_at DESC, id DESC LIMIT 1), 0))
 WHERE series = 'warehouse';

CREATE INDEX IF NOT EXISTS idx_receipts_receipt_no ON receipts(receipt_no);
-- Numbers the app issues are unique. Migrated ones can repeat (Access
-- reused a few), so they're left out of the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_receipt_no_new
  ON receipts(receipt_no) WHERE legacy_ref IS NULL AND receipt_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_received_by ON receipts(received_by);
