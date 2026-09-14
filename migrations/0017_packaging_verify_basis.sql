-- A material line's packaging_type (0016) doesn't say whether the
-- supplier's paperwork states its quantity as a weight or as a unit
-- count — a drum/IBC/bags-on-pallets shipment can be declared either
-- way ("40 drums" vs "1,000 kg"; "400 bags" vs "4,000 kg"), and
-- warehouse verifies against whichever the paperwork used. Tank is
-- always weight, "pallets" (of discrete packaging-material units) is
-- always count, so only drum/ibc/bags_pallet actually need the choice
-- — but it's stored for every line, since a line's own packaging type
-- already gates whether it's shown/asked for in the UI.
ALTER TABLE receipt_lines ADD COLUMN qty_basis TEXT CHECK (qty_basis IN ('weight', 'count'));

-- The physically-counted container quantity (drums/IBCs/pallets) —
-- distinct from qty_as_received, which is now the *computed* total in
-- whichever basis was chosen (e.g. containers × weight/unit). Kept
-- purely as the breakdown that produced that total, shown for
-- reference on the receipt.
ALTER TABLE receipt_batches ADD COLUMN container_qty REAL;
