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

// First run: seed a few sensible defaults. Admins can change them on the Admin page.
if (db.prepare('SELECT COUNT(*) AS n FROM locations').get().n === 0) {
  const ins = db.prepare('INSERT INTO locations (name) VALUES (?)');
  ['Help Desk', 'ARC', 'Academic Building'].forEach((n) => ins.run(n));
}
if (db.prepare('SELECT COUNT(*) AS n FROM issue_types').get().n === 0) {
  const ins = db.prepare('INSERT INTO issue_types (label, sort) VALUES (?, ?)');
  ['Duo / 2FA', 'NetID password', 'Wi-Fi', 'Email', 'Canvas', 'Printing', 'Software install', 'Laptop / hardware']
    .forEach((l, i) => ins.run(l, (i + 1) * 10));
}

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

module.exports = { db, now, tx };
