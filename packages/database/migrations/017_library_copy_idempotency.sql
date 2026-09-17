-- Per-copy editing completion (ADR-0024, roadmap P3.4 Task 2).
--
-- POST /library/{itemId}/copies records a second pressing, or a copy again
-- after the last one was removed. A copy has no natural identity — two blank
-- copies of one record are legitimately distinct — so the request cannot be
-- idempotent by identity the way placement and deletion are. It carries an
-- Idempotency-Key instead, stored on the copy it created together with a
-- fingerprint of the body, so a retried request returns the same copy and a
-- reused key with a different body is refused. Copies created by a scan
-- confirmation, a placement, a wishlist-to-collection move, or the migration
-- 010 backfill carry no key: their requests are made idempotent elsewhere.
ALTER TABLE library_copies
  ADD COLUMN idempotency_key TEXT,
  ADD COLUMN request_fingerprint CHAR(64),
  ADD CONSTRAINT library_copies_idempotency_key_length_check
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 255),
  ADD CONSTRAINT library_copies_idempotency_fingerprint_check
    CHECK ((idempotency_key IS NULL) = (request_fingerprint IS NULL));

CREATE UNIQUE INDEX library_copies_user_idempotency_key_unique
  ON library_copies (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
