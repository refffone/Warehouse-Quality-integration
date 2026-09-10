-- Replaces the material+supplier-scoped import code with two simple,
-- system-wide ledger pools, matching how Quality's current system already
-- labels records: RMF for any of the three novelty scenarios (new
-- material, new supplier, new name variant), RMS for a regular repeat.
-- The scenario itself is still detected and stored on receipt_lines
-- (import_scenario) for display — only the *code* is now just a prefix
-- plus a plain running number, not tied to any one material or supplier.

DROP TABLE import_code_sequences;
DROP TABLE import_code_scheme;

CREATE TABLE import_code_counters (
  kind TEXT PRIMARY KEY CHECK (kind IN ('RMF', 'RMS')),
  current_sequence INTEGER NOT NULL DEFAULT 0
);
INSERT INTO import_code_counters (kind, current_sequence) VALUES ('RMF', 0), ('RMS', 0);

CREATE TABLE import_code_schemes (
  kind TEXT PRIMARY KEY CHECK (kind IN ('RMF', 'RMS')),
  pattern_template TEXT NOT NULL
);
INSERT INTO import_code_schemes (kind, pattern_template) VALUES ('RMF', 'RMF{seq:04d}'), ('RMS', 'RMS{seq:04d}');
