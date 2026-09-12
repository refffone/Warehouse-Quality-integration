-- Login usernames were compared with exact-case string equality, so an
-- account created as "Warehouse@QCheck.com" couldn't sign in as
-- "warehouse@qcheck.com" — surprising for a username/email-shaped field,
-- where people expect case not to matter. Recreating `username` with
-- COLLATE NOCASE makes every existing "username = ?" comparison (login
-- lookup, the admin panel's "already taken" check) case-insensitive
-- automatically, and makes the UNIQUE constraint itself case-insensitive
-- too — no query changes needed anywhere else. SQLite has no ALTER
-- COLUMN for collation, so this is the standard create-copy-drop-rename
-- dance; ids are preserved explicitly so `sessions.user_id` still joins
-- correctly.

CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('warehouse', 'quality')),
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users_new (id, username, password_hash, password_salt, role, display_name, active, created_at)
SELECT id, username, password_hash, password_salt, role, display_name, active, created_at FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
