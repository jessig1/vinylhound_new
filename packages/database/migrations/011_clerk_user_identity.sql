ALTER TABLE users
  ADD COLUMN clerk_user_id TEXT;

UPDATE users
SET clerk_user_id = 'development:' || id::text
WHERE clerk_user_id IS NULL;

CREATE UNIQUE INDEX users_clerk_user_id_unique ON users (clerk_user_id);
