// End-to-end API tests against a throwaway database and a fake Slack webhook.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkins-'));
const slackPosts = [];
let slackDown = false;
const fakeSlack = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (slackDown) { res.statusCode = 500; return res.end('down'); }
    slackPosts.push(JSON.parse(body));
    res.end('ok');
  });
});

let base;
let server;

test.before(async () => {
  await new Promise((r) => fakeSlack.listen(0, r));
  Object.assign(process.env, {
    DB_PATH: path.join(dir, 't.db'), DEV_LOGIN: 'true', COOKIE_SECURE: 'false',
    ADMIN_EMAILS: 'boss@oit.rutgers.edu', BASE_URL: 'https://walkins.example',
    SLACK_WEBHOOK_URL: `http://127.0.0.1:${fakeSlack.address().port}/hook`,
  });
  const app = require('../src/server');
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fakeSlack.close(); });

// Tiny cookie-keeping client.
function client() {
  const jar = {};
  return async (method, p, body) => {
    const r = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (v) jar[kv.slice(0, i)] = v; else delete jar[kv.slice(0, i)];
    }
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, location: r.headers.get('location') };
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('full walk-in flow', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/api/auth/dev', { email: 'boss@oit.rutgers.edu' })).status, 200);

  // Test-mode "Skip" signs in as a built-in admin.
  const skipper = client();
  assert.equal((await skipper('POST', '/api/auth/dev', { skip: true })).status, 200);
  assert.equal((await skipper('GET', '/api/me')).body.role, 'admin');

  // Students share @scarletmail, so Google-domain users are refused until added.
  const alice = client();
  assert.equal((await alice('POST', '/api/auth/dev', { email: 'alice1@scarletmail.rutgers.edu' })).status, 403);
  assert.equal((await alice('POST', '/api/auth/dev', { email: 'x@gmail.com' })).status, 403);
  assert.equal((await admin('POST', '/api/admin/users', { email: 'alice1@scarletmail.rutgers.edu', name: 'Alice' })).status, 200);
  assert.equal((await alice('POST', '/api/auth/dev', { email: 'alice1@scarletmail.rutgers.edu' })).status, 200);
  assert.equal((await alice('GET', '/api/admin')).status, 403, 'consultants are not admins');

  // @oit accounts (Microsoft) are let in automatically.
  const bob = client();
  assert.equal((await bob('POST', '/api/auth/dev', { email: 'bob2@oit.rutgers.edu' })).status, 200);

  // Set up an iPad: it gets a kiosk token and the consultant is signed out on it.
  const ipad = client();
  await ipad('POST', '/api/auth/dev', { email: 'alice1@scarletmail.rutgers.edu' });
  const locs = (await ipad('GET', '/api/locations')).body;
  const arc = locs.find((l) => l.name === 'ARC');
  assert.equal((await ipad('POST', '/api/kiosk/setup', { location_id: arc.id })).status, 200);
  assert.equal((await ipad('GET', '/api/me')).status, 401, 'consultant signed out on the iPad');
  assert.equal((await ipad('GET', '/api/kiosk/info')).body.location, 'ARC');
  assert.equal((await ipad('GET', '/dashboard')).status, 302, 'iPad cannot see the queue');

  // Validation.
  assert.equal((await ipad('POST', '/api/kiosk/walkins', { netid: 'not a netid!', issue_type: 'Wi-Fi' })).status, 400);
  assert.equal((await ipad('POST', '/api/kiosk/walkins', { name: 'Pat', email: 'bad', issue_type: 'Wi-Fi' })).status, 400);
  assert.equal((await ipad('POST', '/api/kiosk/walkins', { netid: 'abc123' })).status, 400, 'needs an issue');
  assert.equal((await ipad('POST', '/api/kiosk/walkins', { netid: 'abc123', description: 'help' })).status, 400, 'too short without a button');
  assert.equal((await ipad('POST', '/api/kiosk/walkins', { netid: 'abc123', issue_type: 'Made up' })).status, 400, 'unknown button');
  assert.equal((await ipad('POST', '/api/kiosk/walkins', { netid: 'abc123', issue_type: 'Wi-Fi' })).status, 400, 'Wi-Fi needs a network');
  assert.equal((await ipad('POST', '/api/kiosk/walkins', { netid: 'abc123', issue_type: 'Wi-Fi · Starbucks' })).status, 400, 'unknown network');
  assert.equal((await ipad('POST', '/api/kiosk/walkins', { netid: 'abc123', issue_type: 'Canvas · eduroam' })).status, 400, 'no sub-choices on Canvas');

  // Submit two walk-ins.
  const w1 = (await ipad('POST', '/api/kiosk/walkins', { netid: 'ABC123', issue_type: 'Duo / 2FA', description: 'New phone <b>' })).body.id;
  const w2 = (await ipad('POST', '/api/kiosk/walkins', { name: 'Pat Guest', email: 'pat@example.com', description: 'Wi-Fi help' })).body.id;
  assert.ok(w1 && w2);

  // Slack got both, with NetID / name+email and a direct link.
  await wait(300);
  assert.equal(slackPosts.length, 2);
  const s1 = JSON.stringify(slackPosts[0]);
  assert.match(s1, /abc123/);
  assert.match(s1, new RegExp(`https://walkins.example/w/${w1}`));
  assert.match(s1, /New phone &lt;b&gt;/, 'Slack text is escaped');
  assert.match(JSON.stringify(slackPosts[1]), /pat@example.com/);

  // Claim conflict: only one consultant wins.
  const [a, b] = await Promise.all([alice('POST', `/api/walkins/${w1}/claim`, {}), bob('POST', `/api/walkins/${w1}/claim`, {})]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.match(loser.body.error, /Already claimed by/);
  const winner = a.status === 200 ? alice : bob;

  // Ticket required to resolve; bad formats rejected.
  assert.equal((await winner('POST', `/api/walkins/${w1}/resolve`, {})).status, 400);
  assert.equal((await winner('POST', `/api/walkins/${w1}/update`, { ticket: 'hello' })).status, 400);
  assert.equal((await winner('POST', `/api/walkins/${w1}/update`, { ticket: 'inc0012345' })).body.ticket, 'INC0012345');
  const resolved = (await winner('POST', `/api/walkins/${w1}/resolve`, {})).body;
  assert.equal(resolved.status, 'resolved');

  // Walk-in 2 left.
  assert.equal((await alice('POST', `/api/walkins/${w2}/left`, {})).body.status, 'left');
  assert.equal((await alice('POST', `/api/walkins/${w2}/reopen`, {})).body.status, 'waiting');

  // Queue and reports.
  const open = (await alice('GET', '/api/walkins?view=open')).body;
  assert.deepEqual(open.map((w) => w.id), [w2]);
  const rep = (await alice('GET', '/api/reports')).body;
  assert.equal(rep.totals.total, 2);
  assert.equal(rep.totals.resolved, 1);
  const csv = await alice('GET', '/api/reports/export.csv');
  assert.match(csv.body, /INC0012345/);

  // Writes must be JSON (CSRF guard).
  const form = await fetch(`${base}/api/walkins/${w2}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
  assert.equal(form.status, 415);

  // Admin can unlink the iPad and it stops working at once.
  const dev = (await admin('GET', '/api/admin')).body.devices[0];
  await admin('POST', `/api/admin/devices/${dev.id}/revoke`, {});
  assert.equal((await ipad('POST', '/api/kiosk/walkins', { netid: 'abc123', issue_type: 'Wi-Fi' })).status, 401);

  // Turning a consultant off signs them out.
  await admin('POST', '/api/admin/users', { email: 'alice1@scarletmail.rutgers.edu', active: false });
  assert.equal((await alice('GET', '/api/me')).status, 401);
});

test('Slack outage: walk-in is saved and posted once Slack is back', async () => {
  const admin = client();
  await admin('POST', '/api/auth/dev', { email: 'boss@oit.rutgers.edu' });
  const ipad = client();
  await ipad('POST', '/api/kiosk/setup', { location_id: 1 }).catch(() => {});
  // Set up via admin session on a separate "iPad".
  const ipad2 = client();
  await ipad2('POST', '/api/auth/dev', { email: 'boss@oit.rutgers.edu' });
  await ipad2('POST', '/api/kiosk/setup', { location_id: 1 });

  slackDown = true;
  const before = slackPosts.length;
  const r = await ipad2('POST', '/api/kiosk/walkins', { netid: 'zz9', issue_type: 'Wi-Fi · eduroam' });
  assert.equal(r.status, 200, 'walk-in accepted even while Slack is down');
  await wait(300);
  assert.equal(slackPosts.length, before);

  slackDown = false;
  await require('../src/slack').flush();
  assert.equal(slackPosts.length, before + 1);
  assert.match(JSON.stringify(slackPosts.at(-1)), /zz9/);
});

test('retention erases personal details on old closed walk-ins only', async () => {
  const { db } = require('../src/db');
  const old = new Date(Date.now() - 200 * 24 * 3600e3).toISOString();
  db.prepare("INSERT INTO walkins (location_id, netid, issue_type, status, created_at, ticket) VALUES (1, 'old1', 'Wi-Fi', 'resolved', ?, 'INC0000001')").run(old);
  db.prepare("INSERT INTO walkins (location_id, netid, issue_type, status, created_at) VALUES (1, 'old2', 'Wi-Fi', 'waiting', ?)").run(old);
  require('../src/retention').purge();
  const rows = db.prepare("SELECT netid, ticket, issue_type FROM walkins WHERE created_at = ? ORDER BY id").all(old);
  assert.deepEqual(rows.map((r) => r.netid), [null, 'old2']);
  assert.equal(rows[0].ticket, 'INC0000001');
});

test('TV queue screen shows the location queue, and cannot submit', async () => {
  const staff = client();
  await staff('POST', '/api/auth/dev', { email: 'boss@oit.rutgers.edu' });
  const hd = (await staff('GET', '/api/locations')).body.find((l) => l.name === 'Help Desk');

  // Not linked yet: the page sends you to setup and the API refuses.
  const tv = client();
  assert.equal((await tv('GET', '/tv')).status, 302);
  assert.equal((await tv('GET', '/api/tv/queue')).status, 401);

  // Link the TV to the Help Desk; the consultant is signed out on it.
  await tv('POST', '/api/auth/dev', { email: 'boss@oit.rutgers.edu' });
  assert.equal((await tv('POST', '/api/tv/setup', { location_id: hd.id })).status, 200);
  assert.equal((await tv('GET', '/api/me')).status, 401, 'consultant signed out on the TV');
  assert.equal((await tv('GET', '/tv')).status, 200);
  assert.equal((await tv('GET', '/')).location, '/tv');

  // A TV token is not a kiosk token.
  assert.equal((await tv('POST', '/api/kiosk/walkins', { netid: 'tv111', issue_type: 'Canvas' })).status, 401);
  assert.equal((await tv('GET', '/api/walkins')).status, 401);

  const ipad = client();
  await ipad('POST', '/api/auth/dev', { email: 'boss@oit.rutgers.edu' });
  await ipad('POST', '/api/kiosk/setup', { location_id: hd.id });
  const a = (await ipad('POST', '/api/kiosk/walkins', { netid: 'qrs123', issue_type: 'Canvas', description: 'Can not see my   course' })).body.id;
  const b = (await ipad('POST', '/api/kiosk/walkins', { name: 'Jordan Lee', email: 'jordan@example.com', description: 'x'.repeat(100) })).body.id;
  const c = (await ipad('POST', '/api/kiosk/walkins', { netid: 'tuv456', issue_type: 'Canvas' })).body.id;
  const d = (await ipad('POST', '/api/kiosk/walkins', { netid: 'res789', issue_type: 'Canvas' })).body.id;
  await staff('POST', `/api/walkins/${c}/claim`, {});
  await staff('POST', `/api/walkins/${d}/update`, { ticket: 'INC0099999' });
  await staff('POST', `/api/walkins/${d}/resolve`, {});

  const q = (await tv('GET', '/api/tv/queue')).body;
  q.waiting = q.waiting.filter((w) => w.id >= a); // ignore leftovers from earlier tests
  assert.equal(q.location, 'Help Desk');
  assert.deepEqual(q.waiting.map((w) => w.who), ['qrs123', 'Jordan L.'], 'oldest first; no-NetID walk-ins show first name + last initial');
  assert.deepEqual(q.waiting.map((w) => w.issue), ['Canvas', 'Something else']);
  assert.equal(q.waiting[0].desc, 'Can not see my course');
  assert.ok(q.waiting[1].desc.length <= 60, 'description is shortened');
  assert.deepEqual(q.helping.map((w) => w.who), ['tuv456']);
  assert.ok(q.helpedToday >= 1);
  assert.ok(!JSON.stringify(q).includes('jordan@example.com'), 'never shows email');

  // Other locations don't appear.
  const arcPad = client();
  await arcPad('POST', '/api/auth/dev', { email: 'boss@oit.rutgers.edu' });
  const arc = (await arcPad('GET', '/api/locations')).body.find((l) => l.name === 'ARC');
  await arcPad('POST', '/api/kiosk/setup', { location_id: arc.id });
  await arcPad('POST', '/api/kiosk/walkins', { netid: 'arc999', issue_type: 'Canvas' });
  assert.equal((await tv('GET', '/api/tv/queue')).body.waiting.filter((w) => w.id >= a).length, 2);

  // Admin can unlink it.
  const dev = (await staff('GET', '/api/admin')).body.devices.find((x) => x.kind === 'display');
  await staff('POST', `/api/admin/devices/${dev.id}/revoke`, {});
  assert.equal((await tv('GET', '/api/tv/queue')).status, 401);
});
