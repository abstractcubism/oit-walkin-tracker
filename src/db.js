const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  email       TEXT PRIMARY KEY,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'consultant' CHECK (role IN ('consultant','admin')),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locations (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  active  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS issue_types (
  id      INTEGER PRIMARY KEY,
  label   TEXT NOT NULL UNIQUE,
  sort    INTEGER NOT NULL DEFAULT 100,
  active  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS devices (
  id          INTEGER PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen   TEXT,
  revoked_at  TEXT
);
CREATE TABLE IF NOT EXISTS walkins (
  id            INTEGER PRIMARY KEY,
  location_id   INTEGER NOT NULL REFERENCES locations(id),
  device_id     INTEGER REFERENCES devices(id),
  netid         TEXT,
  name          TEXT,
  email         TEXT,
  issue_type    TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','claimed','resolved','left')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_by    TEXT,
  claimed_at    TEXT,
  ticket        TEXT,
  notes         TEXT,
  closed_at     TEXT,
  closed_by     TEXT,
  slack_status  TEXT NOT NULL DEFAULT 'pending' CHECK (slack_status IN ('pending','sent','failed','off')),
  slack_tries   INTEGER NOT NULL DEFAULT 0,
  purged_at     TEXT
);
CREATE INDEX IF NOT EXISTS walkins_status ON walkins(status);
CREATE INDEX IF NOT EXISTS walkins_created ON walkins(created_at);
`);

// OIT walk-in locations in New Brunswick, as [name, campus].
const LOCATIONS = [
  ['Help Desk', 'Busch'], ['ARC', 'Busch'],
  ['Academic Building', 'College Ave'], ['Alexander Library', 'College Ave'],
  ['Loree', 'Cook/Douglass'],
  ['Tillett', 'Livingston'],
];
try { db.exec('ALTER TABLE locations ADD COLUMN campus TEXT'); } catch { /* already there */ }
// First run: seed sensible defaults. Admins can change them on the Admin page.
if (db.prepare('SELECT COUNT(*) AS n FROM locations').get().n === 0) {
  const ins = db.prepare('INSERT INTO locations (name, campus) VALUES (?, ?)');
  LOCATIONS.forEach(([n, c]) => ins.run(n, c));
}
if (db.prepare('SELECT COUNT(*) AS n FROM issue_types').get().n === 0) {
  const ins = db.prepare('INSERT INTO issue_types (label, sort) VALUES (?, ?)');
  // Seven buttons plus the built-in "Something else" fills the iPad's 2-column grid evenly.
  ['Duo / 2FA', 'NetID password', 'Wi-Fi', 'Canvas', 'Printing', 'Software install', 'Laptop / hardware']
    .forEach((l, i) => ins.run(l, (i + 1) * 10));
}
// Optional sub-choices for an issue button, comma-separated (e.g. Wi-Fi -> eduroam, RUatHome).
try { db.exec('ALTER TABLE issue_types ADD COLUMN options TEXT'); } catch { /* already there */ }

// Databases created before Nov 2026 had an "Email" button in the defaults; hide it if untouched.
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'drop_email_default'").get()) {
  db.prepare("UPDATE issue_types SET active = 0 WHERE label = 'Email' AND sort = 40").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('drop_email_default', '1')").run();
}
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'location_campus'").get()) {
  const set = db.prepare('UPDATE locations SET campus = ? WHERE name = ? AND campus IS NULL');
  set.run('Busch', 'Help Desk'); set.run('Busch', 'ARC'); set.run('College Ave', 'Academic Building');
  db.prepare("INSERT INTO meta (key, value) VALUES ('location_campus', '1')").run();
}
// Older databases: add the full location list and use the short "College Ave" campus name.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'locations_v2'").get()) {
  db.prepare("UPDATE locations SET campus = 'College Ave' WHERE campus = 'College Avenue'").run();
  const add = db.prepare('INSERT INTO locations (name, campus) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM locations WHERE lower(name) = lower(?))');
  LOCATIONS.forEach(([n, c]) => add.run(n, c, n));
  db.prepare("INSERT INTO meta (key, value) VALUES ('locations_v2', '1')").run();
}
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'wifi_options'").get()) {
  db.prepare("UPDATE issue_types SET options = 'eduroam,RUatHome' WHERE label = 'Wi-Fi' AND options IS NULL").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('wifi_options', '1')").run();
}

// A linked device is either a check-in iPad ('kiosk') or a read-only TV queue screen ('display').
try { db.exec("ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'kiosk'"); } catch { /* already there */ }

// Optional self-help page per issue button. When set, the iPad's confirmation screen shows a
// QR code for it ("While you wait, you can try this"). Only for issues people can fix themselves.
try { db.exec('ALTER TABLE issue_types ADD COLUMN help_url TEXT'); } catch { /* already there */ }
try { db.exec('ALTER TABLE issue_types ADD COLUMN help_title TEXT'); } catch { /* already there */ }
// Why a walk-in closed as 'left': NULL (left / no-show) or 'self_solved' (fixed it themselves).
try { db.exec('ALTER TABLE walkins ADD COLUMN close_reason TEXT'); } catch { /* already there */ }
// Starter self-help links (official Rutgers pages, checked Nov 2026). Admins can change or clear them.
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'help_links_v1'").get()) {
  const set = db.prepare("UPDATE issue_types SET help_url = ?, help_title = ? WHERE label = ? AND help_url IS NULL");
  set.run('https://netid.rutgers.edu/displayForgottenPasswordForm.htm', 'Reset a forgotten NetID password', 'NetID password');
  set.run('https://it.rutgers.edu/eduroam/', 'Set up eduroam Wi-Fi on your device', 'Wi-Fi');
  db.prepare("INSERT INTO meta (key, value) VALUES ('help_links_v1', '1')").run();
}

// Software remediation consent, the last step of check-in. Walk-ins either sign it on the
// iPad (consent = 'signed', with their printed name, finger signature and the exact text they agreed to), or
// they'll use the official DocuSign form on their phone ('phone'). A consultant
// can mark it signed after checking ('confirmed'). NULL = never answered.
for (const col of ['consent TEXT', 'consent_name TEXT', 'consent_text TEXT', 'consent_sig TEXT', 'consent_at TEXT', 'consent_by TEXT']) {
  try { db.exec(`ALTER TABLE walkins ADD COLUMN ${col}`); } catch { /* already there */ }
}

// Small key/value settings kept in meta, editable on the Admin page.
const getSetting = (key, fallback) => {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : fallback;
};
const setSetting = (key, value) => db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));

// "Wi-Fi" + "eduroam,RUatHome" -> ['eduroam', 'RUatHome']
const parseOptions = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

const now = () => new Date().toISOString();

// Run fn inside a transaction.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, now, tx, parseOptions, getSetting, setSetting };
