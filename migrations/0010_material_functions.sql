-- Function: a Quality-managed, controlled list describing what a
-- material is used for (e.g. Solvent, Binder, Packaging) — an
-- independent classification axis from Type/Subtype, not hierarchical.
CREATE TABLE material_functions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

ALTER TABLE materials ADD COLUMN function_code TEXT REFERENCES material_functions(code);
