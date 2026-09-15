-- Tracks failed login attempts so a guesser can't just retry forever.
-- `key` is either a portal username ("portal:<username>") or the admin
-- panel keyed by requester IP ("admin:<ip>") since Basic Auth has no
-- username of its own.
CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
