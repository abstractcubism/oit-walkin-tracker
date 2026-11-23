// The rules for changing a walk-in, shared by the dashboard and the Slack Claim button,
// so both behave exactly the same way.
const config = require('./config');
const { db, now, tx } = require('./db');

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const TICKET_RE = /^[A-Z]{3,6}\d{5,10}$/;
const TICKET_HELP = 'Ticket numbers look like INC0012345 or RITM0012345.';

// Returns '' for blank, the upper-cased ticket if valid, or null if it doesn't look right.
function parseTicket(v) {
  const t = clean(v, 20).toUpperCase();
  if (!t) return '';
  return TICKET_RE.test(t) ? t : null;
}

const SELECT = `SELECT w.*, l.name AS location, cu.name AS claimed_by_name, xu.name AS closed_by_name
  FROM walkins w JOIN locations l ON l.id = w.location_id
  LEFT JOIN users cu ON cu.email = w.claimed_by LEFT JOIN users xu ON xu.email = w.closed_by`;

const get = (id) => db.prepare(`${SELECT} WHERE w.id = ?`).get(Number(id));
const nameOf = (email) => (email ? db.prepare('SELECT name FROM users WHERE email=?').get(email)?.name || email : null);

// Apply one action as consultant `me` (their email). Returns {} on success or { code, error }.
function act(id, action, me, body = {}) {
  id = Number(id);
  return tx(() => {
    const w = db.prepare('SELECT * FROM walkins WHERE id = ?').get(id);
    if (!w) return { code: 404, error: 'Walk-in not found.' };
    switch (action) {
      case 'claim': {
        // Only succeeds if nobody else has it, so two consultants can't both claim.
        const r = db.prepare("UPDATE walkins SET status='claimed', claimed_by=?, claimed_at=? WHERE id=? AND status='waiting'").run(me, now(), id);
        if (r.changes === 0) {
          const who = nameOf(w.claimed_by);
          return { code: 409, error: who && w.status === 'claimed' ? `Already claimed by ${who}.` : 'This walk-in is no longer waiting.' };
        }
        return {};
      }
      case 'unclaim':
        if (w.status !== 'claimed') return { code: 409, error: 'This walk-in is not claimed.' };
        db.prepare("UPDATE walkins SET status='waiting', claimed_by=NULL, claimed_at=NULL WHERE id=?").run(id);
        return {};
      case 'update': {
        const fields = {};
        if ('ticket' in body) {
          const t = parseTicket(body.ticket);
          if (t === null) return { code: 400, error: TICKET_HELP };
          fields.ticket = t || null;
        }
        if ('notes' in body) fields.notes = clean(body.notes, 2000) || null;
        const keys = Object.keys(fields);
        if (keys.length) db.prepare(`UPDATE walkins SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...keys.map((k) => fields[k]), id);
        return {};
      }
      case 'resolve':
        if (!['waiting', 'claimed'].includes(w.status)) return { code: 409, error: 'This walk-in is already closed.' };
        if (config.requireTicket && !w.ticket) return { code: 400, error: 'Add the ServiceNow ticket number first.' };
        db.prepare(`UPDATE walkins SET status='resolved', closed_at=?, closed_by=?,
                    claimed_by=COALESCE(claimed_by, ?), claimed_at=COALESCE(claimed_at, ?) WHERE id=?`).run(now(), me, me, now(), id);
        return {};
      case 'left': {
        // Plain "left / no-show", or "fixed it themselves" (e.g. with the self-help QR code).
        if (!['waiting', 'claimed'].includes(w.status)) return { code: 409, error: 'This walk-in is already closed.' };
        const reason = body.reason === 'self_solved' ? 'self_solved' : null;
        db.prepare("UPDATE walkins SET status='left', close_reason=?, closed_at=?, closed_by=? WHERE id=?").run(reason, now(), me, id);
        return {};
      }
      case 'reopen':
        if (!['resolved', 'left'].includes(w.status)) return { code: 409, error: 'This walk-in is still open.' };
        db.prepare(`UPDATE walkins SET status=CASE WHEN claimed_by IS NULL THEN 'waiting' ELSE 'claimed' END,
                    closed_at=NULL, closed_by=NULL, close_reason=NULL WHERE id=?`).run(id);
        return {};
      default:
        return { code: 404, error: 'Unknown action.' };
    }
  });
}

// Claim (if still waiting) and optionally set the ticket, in one step. Used by the Slack box.
// The person who already holds the claim can use it again to change the ticket.
function claimWithTicket(id, me, ticketInput) {
  const t = parseTicket(ticketInput);
  if (t === null) return { code: 400, error: TICKET_HELP, field: 'ticket' };
  return tx(() => {
    const w = db.prepare('SELECT * FROM walkins WHERE id = ?').get(Number(id));
    if (!w) return { code: 404, error: 'Walk-in not found.' };
    if (w.status === 'claimed' && w.claimed_by !== me) return { code: 409, error: `Already claimed by ${nameOf(w.claimed_by)}.` };
    if (!['waiting', 'claimed'].includes(w.status)) return { code: 409, error: 'This walk-in is already closed.' };
    if (w.status === 'waiting') {
      const r = act(id, 'claim', me);
      if (r.error) return r;
    }
    if (t) db.prepare('UPDATE walkins SET ticket=? WHERE id=?').run(t, Number(id));
    return {};
  });
}

module.exports = { SELECT, get, act, claimWithTicket, clean, parseTicket, nameOf, TICKET_HELP };
