-- R2 has no built-in object versioning, so a hard delete of an uploaded
-- COA/photo was genuinely unrecoverable. Soft-delete instead: keep the R2
-- object and the row, just mark when/that it was deleted, and filter it
-- out of normal listings.
ALTER TABLE attachments ADD COLUMN deleted_at TEXT;
