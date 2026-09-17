-- Records 0001–0020 as applied in wrangler's migrations table.
--
-- Until this was added, deploys ran every migration file with
-- `wrangler d1 execute` and ignored the errors, so production has
-- 0001–0020 applied but no record of it. `wrangler d1 migrations apply`
-- decides what to run from this table, so it has to know about those
-- first — otherwise it would re-run 0001 and fail.
--
-- Safe to run on every deploy: the table is created only if missing and
-- existing rows are left alone. On a fresh database, run the migrations
-- with `wrangler d1 migrations apply` instead; don't run this file there.
-- Never add migrations after 0020 here.
CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0001_init.sql'),
  ('0002_codes_specs.sql'),
  ('0003_import_codes.sql'),
  ('0004_import_code_pools.sql'),
  ('0005_sample_sender.sql'),
  ('0006_batch_test_results.sql'),
  ('0007_drop_coa_file_ref.sql'),
  ('0008_test_results_separate_from_decision.sql'),
  ('0009_attachments.sql'),
  ('0010_material_functions.sql'),
  ('0011_receipts_type_index.sql'),
  ('0012_app_settings.sql'),
  ('0013_users_sessions.sql'),
  ('0014_username_case_insensitive.sql'),
  ('0015_push_subscriptions.sql'),
  ('0016_packaging_type.sql'),
  ('0017_packaging_verify_basis.sql'),
  ('0018_login_rate_limiting.sql'),
  ('0019_attachments_soft_delete.sql'),
  ('0020_retest_link.sql');
