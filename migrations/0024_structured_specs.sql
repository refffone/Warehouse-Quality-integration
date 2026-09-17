-- Specs, structured the way Quality's Access spec sheets are laid out
-- (مواصفة مادة خام / مواصفة عينة مادة خام) but with real limits instead of
-- free text:
--   * a fixed catalog of tests, each with its own method code (Access's
--     24 test columns and their W-QC-01-xx codes);
--   * limit types beyond min–max: max only, min only, a single target value
--     (optionally ± a tolerance), appearance, compared-with-reference-sample;
--   * test conditions (cup, dilution, mixing recipe) kept apart from the limit;
--   * separate supply and sample specs, as Access keeps two tables;
--   * a per-parameter remark (e.g. "As per TDS");
--   * a spec "variant" column — groundwork for codes shared by two
--     manufacturers (AD1040: BYK and ADDITOL) that need different limits;
--   * a reason on each new version, and on any result that overrides the
--     app's automatic pass/fail.
--
-- The deploy workflow re-runs every migration file. The first statement
-- below fails on a second run, which stops the file before anything else
-- in it executes.

ALTER TABLE specs ADD COLUMN scope TEXT NOT NULL DEFAULT 'supply' CHECK (scope IN ('supply', 'sample'));
ALTER TABLE specs ADD COLUMN change_reason TEXT;
-- NULL = the material's normal spec, the one receipts are tested against.
-- A named variant (e.g. a manufacturer) is its own version history.
ALTER TABLE specs ADD COLUMN variant TEXT;

-- One active spec per material, scope and variant; versions numbered per
-- material, scope and variant.
DROP INDEX IF EXISTS idx_specs_one_active_per_material;
DROP INDEX IF EXISTS idx_specs_material_version;
CREATE UNIQUE INDEX IF NOT EXISTS idx_specs_one_active_per_scope
  ON specs(material_code, scope, COALESCE(variant, '')) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_specs_scope_version
  ON specs(material_code, scope, COALESCE(variant, ''), version);

CREATE TABLE IF NOT EXISTS test_catalog (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  method_code TEXT,
  default_type TEXT NOT NULL CHECK (default_type IN
    ('numeric_range', 'max', 'min', 'target', 'time_range', 'appearance', 'vs_standard', 'pass_fail', 'text_value')),
  default_unit TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- Access's test columns in their original order, each paired with the
-- method code in the same position (w1..w24). Access's "Comment" column is
-- a note, not a test, so it isn't listed; Gelling Time had no method code.
INSERT OR IGNORE INTO test_catalog (code, name, method_code, default_type, default_unit, sort_order) VALUES
  ('VISCOSITY',        'Viscosity',        'W-QC-01-01', 'time_range',    NULL,  1),
  ('DENSITY',          'Density',          'W-QC-01-04', 'numeric_range', NULL,  2),
  ('SOLID_CONTENT',    'Solid Content',    'W-QC-01-05', 'numeric_range', '%',   3),
  ('FINENESS',         'Fineness',         'W-QC-01-10', 'numeric_range', NULL,  4),
  ('GLOSS',            'Gloss',            'W-QC-01-16', 'numeric_range', NULL,  5),
  ('DRYING_TIME',      'Drying Time',      'W-QC-01-06', 'numeric_range', 'hr',  6),
  ('VISUAL_CHECK',     'Visual Check',     'W-QC-01-24', 'appearance',    NULL,  7),
  ('APPLICATION',      'Application',      'W-QC-01-17', 'vs_standard',   NULL,  8),
  ('SANDABILITY',      'Sandability',      'W-QC-01-20', 'vs_standard',   NULL,  9),
  ('PH',               'pH',               'W-QC-01-12', 'numeric_range', NULL, 10),
  ('TRANSPARENCY',     'Transparency',     'W-QC-01-14', 'appearance',    NULL, 11),
  ('REFRACTIVE_INDEX', 'Refractive Index', 'W-QC-01-15', 'numeric_range', NULL, 12),
  ('HARDNESS',         'Hardness',         'W-QC-01-08', 'numeric_range', NULL, 13),
  ('OIL_ABSORPTION',   'Oil Absorption',   'W-QC-01-26', 'numeric_range', '%',  14),
  ('MELTING_POINT',    'Melting Point',    'W-QC-01-27', 'numeric_range', '°C', 15),
  ('BOILING_POINT',    'Boiling Point',    'W-QC-01-28', 'numeric_range', '°C', 16),
  ('WATER_CONTENT',    'Water Content',    'W-QC-01-30', 'max',           '%',  17),
  ('ACID_VALUE',       'Acid Value',       'W-QC-01-29', 'max',           NULL, 18),
  ('TLC',              'TLC',              'W-QC-01-19', 'min',           '%',  19),
  ('PIGMENT',          'Pigment',          'W-QC-01-09', 'appearance',    NULL, 20),
  ('FLEXIBILITY',      'Flexibility',      'W-QC-01-32', 'vs_standard',   NULL, 21),
  ('POT_LIFE',         'Pot Life',         'W-QC-01-31', 'time_range',    NULL, 22),
  ('GELLING_TIME',     'Gelling Time',     NULL,         'time_range',    NULL, 23);

-- spec_parameters and subtype_spec_templates both carry a CHECK that only
-- knows the original four types, and SQLite can't change a CHECK in place,
-- so both are rebuilt. batch_test_results points at spec_parameters, so
-- foreign-key checks are deferred until the rebuilt table has its old
-- name (and every row its old id) back.
PRAGMA defer_foreign_keys = on;

CREATE TABLE spec_parameters_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id INTEGER NOT NULL REFERENCES specs(id),
  test_code TEXT REFERENCES test_catalog(code),
  parameter_name TEXT NOT NULL,
  param_type TEXT NOT NULL CHECK (param_type IN
    ('numeric_range', 'max', 'min', 'target', 'time_range', 'appearance', 'vs_standard', 'pass_fail', 'text_value')),
  method TEXT,
  conditions TEXT,
  min_value REAL,
  max_value REAL,
  unit TEXT,
  expected_text TEXT,
  -- target: a single value; tolerance (optional, added whenever Quality
  -- has one) turns it into target ± tolerance and makes it auto-judged.
  target_value REAL,
  tolerance REAL CHECK (tolerance IS NULL OR tolerance >= 0),
  remarks TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((min_value IS NOT NULL) = (param_type IN ('numeric_range', 'min', 'time_range'))),
  CHECK ((max_value IS NOT NULL) = (param_type IN ('numeric_range', 'max', 'time_range'))),
  CHECK ((target_value IS NOT NULL) = (param_type = 'target')),
  CHECK (tolerance IS NULL OR param_type = 'target')
);
INSERT INTO spec_parameters_new (id, spec_id, parameter_name, param_type, method, min_value, max_value, unit, sort_order)
SELECT id, spec_id, parameter_name, param_type, method, min_value, max_value, unit, sort_order FROM spec_parameters;
DROP TABLE spec_parameters;
ALTER TABLE spec_parameters_new RENAME TO spec_parameters;
CREATE INDEX IF NOT EXISTS idx_spec_parameters_spec ON spec_parameters(spec_id);

CREATE TABLE subtype_spec_templates_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subtype_code TEXT NOT NULL REFERENCES material_subtypes(code),
  test_code TEXT REFERENCES test_catalog(code),
  parameter_name TEXT NOT NULL,
  param_type TEXT NOT NULL CHECK (param_type IN
    ('numeric_range', 'max', 'min', 'target', 'time_range', 'appearance', 'vs_standard', 'pass_fail', 'text_value')),
  method TEXT,
  conditions TEXT,
  min_value REAL,
  max_value REAL,
  unit TEXT,
  expected_text TEXT,
  -- target: a single value; tolerance (optional, added whenever Quality
  -- has one) turns it into target ± tolerance and makes it auto-judged.
  target_value REAL,
  tolerance REAL CHECK (tolerance IS NULL OR tolerance >= 0),
  remarks TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CHECK ((min_value IS NOT NULL) = (param_type IN ('numeric_range', 'min', 'time_range'))),
  CHECK ((max_value IS NOT NULL) = (param_type IN ('numeric_range', 'max', 'time_range'))),
  CHECK ((target_value IS NOT NULL) = (param_type = 'target')),
  CHECK (tolerance IS NULL OR param_type = 'target')
);
INSERT INTO subtype_spec_templates_new (id, subtype_code, parameter_name, param_type, method, min_value, max_value, unit, sort_order)
SELECT id, subtype_code, parameter_name, param_type, method, min_value, max_value, unit, sort_order FROM subtype_spec_templates;
DROP TABLE subtype_spec_templates;
ALTER TABLE subtype_spec_templates_new RENAME TO subtype_spec_templates;
CREATE INDEX IF NOT EXISTS idx_subtype_spec_templates_subtype ON subtype_spec_templates(subtype_code);

PRAGMA defer_foreign_keys = off;

-- What the app judged from the measured value, and why a person disagreed.
ALTER TABLE batch_test_results ADD COLUMN auto_result TEXT CHECK (auto_result IN ('pass', 'fail'));
ALTER TABLE batch_test_results ADD COLUMN override_reason TEXT;
