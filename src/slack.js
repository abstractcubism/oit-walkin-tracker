// Posts new walk-ins to Slack through an incoming webhook.
//
// Walk-ins are always saved first. This worker then sends anything still "pending" and
// retries on failure, so a Slack outage never loses a walk-in; it just delays the post.
const config = require('./config');
const { db } = require('./db');

const MAX_TRIES = 10;
let timer = null;
let running = false;
let again = false; // a new walk-in arrived while we were sending

const enabled = () => Boolean(config.slackWebhookUrl);

// Slack mrkdwn needs &, <, > escaped.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function message(w) {
  const who = w.netid
    ? `*NetID:* \`${esc(w.netid)}\``
    : `*Name:* ${esc(w.name)}   *Email:* ${esc(w.email)}`;
  const issue = [w.issue_type, w.description].filter(Boolean).map(esc).join(' – ');
  const link = `${config.baseUrl}/w/${w.id}`;
  const text = `New walk-in at ${w.location}: ${w.netid || w.name}`;
  return {
    text, // shown in notifications
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:wave: *New walk-in at ${esc(w.location)}*\n${who}\n*Issue:* ${issue || '_none given_'}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `<${link}|Open walk-in #${w.id} to claim and add the ticket>` }] },
    ],
  };
}

async function flush() {
  if (!enabled()) return;
  if (running) { again = true; return; }
  running = true;
  again = false;
  let healthy = true;
  try {
    const rows = db.prepare(`SELECT w.*, l.name AS location FROM walkins w JOIN locations l ON l.id = w.location_id
                             WHERE w.slack_status = 'pending' ORDER BY w.id LIMIT 20`).all();
    for (const w of rows) {
      let ok = false;
      try {
        const r = await fetch(config.slackWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message(w)),
          signal: AbortSignal.timeout(10000),
        });
        ok = r.ok;
        if (!ok) console.warn(`Slack post for walk-in ${w.id} failed: HTTP ${r.status} ${await r.text()}`);
      } catch (e) {
        console.warn(`Slack post for walk-in ${w.id} failed: ${e.message}`);
      }
      if (ok) db.prepare("UPDATE walkins SET slack_status='sent' WHERE id=?").run(w.id);
      else {
        db.prepare(`UPDATE walkins SET slack_tries = slack_tries + 1,
                    slack_status = CASE WHEN slack_tries + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id=?`).run(MAX_TRIES, w.id);
        healthy = false;
        break; // Slack is probably down; try the rest on the next round.
      }
    }
  } finally {
    running = false;
  }
  if (again && healthy) await flush();
}

// Called right after a walk-in is saved, so posts go out immediately.
const kick = () => { if (enabled()) setImmediate(flush); };

function start() {
  if (!enabled()) return console.log('Slack posting is off (SLACK_WEBHOOK_URL not set).');
  timer = setInterval(flush, 30000);
  timer.unref();
  flush();
}

module.exports = { enabled, kick, start, flush, message };
