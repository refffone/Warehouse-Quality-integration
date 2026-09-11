-- receipts.type had no index, unlike supplier_id/status — yet it's the one
-- filter every To Do/History screen load actually queries by
-- (GET /api/receipts?type=import|sample ORDER BY created_at DESC), forcing
-- a full table scan on every visit as the receipts table grows. Composite
-- on (type, created_at) so the same index also satisfies the ORDER BY,
-- covering the exact query pattern used — leftmost prefix still serves a
-- plain type filter too.
CREATE INDEX idx_receipts_type_created ON receipts(type, created_at DESC);
