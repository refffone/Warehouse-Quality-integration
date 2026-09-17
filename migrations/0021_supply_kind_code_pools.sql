-- Aligns receipt classification with Quality's Access log (سجل فحص المواد
-- الخام), which files every record under one of three kinds, each with its
-- own running code:
--   sample   (عينة مادة خام)   -> RMS
--   first    (اول توريد)       -> RMF
--   regular  (توريد مادة خام)  -> RMP
-- The previous model used RMS for *repeat supplies*, which in Access means
-- a sample — the two systems would have disagreed on what an RMS code is.
--
-- The deploy workflow re-runs every migration file on each deploy, so every
-- statement below after the ALTER is written to be a no-op on a re-run.

ALTER TABLE receipt_lines ADD COLUMN supply_kind TEXT
  CHECK (supply_kind IN ('sample', 'first', 'regular'));

-- One row per pool: its pattern and its running counter together. Replaces
-- import_code_schemes + import_code_counters, whose CHECK constraints only
-- allow RMF/RMS (SQLite can't alter a CHECK in place). The old tables are
-- left in place, unused, rather than dropped.
CREATE TABLE IF NOT EXISTS code_pools (
  kind TEXT PRIMARY KEY CHECK (kind IN ('RMS', 'RMF', 'RMP')),
  pattern_template TEXT NOT NULL,
  current_sequence INTEGER NOT NULL DEFAULT 0
);

-- Carry the existing patterns and counters over, so numbering continues
-- after any codes the app has already issued.
INSERT OR IGNORE INTO code_pools (kind, pattern_template, current_sequence)
SELECT s.kind, s.pattern_template, COALESCE(c.current_sequence, 0)
FROM import_code_schemes s
LEFT JOIN import_code_counters c ON c.kind = s.kind;

INSERT OR IGNORE INTO code_pools (kind, pattern_template, current_sequence) VALUES
  ('RMS', 'RMS{seq:04d}', 0),
  ('RMF', 'RMF{seq:04d}', 0),
  ('RMP', 'RMP{seq:04d}', 0);

-- Backfill existing lines. Codes already issued are kept as they are.
UPDATE receipt_lines SET supply_kind = 'sample'
WHERE supply_kind IS NULL
  AND receipt_id IN (SELECT id FROM receipts WHERE type = 'sample');

UPDATE receipt_lines SET supply_kind = 'regular'
WHERE supply_kind IS NULL AND import_scenario = 'repeat';

UPDATE receipt_lines SET supply_kind = 'first'
WHERE supply_kind IS NULL
  AND import_scenario IN ('new_material', 'new_supplier', 'new_name_variant');
