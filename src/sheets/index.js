// Copies walk-ins to a Google Sheet so other OIT tools can share the data.
//
// The app's own database stays the working copy: the iPads, queue, TV screen and dashboard all
// read from it, so they stay fast and never touch Google's rate limits. The Sheet is a shared
// copy that only this app writes to (it's protected so people can view and filter but not edit).
//
// How changes get there: database triggers put the ID of every new or changed walk-in on a
// local queue (the sheet_outbox table). A worker sends the queue to the Sheet every few seconds,
// one batch per round, and keeps retrying with backoff if Google can't be reached. Nothing is
// lost while the Sheet is down; it just catches up later.
//
// How the app reaches the Sheet is pluggable (SHEETS_MODE), because it isn't decided yet:
//   off             nothing is sent (default)
//   apps-script     POSTs to an Apps Script web app bound to the Sheet (see apps-script/Code.gs)
//   service-account calls the Sheets API directly with a Google Cloud service account key
//
// Only walk-ins are sent. Sign-in sessions, iPad link tokens and the consultant list stay local.
const config = require('../config');
const { db, now, tx } = require('../db');

const { COLUMNS, HEADERS } = require('./columns');
const PERSONAL = new Set(['netid', 'name', 'email', 'description', 'notes']);
// Walk-in columns that, when changed, mean the Sheet row needs updating.
const WATCHED = COLUMNS.map(([c]) => c).filter((c) => !['id', 'location', 'campus', 'synced_at'].includes(c));
const BATCH = 200;

db.exec(`CREATE TABLE IF NOT EXISTS sheet_outbox (
  walkin_id INTEGER PRIMARY KEY,
  seq       INTEGER NOT NULL DEFAULT 0  -- bumped on every change, so a change made mid-send isn't lost
)`);

const TRIGGERS = ['walkins_sheet_ins', 'walkins_sheet_upd'];
const QUEUE = (ref) => `INSERT OR IGNORE INTO sheet_outbox (walkin_id) VALUES (${ref}.id);
    UPDATE sheet_outbox SET seq = seq + 1 WHERE walkin_id = ${ref}.id;`;

function installTriggers() {
  const had = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)").get(...TRIGGERS).n === 2;
  db.exec(`CREATE TRIGGER IF NOT EXISTS walkins_sheet_ins AFTER INSERT ON walkins BEGIN ${QUEUE('NEW')} END;
    CREATE TRIGGER IF NOT EXISTS walkins_sheet_upd AFTER UPDATE ON walkins
      WHEN ${WATCHED.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')}
    BEGIN ${QUEUE('NEW')} END;`);
  return had;
}
const dropTriggers = () => TRIGGERS.forEach((t) => db.exec(`DROP TRIGGER IF EXISTS ${t}`));

// Queue every walk-in (first run, a new Sheet, or turning sync back on after it was off).
function queueAll() {
  tx(() => {
    db.exec('INSERT OR IGNORE INTO sheet_outbox (walkin_id) SELECT id FROM walkins');
    db.exec('UPDATE sheet_outbox SET seq = seq + 1');
  });
}

const ROW_SELECT = db.prepare(`SELECT w.*, l.name AS location, l.campus FROM walkins w
  JOIN locations l ON l.id = w.location_id WHERE w.id = ?`);

function rowFor(id, includePersonal = config.sheets.includePersonal) {
  const w = ROW_SELECT.get(id);
  if (!w) return null;
  w.synced_at = now();
  return COLUMNS.map(([c]) => {
    if (!includePersonal && PERSONAL.has(c)) return '';
    const v = w[c];
    return v == null ? '' : c === 'id' ? Number(v) : String(v);
  });
}

function makeTransport(s = config.sheets) {
  if (s.mode === 'apps-script') return require('./apps-script').create(s);
  if (s.mode === 'service-account') return require('./service-account').create(s);
  if (s.mode && s.mode !== 'off') throw new Error(`SHEETS_MODE "${s.mode}" isn't one of: off, apps-script, service-account.`);
  return null;
}

let transport = null;
let timer = null;
let inflight = null; // the send in progress, if any
let ready = false; // header row and protection are in place
let failures = 0;
let nextTry = 0;
const state = { lastOk: null, lastError: null, failingSince: null, sent: 0 };

const queued = () => db.prepare('SELECT COUNT(*) AS n FROM sheet_outbox').get().n;

// force skips the retry wait (used by tests and the Admin page's future "retry now").
function flush(force = false) {
  if (!transport) return Promise.resolve();
  if (inflight) return inflight;
  if (!force && Date.now() < nextTry) return Promise.resolve();
  inflight = send().finally(() => { inflight = null; });
  return inflight;
}

async function send() {
  try {
    if (!ready) { await transport.setup(HEADERS); ready = true; }
    for (;;) {
      const batch = db.prepare('SELECT walkin_id, seq FROM sheet_outbox ORDER BY walkin_id LIMIT ?').all(BATCH);
      if (!batch.length) break;
      const rows = batch.map((b) => rowFor(b.walkin_id)).filter(Boolean);
      if (rows.length) await transport.upsert(rows);
      const done = db.prepare('DELETE FROM sheet_outbox WHERE walkin_id = ? AND seq = ?');
      tx(() => batch.forEach((b) => done.run(b.walkin_id, b.seq)));
      state.sent += rows.length;
      if (batch.length < BATCH) break;
    }
    if (state.failingSince) console.log(`Sheets: reconnected after failing since ${state.failingSince}.`);
    Object.assign(state, { lastOk: now(), lastError: null, failingSince: null });
    failures = 0;
  } catch (e) {
    failures++;
    // 5s, 10s, 20s ... up to 5 minutes between tries.
    const wait = Math.min(300e3, 5e3 * 2 ** (failures - 1));
    nextTry = Date.now() + wait;
    if (!state.failingSince) state.failingSince = now();
    state.lastError = e.message;
    console.warn(`Sheets: sync failed (${e.message}). ${queued()} walk-ins waiting; retrying in ${Math.round(wait / 1000)}s.`);
  }
}

function start() {
  try {
    transport = makeTransport();
  } catch (e) {
    console.error(`Sheets: ${e.message} Sheet sync is off.`);
    transport = null;
  }
  if (!transport) {
    dropTriggers();
    return console.log('Sheet sync is off (SHEETS_MODE not set).');
  }
  const target = `${config.sheets.mode}:${transport.target}:${config.sheets.tab}`;
  const prev = db.prepare("SELECT value FROM meta WHERE key = 'sheets_target'").get()?.value;
  const hadTriggers = installTriggers();
  if (!hadTriggers || prev !== target) {
    queueAll();
    db.prepare("INSERT INTO meta (key, value) VALUES ('sheets_target', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(target);
  }
  console.log(`Sheet sync is on: ${transport.describe()}, tab "${config.sheets.tab}". ${queued()} walk-ins queued.`);
  timer = setInterval(flush, Math.max(1, config.sheets.pushSeconds) * 1000);
  timer.unref();
  flush();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  return {
    mode: transport ? config.sheets.mode : 'off',
    target: transport ? transport.describe() : null,
    tab: config.sheets.tab,
    queued: transport ? queued() : 0,
    ...state,
  };
}

module.exports = { start, stop, flush, status, rowFor, makeTransport, queueAll, HEADERS, COLUMNS };
