-- Quality-managed material classification (self-service, not a hardcoded
-- enum): a small set of Types (e.g. RM, PKG) each with their own Subtypes
-- (e.g. RM/Solvents, PKG/Pail).

CREATE TABLE material_types (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE material_subtypes (
  code TEXT PRIMARY KEY,
  type_code TEXT NOT NULL REFERENCES material_types(code),
  name TEXT NOT NULL
);

CREATE INDEX idx_material_subtypes_type ON material_subtypes(type_code);

ALTER TABLE materials ADD COLUMN type_code TEXT REFERENCES material_types(code);
ALTER TABLE materials ADD COLUMN subtype_code TEXT REFERENCES material_subtypes(code);

-- Quality-managed default parameter checklist per subtype, so a new spec
-- for that subtype never starts from a blank list.

CREATE TABLE subtype_spec_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subtype_code TEXT NOT NULL REFERENCES material_subtypes(code),
  parameter_name TEXT NOT NULL,
  param_type TEXT NOT NULL CHECK (param_type IN ('numeric_range', 'pass_fail', 'time_range', 'text_value')),
  method TEXT,
  min_value REAL,
  max_value REAL,
  unit TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (param_type IN ('numeric_range', 'time_range') AND min_value IS NOT NULL AND max_value IS NOT NULL)
    OR (param_type IN ('pass_fail', 'text_value') AND min_value IS NULL AND max_value IS NULL)
  )
);

CREATE INDEX idx_subtype_spec_templates_subtype ON subtype_spec_templates(subtype_code);

-- Replace the old flat, free-text specs table with a versioned, structured
-- one. No prior spec data exists yet, so a clean drop/recreate is fine.

DROP TABLE specs;

CREATE TABLE specs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_code TEXT NOT NULL REFERENCES materials(code),
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  title TEXT NOT NULL,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_specs_material_code ON specs(material_code);
-- Enforce at most one active version per material at the DB level.
CREATE UNIQUE INDEX idx_specs_one_active_per_material
  ON specs(material_code) WHERE status = 'active';
CREATE UNIQUE INDEX idx_specs_material_version ON specs(material_code, version);

CREATE TABLE spec_parameters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id INTEGER NOT NULL REFERENCES specs(id),
  parameter_name TEXT NOT NULL,
  param_type TEXT NOT NULL CHECK (param_type IN ('numeric_range', 'pass_fail', 'time_range', 'text_value')),
  method TEXT,
  min_value REAL,
  max_value REAL,
  unit TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (param_type IN ('numeric_range', 'time_range') AND min_value IS NOT NULL AND max_value IS NOT NULL)
    OR (param_type IN ('pass_fail', 'text_value') AND min_value IS NULL AND max_value IS NULL)
  )
);

CREATE INDEX idx_spec_parameters_spec ON spec_parameters(spec_id);
