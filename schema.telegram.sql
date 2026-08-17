-- Vox Status Page — Telegram publishing migration
-- Adds per-update Telegram metadata to incident_updates.
-- Apply with:
--   npx wrangler d1 execute vox-status --remote --file=./schema.telegram.sql
--   npx wrangler d1 execute vox-status --local  --file=./schema.telegram.sql
--
-- Safe to re-run: guarded by IF NOT EXISTS via a settings marker.

-- D1/SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, so these will error
-- on a second run. That is expected; ignore "duplicate column" errors.

ALTER TABLE incident_updates ADD COLUMN telegram_html        TEXT;
ALTER TABLE incident_updates ADD COLUMN telegram_message_id  INTEGER;
ALTER TABLE incident_updates ADD COLUMN telegram_sent_at     INTEGER;
ALTER TABLE incident_updates ADD COLUMN telegram_edited_at   INTEGER;

INSERT OR IGNORE INTO settings (key, value)
  VALUES ('status_url', 'https://status.voxiverse.ink');
