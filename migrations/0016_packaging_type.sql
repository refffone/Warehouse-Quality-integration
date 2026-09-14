-- Packaging type per material line (how it physically arrived: drums,
-- IBC, tank, bags on pallets, or pallets) plus a couple of optional
-- per-batch numbers that only make sense for some of those types
-- (weight per drum/IBC, bags per pallet, total bag/unit count). The
-- existing qty_as_received stays the one required "primary quantity"
-- column for every type (count, tank weight, or pallet count) so
-- everything already built on it (weigh-in variance, reports, COA)
-- keeps working unchanged.
ALTER TABLE receipt_lines ADD COLUMN packaging_type TEXT
  CHECK (packaging_type IN ('drum', 'ibc', 'tank', 'bags_pallet', 'pallets'));

ALTER TABLE receipt_batches ADD COLUMN per_unit_weight REAL;
ALTER TABLE receipt_batches ADD COLUMN qty_secondary REAL;
ALTER TABLE receipt_batches ADD COLUMN total_units REAL;
