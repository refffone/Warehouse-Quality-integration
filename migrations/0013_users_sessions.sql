-- Real accounts, replacing the X-Role header stand-in as the actual
-- access-control mechanism. Every login page is role-locked (a username
-- can only sign in through its own role's portal), so `role` here is the
-- source of truth the backend now checks instead of a client-set header.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('warehouse', 'quality')),
  display_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Server-side session tokens (opaque, stored hashed nowhere — the token
-- itself is the bearer secret, delivered only via an httpOnly cookie).
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('warehouse', 'quality')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
