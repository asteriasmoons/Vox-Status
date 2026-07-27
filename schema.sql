-- Vox Status Page — D1 schema
-- Mirrors the data model that used to live in src/statusData.ts.
-- Apply with: npm run db:init  (see package.json / README)

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS incident_updates;
DROP TABLE IF EXISTS incidents;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS service_groups;
DROP TABLE IF EXISTS maintenance;
DROP TABLE IF EXISTS templates;
DROP TABLE IF EXISTS settings;

CREATE TABLE service_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES service_groups(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'operational',
  uptime      TEXT    NOT NULL DEFAULT '100%',
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE incidents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  state      TEXT    NOT NULL DEFAULT 'investigating',  -- investigating | monitoring | resolved
  date       TEXT    NOT NULL,
  affected   TEXT    NOT NULL DEFAULT '[]',              -- JSON array of service names
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE incident_updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,
  time        TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE maintenance (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  body         TEXT    NOT NULL DEFAULT '',
  window_start TEXT,
  window_end   TEXT,
  state        TEXT    NOT NULL DEFAULT 'scheduled',     -- scheduled | in_progress | completed
  affected     TEXT    NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL,                            -- incident | maintenance | service
  name       TEXT    NOT NULL,
  data       TEXT    NOT NULL DEFAULT '{}',               -- JSON payload
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_services_group      ON services(group_id, sort_order);
CREATE INDEX idx_updates_incident    ON incident_updates(incident_id, sort_order);
CREATE INDEX idx_templates_type      ON templates(type);

-- ---------------------------------------------------------------------------
-- Seed: current data carried over from src/statusData.ts
-- ---------------------------------------------------------------------------

INSERT INTO service_groups (id, title, sort_order) VALUES
  (1, 'Vox Platform',    0),
  (2, 'Vox Apps',        1),
  (3, 'Shared Services', 2);

INSERT INTO services (group_id, name, description, status, uptime, sort_order) VALUES
  (1, 'Telegram Bot',      'Commands, posting, and bot responses', 'operational', '99.99%', 0),
  (1, 'Telegram Mini App', 'Dashboard and post management',        'operational', '99.98%', 1),
  (1, 'Vox API',           'Core backend services',                'operational', '99.99%', 2),
  (1, 'Scheduled Posting', 'Queued and recurring posts',           'operational', '99.97%', 3),

  (2, 'Lunixia', 'iOS and iPadOS services', 'operational', '99.99%', 0),
  (2, 'Lunelia', 'iOS and iPadOS services', 'operational', '99.99%', 1),
  (2, 'Lurelia', 'iOS and iPadOS services', 'operational', '99.98%', 2),
  (2, 'Loomey',  'iOS and iPadOS services', 'operational', '99.99%', 3),
  (2, 'Markly',  'iOS and iPadOS services', 'operational', '99.99%', 5),
  (2, 'Tally',   'iOS and iPadOS services', 'operational', '99.99%', 6),
  (2, 'Asterium', 'iOS and iPadOS services', 'operational', '99.99%', 7),
  (2, 'Seery',    'iOS and iPadOS services', 'operational', '99.99%', 8),

  (3, 'Database',           'Application data and persistence',    'operational', '99.99%', 0),
  (3, 'Authentication',     'Account sign-in and sessions',        'operational', '99.99%', 1),
  (3, 'Cloud Sync',         'Cross-device data synchronization',   'operational', '99.98%', 2),
  (3, 'Push Notifications', 'App and system notifications',        'operational', '99.96%', 3),
  (3, 'AI Services',        'AI-powered app features',             'operational', '99.95%', 4),
  (3, 'Media Uploads',      'Images and file attachments',         'operational', '99.99%', 5);

INSERT INTO incidents (id, title, state, date, affected) VALUES
  (1, 'Scheduled posting delays', 'resolved', 'July 8, 2026', '["Scheduled Posting"]');

INSERT INTO incident_updates (incident_id, label, time, message, sort_order) VALUES
  (1, 'Resolved',      '4:42 PM', 'Queued posts are sending normally and the delayed queue has been cleared.', 0),
  (1, 'Monitoring',    '4:18 PM', 'A worker restart restored normal processing. We are monitoring the queue.', 1),
  (1, 'Investigating', '3:51 PM', 'Some scheduled posts are being delivered later than expected.',            2);

-- Starter templates for the three template types.
INSERT INTO templates (type, name, data) VALUES
  ('incident', 'Investigating',
    '{"state":"investigating","label":"Investigating","message":"We are investigating reports of an issue affecting this service. Updates to follow."}'),
  ('incident', 'Identified',
    '{"state":"investigating","label":"Identified","message":"We have identified the cause and are working on a fix."}'),
  ('incident', 'Monitoring',
    '{"state":"monitoring","label":"Monitoring","message":"A fix has been applied and we are monitoring the results."}'),
  ('incident', 'Resolved',
    '{"state":"resolved","label":"Resolved","message":"This incident has been resolved and all services are operating normally."}'),
  ('maintenance', 'Standard maintenance window',
    '{"state":"scheduled","title":"Scheduled maintenance","body":"We will be performing scheduled maintenance. Brief interruptions may occur during this window."}'),
  ('service', 'Mark degraded',
    '{"status":"degraded"}'),
  ('service', 'Mark operational',
    '{"status":"operational"}'),
  ('service', 'Mark beta',
    '{"status":"beta"}');

INSERT INTO settings (key, value) VALUES
  ('overall_note', 'Live availability for Vox, the Telegram platform, and all nine Vox apps.'),
  ('support_email', 'support@example.com');
