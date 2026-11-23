// Slack, in one of two modes (see config.js and the README):
//
//  - "webhook": posts each new walk-in to a channel. Post only.
//  - "bot":     posts each new walk-in with a Claim button. Pressing it opens a small box for the
//               ServiceNow ticket number; submitting claims the walk-in for that person. The post
//               is then kept up to date (claimed by, ticket, resolved) whether the change was made
//               in Slack or on the dashboard, and personal details are blanked out of it when the
//               retention period erases them here. The bot never reads channel messages.
//
// Walk-ins are always saved first. This worker then sends anything still "pending" and retries
// on failure, so a Slack outage never loses a walk-in; it just delays the post.
const config = require('./config');
const { db } = require('./db');
const walkins = require('./walkins');

const MAX_TRIES = 10;
let timer = null;
let running = false;
let again = false; // a new walk-in arrived while we were sending

const mode = () => {
  if (config.slackBotToken && config.slackAppToken && config.slackChannel) return 'bot';
  if (config.slackWebhookUrl) return 'webhook';
  return 'off';
};
const enabled = () => mode() !== 'off';

// Slack mrkdwn needs &, <, > escaped.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ticketUrl = (t) => `${config.servicenowUrl}/nav_to.do?uri=${encodeURIComponent('task.do?sysparm_query=number=' + t)}`;
const ticketLink = (t) => `<${ticketUrl(t)}|${esc(t)}>`;

// ---------- Message ----------
function message(w, { buttons = false } = {}) {
  const link = `${config.baseUrl}/w/${w.id}`;
  let who;
  if (w.purged_at) who = '_Personal details erased (retention policy)_';
  else if (w.netid) who = `*NetID:* \`${esc(w.netid)}\``;
  else who = `*Name:* ${esc(w.name)}   *Email:* ${esc(w.email)}`;
  const issue = [w.issue_type, w.description].filter(Boolean).map(esc).join(' – ');
  const text = `New walk-in at ${w.location}: ${w.purged_at ? `#${w.id}` : w.netid || w.name}`;
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `:wave: *New walk-in at ${esc(w.location)}*\n${who}\n*Issue:* ${issue || '_none given_'}` } },
  ];
  if (!buttons) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${link}|Open walk-in #${w.id} to claim and add the ticket>` }] });
    return { text, blocks };
  }

  // Bot mode: show where it stands, and the button that fits.
  const by = esc(w.claimed_by_name || w.claimed_by || '');
  const ticket = w.ticket ? ticketLink(w.ticket) : '_no ticket yet_';
  const status = {
    waiting: ':hourglass_flowing_sand: Waiting',
    claimed: `:raising_hand: Claimed by *${by}* · ${ticket}`,
    resolved: `:white_check_mark: Resolved by *${esc(w.closed_by_name || w.closed_by || by)}* · ${ticket}`,
    left: w.close_reason === 'self_solved' ? ':bulb: Fixed it themselves with the self-help guide' : ':door: Left before being helped',
  }[w.status];
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${status}   ·   <${link}|Open walk-in #${w.id}>` }] });
  if (w.status === 'waiting') {
    blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'claim', value: String(w.id), style: 'primary', text: { type: 'plain_text', text: 'Claim' } }] });
  } else if (w.status === 'claimed') {
    blocks.push({ type: 'actions', elements: [{ type: 'button', action_id: 'claim', value: String(w.id), text: { type: 'plain_text', text: w.ticket ? 'Change ticket' : 'Add ticket' } }] });
  }
  return { text, blocks };
}

// ---------- Slack Web API ----------
async function api(method, body, token = config.slackBotToken) {
  const r = await fetch(`${config.slackApiUrl}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error || r.status}`);
  return data;
}

// ---------- Sending and updating posts ----------
async function send(w) {
  if (mode() === 'bot') {
    const r = await api('chat.postMessage', { channel: config.slackChannel, ...message(w, { buttons: true }), unfurl_links: false });
    db.prepare("UPDATE walkins SET slack_status='sent', slack_channel=?, slack_ts=?, slack_sync=0 WHERE id=?").run(r.channel, r.ts, w.id);
    return;
  }
  const r = await fetch(config.slackWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message(w)),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  db.prepare("UPDATE walkins SET slack_status='sent' WHERE id=?").run(w.id);
}

async function refresh(w) {
  await api('chat.update', { channel: w.slack_channel, ts: w.slack_ts, ...message(w, { buttons: true }) });
  db.prepare('UPDATE walkins SET slack_sync=0 WHERE id=?').run(w.id);
}

async function flush() {
  if (!enabled()) return;
  if (running) { again = true; return; }
  running = true;
  again = false;
  let healthy = true;
  try {
    const rows = db.prepare(`${walkins.SELECT} WHERE w.slack_status = 'pending' ORDER BY w.id LIMIT 20`).all();
    for (const w of rows) {
      try {
        await send(w);
      } catch (e) {
        console.warn(`Slack post for walk-in ${w.id} failed: ${e.message}`);
        db.prepare(`UPDATE walkins SET slack_tries = slack_tries + 1,
                    slack_status = CASE WHEN slack_tries + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id=?`).run(MAX_TRIES, w.id);
        healthy = false;
        break; // Slack is probably down; try the rest on the next round.
      }
    }
    if (healthy && mode() === 'bot') {
      const stale = db.prepare(`${walkins.SELECT} WHERE w.slack_sync = 1 AND w.slack_ts IS NOT NULL ORDER BY w.id LIMIT 50`).all();
      for (const w of stale) {
        try {
          await refresh(w);
        } catch (e) {
          console.warn(`Slack update for walk-in ${w.id} failed: ${e.message}`);
          // message_not_found / channel gone: stop trying for this one.
          if (/message_not_found|channel_not_found|cant_update_message/.test(e.message)) db.prepare('UPDATE walkins SET slack_sync=0 WHERE id=?').run(w.id);
          else { healthy = false; break; }
        }
      }
    }
  } finally {
    running = false;
  }
  if (again && healthy) await flush();
}

// Called right after a walk-in is saved or changed, so Slack catches up immediately.
const kick = () => { if (enabled()) setImmediate(flush); };
function changed(id) {
  if (mode() !== 'bot') return;
  db.prepare('UPDATE walkins SET slack_sync=1 WHERE id=? AND slack_ts IS NOT NULL').run(Number(id));
  kick();
}

// ---------- Who pressed the button? ----------
// Slack tells us the person's Slack member ID. Link it to a consultant on our list:
// 1) someone already linked to that ID, else 2) Slack profile email matches their sign-in email,
// else 3) same NetID across @rutgers.edu / @scarletmail.rutgers.edu. Admins can link anyone by hand.
const NETID_DOMAINS = ['rutgers.edu', 'scarletmail.rutgers.edu'];
async function consultantFor(slackUserId) {
  const linked = db.prepare('SELECT * FROM users WHERE slack_user_id = ? AND active = 1').get(slackUserId);
  if (linked) return linked;
  if (db.prepare('SELECT 1 FROM users WHERE slack_user_id = ?').get(slackUserId)) return null; // linked but turned off
  let email = '';
  try {
    email = String((await api('users.info', { user: slackUserId })).user?.profile?.email || '').toLowerCase();
  } catch (e) {
    console.warn(`Slack user lookup failed: ${e.message}`);
  }
  if (!email) return null;
  let matches = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1 AND slack_user_id IS NULL').all(email);
  const [local, domain] = email.split('@');
  if (!matches.length && NETID_DOMAINS.includes(domain)) {
    matches = db.prepare(`SELECT * FROM users WHERE email IN (${NETID_DOMAINS.map(() => '?').join(',')}) AND active = 1 AND slack_user_id IS NULL`)
      .all(...NETID_DOMAINS.map((d) => `${local}@${d}`));
  }
  if (matches.length !== 1) return null;
  db.prepare('UPDATE users SET slack_user_id = ? WHERE email = ?').run(slackUserId, matches[0].email);
  return { ...matches[0], slack_user_id: slackUserId };
}

const NOT_LINKED = "Your Slack account isn't linked to a walk-in tracker consultant. Ask an admin to add you, or to link your Slack member ID on the Admin page.";

async function tell(payload, text) {
  try {
    await api('chat.postEphemeral', { channel: payload.channel?.id || config.slackChannel, user: payload.user.id, text });
  } catch (e) {
    console.warn(`Slack ephemeral message failed: ${e.message}`);
  }
}

// Claim / Add ticket button pressed: check who it is, then open the ticket box.
async function onAction(payload) {
  const action = (payload.actions || [])[0];
  if (!action || action.action_id !== 'claim') return;
  const id = Number(action.value);
  const me = await consultantFor(payload.user.id);
  if (!me) return tell(payload, NOT_LINKED);
  const w = walkins.get(id);
  if (!w) return tell(payload, 'That walk-in no longer exists.');
  if (w.status === 'claimed' && w.claimed_by !== me.email) { changed(id); return tell(payload, `Already claimed by ${w.claimed_by_name || w.claimed_by}.`); }
  if (!['waiting', 'claimed'].includes(w.status)) { changed(id); return tell(payload, 'That walk-in is already closed.'); }
  await api('views.open', {
    trigger_id: payload.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'walkin_claim',
      private_metadata: String(id),
      title: { type: 'plain_text', text: w.status === 'waiting' ? `Claim walk-in #${id}` : `Walk-in #${id}` },
      submit: { type: 'plain_text', text: w.status === 'waiting' ? 'Claim' : 'Save' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${esc(w.location)} · ${esc(w.issue_type || w.description || 'No issue given')}` }] },
        {
          type: 'input', block_id: 'ticket', optional: true,
          label: { type: 'plain_text', text: 'ServiceNow ticket' },
          hint: { type: 'plain_text', text: 'Optional. You can add it later here or on the dashboard.' },
          element: { type: 'plain_text_input', action_id: 'value', placeholder: { type: 'plain_text', text: 'INC0012345' }, max_length: 20, ...(w.ticket ? { initial_value: w.ticket } : {}) },
        },
      ],
    },
  });
}

// Ticket box submitted. Returns what to send back to Slack: nothing closes the box,
// { response_action: 'errors' } keeps it open with a message under the field.
async function onSubmit(payload) {
  const view = payload.view || {};
  if (view.callback_id !== 'walkin_claim') return undefined;
  const id = Number(view.private_metadata);
  const errors = (msg) => ({ response_action: 'errors', errors: { ticket: msg } });
  const me = await consultantFor(payload.user.id);
  if (!me) return errors(NOT_LINKED);
  const ticket = view.state?.values?.ticket?.value?.value || '';
  const r = walkins.claimWithTicket(id, me.email, ticket);
  changed(id);
  if (r.error) return errors(r.error);
  return undefined;
}

// ---------- Socket Mode connection ----------
// The server opens a WebSocket out to Slack, so Slack never needs to reach the OIT server.
let ws = null;
let stopping = false;
let backoff = 1000;

async function handleEnvelope(env, reply) {
  if (env.type !== 'interactive') return reply({ envelope_id: env.envelope_id });
  const p = env.payload || {};
  if (p.type === 'view_submission') {
    let out;
    try { out = await onSubmit(p); } catch (e) { console.warn(`Slack submit failed: ${e.message}`); out = { response_action: 'errors', errors: { ticket: 'Something went wrong. Try the dashboard link instead.' } }; }
    return reply(out ? { envelope_id: env.envelope_id, payload: out } : { envelope_id: env.envelope_id });
  }
  reply({ envelope_id: env.envelope_id }); // acknowledge within 3 seconds, then do the work
  if (p.type === 'block_actions') await onAction(p).catch((e) => console.warn(`Slack button failed: ${e.message}`));
}

async function connect() {
  if (stopping) return;
  try {
    const { url } = await api('apps.connections.open', {}, config.slackAppToken);
    ws = new WebSocket(url);
    ws.onopen = () => { backoff = 1000; console.log('Slack: connected (Socket Mode).'); };
    ws.onmessage = (ev) => {
      let env;
      try { env = JSON.parse(ev.data); } catch { return; }
      if (env.type === 'disconnect') return ws.close(); // Slack asks us to reconnect now and then
      if (env.envelope_id) handleEnvelope(env, (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)));
    };
    ws.onclose = () => { ws = null; if (!stopping) setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); };
    ws.onerror = () => {}; // onclose follows and reconnects
  } catch (e) {
    console.warn(`Slack: could not connect (${e.message}). Retrying.`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60000);
  }
}

function start() {
  const m = mode();
  if (m === 'off') return console.log('Slack is off (no SLACK_ settings).');
  console.log(`Slack: ${m === 'bot' ? 'bot with Claim button' : 'post-only webhook'}.`);
  timer = setInterval(flush, 30000);
  timer.unref();
  flush();
  if (m === 'bot') connect();
}

function stop() {
  stopping = true;
  if (timer) clearInterval(timer);
  if (ws) ws.close();
}

module.exports = { mode, enabled, kick, changed, start, stop, flush, message, onAction, onSubmit, handleEnvelope, consultantFor };
