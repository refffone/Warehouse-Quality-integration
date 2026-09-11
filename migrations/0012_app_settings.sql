-- Owner-only settings, controlled from the Admin panel (src/routes/admin.ts) —
-- currently just the service kill switch, key/value so future admin-only
-- toggles don't need another migration.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO app_settings (key, value) VALUES ('service_status', 'active');
