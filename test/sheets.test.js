// Google Sheet sync, against a fake Apps Script web app and a fake Sheets API.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkins-sheets-'));
const SECRET = 'test-secret-0123456789';
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });

// In-memory stand-in for apps-script/Code.gs: one tab, rows matched on column A.
const sheet = { headers: null, rows: [], calls: [], down: false };
const fakeScript = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const send = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  if (sheet.down) { res.statusCode = 503; return res.end('<html>down</html>'); }
  const r = JSON.parse(body);
  sheet.calls.push(r.action);
  if (r.secret !== SECRET) return send({ ok: false, error: 'Wrong or missing secret.' });
  if (r.action === 'setup') { sheet.headers = r.headers; return send({ ok: true }); }
  if (r.action === 'upsert') {
    for (const row of r.rows) {
      const i = sheet.rows.findIndex((x) => String(x[0]) === String(row[0]));
      if (i >= 0) sheet.rows[i] = row; else sheet.rows.push(row);
    }
    return send({ ok: true });
  }
  if (r.action === 'read') return send({ ok: true, headers: sheet.headers, rows: sheet.rows });
  return send({ ok: false, error: 'Unknown action' });
});

let db; let sheets; let H;
const rowOf = (id) => sheet.rows.find((r) => r[0] === id);
const cell = (id, header) => rowOf(id)[H.indexOf(header)];
const addWalkin = (netid) => Number(db.prepare(`INSERT INTO walkins (location_id, netid, name, issue_type, description, slack_status)
  VALUES (1, ?, 'Pat', 'Wi-Fi', 'cannot connect', 'pending')`).run(netid).lastInsertRowid);

test.before(async () => {
  const url = await listen(fakeScript);
  Object.assign(process.env, {
    DB_PATH: path.join(dir, 't.db'), SHEETS_MODE: 'apps-script', SHEETS_PUSH_SECONDS: '3600',
    SHEETS_APPS_SCRIPT_URL: `${url}/exec`, SHEETS_APPS_SCRIPT_SECRET: SECRET, RETENTION_DAYS: '90',
  });
  ({ db } = require('../src/db'));
  // Made before sync is turned on, so it has to be backfilled.
  addWalkin('old1');
  sheets = require('../src/sheets');
  H = sheets.HEADERS;
});
test.after(() => { sheets.stop(); fakeScript.close(); });

test('start-up sets up the tab and backfills existing walk-ins', async () => {
  sheets.start();
  await sheets.flush(true);
  assert.deepEqual(sheet.headers, H);
  assert.equal(sheet.rows.length, 1);
  assert.equal(cell(1, 'NetID'), 'old1');
  assert.equal(cell(1, 'Location'), 'Help Desk');
  assert.equal(cell(1, 'Status'), 'waiting');
  assert.equal(sheets.status().queued, 0);
});

test('new walk-ins are added and changes update the same row', async () => {
  const id = addWalkin('abc123');
  assert.equal(sheets.status().queued, 1);
  await sheets.flush(true);
  assert.equal(cell(id, 'NetID'), 'abc123');

  db.prepare("UPDATE walkins SET status='claimed', claimed_by='c@oit.rutgers.edu', claimed_at='2026-11-15T19:00:00Z' WHERE id=?").run(id);
  db.prepare("UPDATE walkins SET ticket='INC0012345' WHERE id=?").run(id);
  assert.equal(sheets.status().queued, 1, 'two changes to one walk-in queue it once');
  await sheets.flush(true);
  assert.equal(sheet.rows.length, 2);
  assert.equal(cell(id, 'Status'), 'claimed');
  assert.equal(cell(id, 'Ticket'), 'INC0012345');
  assert.equal(cell(id, 'Claimed by'), 'c@oit.rutgers.edu');
});

test('Slack bookkeeping alone does not queue a resend', () => {
  db.prepare("UPDATE walkins SET slack_status='sent' WHERE id=1").run();
  assert.equal(sheets.status().queued, 0);
});

test('while the Sheet is down, changes wait in the queue and go out later', async () => {
  sheet.down = true;
  const id = addWalkin('down1');
  await sheets.flush(true);
  let st = sheets.status();
  assert.equal(st.queued, 1);
  assert.match(st.lastError, /HTTP 503/);
  assert.ok(st.failingSince);
  assert.equal(rowOf(id), undefined);

  await sheets.flush(); // still inside the backoff wait: does nothing
  sheet.down = false;
  await sheets.flush(true);
  st = sheets.status();
  assert.equal(st.queued, 0);
  assert.equal(st.lastError, null);
  assert.equal(cell(id, 'NetID'), 'down1');
});

test('retention erasure blanks personal details in the Sheet too', async () => {
  const id = addWalkin('gone1');
  db.prepare("UPDATE walkins SET status='resolved', ticket='INC1', created_at='2020-01-01T00:00:00.000Z', closed_at='2020-01-01T01:00:00.000Z' WHERE id=?").run(id);
  require('../src/retention').purge();
  await sheets.flush(true);
  assert.equal(cell(id, 'NetID'), '');
  assert.equal(cell(id, 'Name'), '');
  assert.equal(cell(id, 'Description'), '');
  assert.equal(cell(id, 'Ticket'), 'INC1');
  assert.ok(cell(id, 'Details erased at'));
});

test('SHEETS_INCLUDE_PERSONAL=false leaves NetIDs out', () => {
  const row = sheets.rowFor(1, false);
  assert.equal(row[H.indexOf('NetID')], '');
  assert.equal(row[H.indexOf('Issue')], 'Wi-Fi');
});

test('a wrong secret is reported clearly', async () => {
  const t = require('../src/sheets/apps-script').create({ appsScriptUrl: process.env.SHEETS_APPS_SCRIPT_URL, appsScriptSecret: 'x'.repeat(20), tab: 'Walk-ins' });
  await assert.rejects(t.setup(H), /Wrong or missing secret/);
});

test('service account connection: setup, upsert by ID, read back', async () => {
  // Minimal fake of the Sheets v4 REST endpoints the transport uses.
  const grid = []; const seen = [];
  const protectedRanges = [];
  const api = http.createServer();
  api.on('request', async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : null;
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    seen.push(`${req.method} ${p}`);
    assert.equal(req.headers.authorization, 'Bearer fake-token');
    const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    const rowNum = (a1) => Number(a1.match(/!A(\d+)/)[1]);
    if (req.method === 'GET' && p === '/v4/spreadsheets/SHEET1') {
      return json({ sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] });
    }
    if (req.method === 'POST' && p === '/v4/spreadsheets/SHEET1:batchUpdate') {
      for (const r of body.requests) if (r.addProtectedRange) protectedRanges.push(r.addProtectedRange.protectedRange);
      const add = body.requests.find((r) => r.addSheet);
      return json({ replies: add ? [{ addSheet: { properties: { sheetId: 7, title: add.addSheet.properties.title } } }] : [] });
    }
    if (req.method === 'PUT' && p === "/v4/spreadsheets/SHEET1/values/'Walk-ins'!A1") { grid[0] = body.values[0]; return json({}); }
    if (req.method === 'GET' && p === "/v4/spreadsheets/SHEET1/values/'Walk-ins'!A:A") {
      return json({ values: [grid.map((r) => (r ? r[0] : ''))] });
    }
    if (req.method === 'POST' && p === '/v4/spreadsheets/SHEET1/values:batchUpdate') {
      for (const d of body.data) grid[rowNum(d.range) - 1] = d.values[0];
      return json({});
    }
    if (req.method === 'POST' && p === "/v4/spreadsheets/SHEET1/values/'Walk-ins'!A1:append") {
      assert.equal(u.searchParams.get('valueInputOption'), 'RAW');
      grid.push(...body.values); return json({});
    }
    if (req.method === 'GET' && p === "/v4/spreadsheets/SHEET1/values/'Walk-ins'") return json({ values: grid });
    res.statusCode = 404; json({ error: { message: `no route ${req.method} ${p}` } });
  });
  const apiBase = await listen(api);
  const { create, spreadsheetIdFrom } = require('../src/sheets/service-account');
  assert.equal(spreadsheetIdFrom('https://docs.google.com/spreadsheets/d/SHEET1/edit#gid=0'), 'SHEET1');
  const t = create({ spreadsheetId: 'https://docs.google.com/spreadsheets/d/SHEET1/edit', tab: 'Walk-ins', apiBase,
    getToken: async () => 'fake-token', clientEmail: 'walkins@proj.iam.gserviceaccount.com' });
  try {
    await t.setup(['ID', 'NetID']);
    assert.deepEqual(protectedRanges.map((r) => r.editors.users), [['walkins@proj.iam.gserviceaccount.com']]);
    await t.upsert([[1, 'a'], [2, 'b']]);
    await t.upsert([[2, 'B'], [3, 'c']]);
    const { headers, rows } = await t.readAll();
    assert.deepEqual(headers, ['ID', 'NetID']);
    assert.deepEqual(rows, [[1, 'a'], [2, 'B'], [3, 'c']]);
  } finally { api.close(); }
});

test('settings mistakes turn sync off with a clear message instead of crashing', () => {
  assert.throws(() => sheets.makeTransport({ mode: 'apps-script', appsScriptUrl: 'http://example.com/exec', appsScriptSecret: SECRET }), /must be the web app/);
  assert.throws(() => sheets.makeTransport({ mode: 'service-account', spreadsheetId: 'X', keyFile: '/nope.json' }), /SHEETS_SA_KEY_FILE/);
  assert.throws(() => sheets.makeTransport({ mode: 'excel' }), /isn't one of/);
  assert.equal(sheets.makeTransport({ mode: 'off' }), null);
});
