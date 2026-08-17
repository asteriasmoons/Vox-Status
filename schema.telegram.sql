-- Vox Status Page — Telegram publishing migration (incremental)
--
-- The initial Telegram columns (telegram_html, telegram_message_id,
-- telegram_sent_at, telegram_edited_at) were already applied to the
-- remote D1 database in the first Telegram migration. Re-running those
-- ALTER TABLE statements would fail with `duplicate column name`, so
-- this file now only adds the columns introduced by the inline-keyboard
-- button feature.
--
-- Apply with:
--   npx wrangler d1 execute vox-status --remote --file=./schema.telegram.sql
--   npx wrangler d1 execute vox-status --local  --file=./schema.telegram.sql
--
-- D1/SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, so if these two
-- columns have already been applied, this file will error with
-- "duplicate column name" and can safely be ignored.

ALTER TABLE incident_updates ADD COLUMN telegram_button_text  TEXT;
ALTER TABLE incident_updates ADD COLUMN telegram_button_url   TEXT;

INSERT OR IGNORE INTO settings (key, value)
  VALUES ('status_url', 'https://status.voxiverse.ink');
