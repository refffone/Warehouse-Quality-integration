-- Web Push subscriptions, one row per device/browser that opted in. `role`
-- is stored redundantly (rather than joined through `users`) because a
-- subscription is tied to whichever portal the browser was signed into
-- when it subscribed, not to a specific account — logging out and back in
-- as a different user of the same role keeps the same device subscribed.
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('warehouse', 'quality')),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_push_subscriptions_role ON push_subscriptions(role);
