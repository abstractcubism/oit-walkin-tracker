// Slack bot mode (Claim button) against a fake Slack Web API. Socket Mode delivery is skipped:
// the button press and ticket box payloads are handed straight to the handlers.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkins-bot-'));
const calls = []; // [method, body]
const slackUsers = {
  UALICE01: 'alice1@rutgers.edu', // NetID match to alice1@scarletmail.rutgers.edu
  UBOB0002: 'bob2@oit.rutgers.edu', // exact email match
  USTRANGE: 'someone@example.com', // no match
};
let ts = 1000;
const fakeSlack = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    const b = JSON.parse(body || '{}');
    calls.push([method, b, req.headers.authorization]);
    res.setHeader('Content-Type', 'application/json');
    if (method === 'chat.postMessage') return res.end(JSON.stringify({ ok: true, channel: b.channel, ts: `${ts++}.0001` }));
    if (method === 'users.info') return res.end(JSON.stringify({ ok: true, user: { id: b.user, profile: { email: slackUsers[b.user] } } }));
    res.end(JSON.stringify({ ok: true }));
  });
});

let base;
let server;
let slack;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (method) => calls.filter(([m]) => m === method).at(-1);

test.before(async () => {
  await new Promise((r) => fakeSlack.listen(0, r));
  Object.assign(process.env, {
    DB_PATH: path.join(dir, 't.db'), DEV_LOGIN: 'true', COOKIE_SECURE: 'false',
    ADMIN_EMAILS: 'boss@oit.rutgers.edu', BASE_URL: 'https://walkins.example',
    SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test', SLACK_CHANNEL: 'C0WALKINS',
    SLACK_API_URL: `http://127.0.0.1:${fakeSlack.address().port}/api`,
    SLACK_WEBHOOK_URL: '',
  });
  const app = require('../src/server');
  slack = require('../src/slack');
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fakeSlack.close(); });

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
    return { status: r.status, body: json };
  };
}

const press = (user, id) => slack.onAction({ type: 'block_actions', user: { id: user }, channel: { id: 'C0WALKINS' }, trigger_id: 'trig', actions: [{ action_id: 'claim', value: String(id) }] });
const submit = (user, id, ticket) => slack.onSubmit({ type: 'view_submission', user: { id: user }, view: { callback_id: 'walkin_claim', private_metadata: String(id), state: { values: { ticket: { value: { value: ticket } } } } } });
const buttons = (msg) => msg.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.text.text));

test('Claim button flow', async () => {
  const admin = client();
  await admin('POST', '/api/auth/dev', { email: 'boss@oit.rutgers.edu' });
  await admin('POST', '/api/admin/users', { email: 'alice1@scarletmail.rutgers.edu', name: 'Alice' });
  await admin('POST', '/api/admin/users', { email: 'bob2@oit.rutgers.edu', name: 'Bob' });
  assert.equal((await admin('GET', '/api/admin')).body.slack, 'bot');

  const ipad = client();
  await ipad('POST', '/api/auth/dev', { email: 'boss@oit.rutgers.edu' });
  await ipad('POST', '/api/kiosk/setup', { location_id: 1 });
  const id = (await ipad('POST', '/api/kiosk/walkins', { netid: 'abc123', issue_type: 'Canvas' })).body.id;
  await wait(200);

  // Posted with the bot token, NetID, dashboard link and a Claim button.
  const [, post, authz] = last('chat.postMessage');
  assert.equal(authz, 'Bearer xoxb-test');
  assert.equal(post.channel, 'C0WALKINS');
  assert.match(JSON.stringify(post), /abc123/);
  assert.match(JSON.stringify(post), new RegExp(`https://walkins.example/w/${id}`));
  assert.deepEqual(buttons(post), ['Claim']);

  // Someone not on the consultant list gets a private "not linked" note, no box.
  await press('USTRANGE', id);
  assert.equal(last('chat.postEphemeral')[1].user, 'USTRANGE');
  assert.match(last('chat.postEphemeral')[1].text, /isn't linked/);
  assert.equal(calls.filter(([m]) => m === 'views.open').length, 0);

  // Alice (Slack email alice1@rutgers.edu) matches alice1@scarletmail by NetID and gets the box.
  await press('UALICE01', id);
  assert.equal(last('views.open')[1].view.private_metadata, String(id));

  // Bad ticket keeps the box open with an error; good one claims it and updates the post.
  assert.match((await submit('UALICE01', id, 'hello')).errors.ticket, /INC0012345/);
  assert.equal(await submit('UALICE01', id, 'inc0054321'), undefined);
  const w = (await admin('GET', `/api/walkins/${id}`)).body;
  assert.equal(w.status, 'claimed');
  assert.equal(w.claimed_by, 'alice1@scarletmail.rutgers.edu');
  assert.equal(w.ticket, 'INC0054321');
  await wait(200);
  const upd = last('chat.update')[1];
  assert.equal(upd.ts, require('../src/db').db.prepare('SELECT slack_ts FROM walkins WHERE id=?').get(id).slack_ts);
  assert.match(JSON.stringify(upd), /Claimed by \*Alice\*/);
  assert.match(JSON.stringify(upd), /INC0054321/);
  assert.deepEqual(buttons(upd), ['Change ticket']);

  // Bob can't take it over from Slack.
  await press('UBOB0002', id);
  assert.match(last('chat.postEphemeral')[1].text, /Already claimed by Alice/);
  assert.match((await submit('UBOB0002', id, '')).errors.ticket, /Already claimed by Alice/);

  // Changes on the dashboard update the Slack post too.
  const alice = client();
  await alice('POST', '/api/auth/dev', { email: 'alice1@scarletmail.rutgers.edu' });
  assert.equal((await alice('POST', `/api/walkins/${id}/resolve`, {})).status, 200);
  await wait(200);
  const done = last('chat.update')[1];
  assert.match(JSON.stringify(done), /Resolved by \*Alice\*/);
  assert.deepEqual(buttons(done), []);

  // Admin can link a Slack ID by hand; it moves off anyone else who had it.
  assert.equal((await admin('POST', '/api/admin/users/slack', { email: 'bob2@oit.rutgers.edu', slack_user_id: 'nope' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/users/slack', { email: 'bob2@oit.rutgers.edu', slack_user_id: 'UALICE01' })).status, 200);
  const users = (await admin('GET', '/api/admin')).body.users;
  assert.equal(users.find((u) => u.email === 'bob2@oit.rutgers.edu').slack_user_id, 'UALICE01');
  assert.equal(users.find((u) => u.email === 'alice1@scarletmail.rutgers.edu').slack_user_id, null);
});

test('retention blanks personal details out of the Slack post', async () => {
  const { db } = require('../src/db');
  const old = new Date(Date.now() - 200 * 24 * 3600e3).toISOString();
  const r = db.prepare("INSERT INTO walkins (location_id, netid, issue_type, status, created_at, slack_status, slack_channel, slack_ts) VALUES (1, 'old77', 'Wi-Fi', 'resolved', ?, 'sent', 'C0WALKINS', '1.0001')").run(old);
  require('../src/retention').purge();
  await slack.flush();
  const upd = calls.filter(([m, b]) => m === 'chat.update' && b.ts === '1.0001').at(-1)[1];
  assert.doesNotMatch(JSON.stringify(upd), /old77/);
  assert.match(JSON.stringify(upd), /Personal details erased/);
  assert.ok(r.lastInsertRowid);
});

test('Socket Mode envelopes are acknowledged, with box errors passed back', async () => {
  const sent = [];
  await slack.handleEnvelope({ envelope_id: 'e1', type: 'events_api', payload: {} }, (m) => sent.push(m));
  await slack.handleEnvelope({ envelope_id: 'e2', type: 'interactive', payload: { type: 'view_submission', user: { id: 'USTRANGE' }, view: { callback_id: 'walkin_claim', private_metadata: '1', state: { values: {} } } } }, (m) => sent.push(m));
  assert.deepEqual(sent[0], { envelope_id: 'e1' });
  assert.equal(sent[1].envelope_id, 'e2');
  assert.equal(sent[1].payload.response_action, 'errors');
});
