const path = require('path');
const express = require('express');
const config = require('./config');
const { db, now, tx, parseOptions } = require('./db');
const auth = require('./auth');
const slack = require('./slack');
const { startRetention } = require('./retention');

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

// Basic hardening headers.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Writes must be JSON. Browsers can't send cross-site JSON without CORS, so this blocks CSRF.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  next();
});

app.use(auth.loadIdentity);

const pub = path.join(__dirname, '..', 'public');
const page = (file) => (req, res) => res.sendFile(path.join(pub, file));
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------- Pages ----------
app.get('/', (req, res) => res.redirect(req.device && !req.user ? '/kiosk' : '/dashboard'));
app.get('/login', page('login.html'));
app.get('/setup', auth.requireUser, page('setup.html'));
app.get('/kiosk', auth.requireDevice, page('kiosk.html'));
app.get('/dashboard', auth.requireUser, page('dashboard.html'));
app.get('/w/:id', auth.requireUser, page('walkin.html'));
app.get('/reports', auth.requireUser, page('reports.html'));
app.get('/admin', auth.requireAdmin, page('admin.html'));
app.use(express.static(pub, { index: false }));

// ---------- Sign-in ----------
app.get('/api/auth/config', (req, res) => {
  res.json({
    google: config.google.clientId ? { clientId: config.google.clientId, domains: config.google.domains } : null,
    microsoft: config.microsoft.clientId ? { domains: config.microsoft.domains } : null,
    devLogin: config.devLogin,
  });
});

if (config.microsoft.clientId) {
  app.get('/auth/microsoft', auth.microsoftStart);
  app.get('/auth/microsoft/callback', async (req, res) => {
    try {
      if (req.query.error) throw new Error(req.query.error_description || req.query.error);
      const who = await auth.microsoftFinish(req, res);
      const { user, error } = auth.authorize(who.email, who.name, 'microsoft');
      if (error) throw new Error(error);
      auth.startSession(res, user.email);
      res.redirect(who.next);
    } catch (e) {
      console.warn('Microsoft sign-in failed:', e.message);
      res.redirect('/login?error=' + encodeURIComponent(e.message));
    }
  });
}

app.post('/api/auth/google', async (req, res) => {
  if (!config.google.clientId) return bad(res, 'Google sign-in is not set up.', 404);
  let who;
  try {
    who = await auth.verifyGoogle(req.body.credential);
  } catch (e) {
    return bad(res, 'Google sign-in failed. Try again.', 401);
  }
  const { user, error } = auth.authorize(who.email, who.name, 'google');
  if (error) return bad(res, error, 403);
  auth.startSession(res, user.email);
  res.json({ ok: true });
});

if (config.devLogin) {
  app.post('/api/auth/dev', (req, res) => {
    const { user, error } = auth.authorize(req.body.email, null, auth.providerFor(req.body.email) || 'google');
    if (error) return bad(res, error, 403);
    auth.startSession(res, user.email);
    res.json({ ok: true });
  });
}

app.post('/api/auth/logout', (req, res) => {
  auth.endSession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', auth.requireUser, (req, res) => {
  res.json({ email: req.user.email, name: req.user.name, role: req.user.role, device: req.device ? { location: req.device.location_name } : null });
});

// ---------- Kiosk (iPad) ----------
app.get('/api/locations', auth.requireUser, (req, res) => {
  res.json(db.prepare('SELECT id, name FROM locations WHERE active = 1 ORDER BY name').all());
});

// A signed-in consultant links this iPad to a location. The iPad gets its own token, which
// can only submit walk-ins. The consultant is then signed out on the iPad.
app.post('/api/kiosk/setup', auth.requireUser, (req, res) => {
  const loc = db.prepare('SELECT * FROM locations WHERE id = ? AND active = 1').get(Number(req.body.location_id));
  if (!loc) return bad(res, 'Pick a location.');
  const token = auth.newToken();
  if (req.device) db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now(), req.device.id);
  db.prepare('INSERT INTO devices (token_hash, location_id, created_by) VALUES (?, ?, ?)').run(auth.sha256(token), loc.id, req.user.email);
  auth.setCookie(res, 'kiosk', token, 400 * 24 * 3600);
  auth.endSession(req, res);
  res.json({ ok: true });
});

app.post('/api/kiosk/unlink', auth.requireUser, (req, res) => {
  if (req.device) db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now(), req.device.id);
  auth.setCookie(res, 'kiosk', '', 0);
  res.json({ ok: true });
});

app.get('/api/kiosk/info', auth.requireDevice, (req, res) => {
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now(), req.device.id);
  res.json({
    location: req.device.location_name,
    minDescription: MIN_DESCRIPTION,
    issues: db.prepare('SELECT label, options FROM issue_types WHERE active = 1 ORDER BY sort, label').all()
      .map((r) => ({ label: r.label, options: parseOptions(r.options) })),
  });
});

const MIN_DESCRIPTION = 10; // characters, when no issue button is picked
const NETID_RE = /^[a-z]{2,8}[0-9]{1,6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/kiosk/walkins', auth.requireDevice, (req, res) => {
  const netid = clean(req.body.netid, 20).toLowerCase();
  const name = clean(req.body.name, 100);
  const email = clean(req.body.email, 200).toLowerCase();
  const issueType = clean(req.body.issue_type, 100);
  const description = clean(req.body.description, 1000);

  if (netid) {
    if (!NETID_RE.test(netid)) return bad(res, 'That NetID doesn\'t look right. It\'s usually letters then numbers, like abc123.');
  } else {
    if (!name) return bad(res, 'Enter your NetID, or your name and email.');
    if (!EMAIL_RE.test(email)) return bad(res, 'Enter a valid email address.');
  }
  // Either a quick-tap issue, or a real description (a few words, not just "help").
  if (issueType) {
    // Either "Label", or "Label · Option" for buttons with sub-choices (e.g. "Wi-Fi · eduroam").
    const [label, option] = issueType.split(' · ');
    const known = db.prepare('SELECT options FROM issue_types WHERE label = ? AND active = 1').get(label);
    if (!known) return bad(res, 'Please pick one of the issue buttons.');
    const opts = parseOptions(known.options);
    if (opts.length && !opts.includes(option)) return bad(res, `Pick which ${label} it is: ${opts.join(' or ')}.`);
    if (!opts.length && option) return bad(res, 'Please pick one of the issue buttons.');
  } else if (description.length < MIN_DESCRIPTION) {
    return bad(res, 'Tap the issue that fits best, or tell us a bit more about what you need.');
  }

  const r = db.prepare(`INSERT INTO walkins (location_id, device_id, netid, name, email, issue_type, description, slack_status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.device.location_id, req.device.id, netid || null, netid ? (name || null) : name, netid ? null : email,
      issueType || null, description || null, slack.enabled() ? 'pending' : 'off');
  slack.kick();
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

// ---------- Dashboard ----------
const WALKIN_SELECT = `SELECT w.*, l.name AS location, cu.name AS claimed_by_name, xu.name AS closed_by_name
  FROM walkins w JOIN locations l ON l.id = w.location_id
  LEFT JOIN users cu ON cu.email = w.claimed_by LEFT JOIN users xu ON xu.email = w.closed_by`;

app.get('/api/walkins', auth.requireUser, (req, res) => {
  const where = [];
  const args = [];
  if (req.query.view === 'open') where.push("w.status IN ('waiting','claimed')");
  else {
    // "today" (default) = everything created since local midnight, passed by the browser.
    const since = req.query.since && !isNaN(Date.parse(req.query.since)) ? new Date(req.query.since).toISOString() : new Date(Date.now() - 24 * 3600e3).toISOString();
    where.push('(w.created_at >= ? OR w.status IN (\'waiting\',\'claimed\'))');
    args.push(since);
  }
  if (req.query.location) { where.push('w.location_id = ?'); args.push(Number(req.query.location)); }
  const rows = db.prepare(`${WALKIN_SELECT} WHERE ${where.join(' AND ')} ORDER BY w.created_at DESC LIMIT 500`).all(...args);
  res.json(rows);
});

app.get('/api/walkins/:id', auth.requireUser, (req, res) => {
  const w = db.prepare(`${WALKIN_SELECT} WHERE w.id = ?`).get(Number(req.params.id));
  if (!w) return bad(res, 'Walk-in not found.', 404);
  res.json(w);
});

const TICKET_RE = /^[A-Z]{3,6}\d{5,10}$/;

// One endpoint for every state change, so the rules live in one place.
app.post('/api/walkins/:id/:action', auth.requireUser, (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.email;
  const result = tx(() => {
    const w = db.prepare('SELECT * FROM walkins WHERE id = ?').get(id);
    if (!w) return { code: 404, error: 'Walk-in not found.' };
    switch (req.params.action) {
      case 'claim': {
        // Only succeeds if nobody else has it, so two consultants can't both claim.
        const r = db.prepare("UPDATE walkins SET status='claimed', claimed_by=?, claimed_at=? WHERE id=? AND status='waiting'").run(me, now(), id);
        if (r.changes === 0) {
          const who = w.claimed_by ? (db.prepare('SELECT name FROM users WHERE email=?').get(w.claimed_by)?.name || w.claimed_by) : null;
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
        if ('ticket' in req.body) {
          const t = clean(req.body.ticket, 20).toUpperCase();
          if (t && !TICKET_RE.test(t)) return { code: 400, error: 'Ticket numbers look like INC0012345 or RITM0012345.' };
          fields.ticket = t || null;
        }
        if ('notes' in req.body) fields.notes = clean(req.body.notes, 2000) || null;
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
      case 'left':
        if (!['waiting', 'claimed'].includes(w.status)) return { code: 409, error: 'This walk-in is already closed.' };
        db.prepare("UPDATE walkins SET status='left', closed_at=?, closed_by=? WHERE id=?").run(now(), me, id);
        return {};
      case 'reopen':
        if (!['resolved', 'left'].includes(w.status)) return { code: 409, error: 'This walk-in is still open.' };
        db.prepare(`UPDATE walkins SET status=CASE WHEN claimed_by IS NULL THEN 'waiting' ELSE 'claimed' END,
                    closed_at=NULL, closed_by=NULL WHERE id=?`).run(id);
        return {};
      default:
        return { code: 404, error: 'Unknown action.' };
    }
  });
  if (result.error) return bad(res, result.error, result.code);
  res.json(db.prepare(`${WALKIN_SELECT} WHERE w.id = ?`).get(id));
});

// ---------- Reports ----------
function range(req) {
  const from = !isNaN(Date.parse(req.query.from)) ? new Date(req.query.from).toISOString() : new Date(Date.now() - 7 * 24 * 3600e3).toISOString();
  const to = !isNaN(Date.parse(req.query.to)) ? new Date(req.query.to).toISOString() : new Date().toISOString();
  return [from, to];
}

const MINUTES = (a, b) => `ROUND(AVG((julianday(${b}) - julianday(${a})) * 1440), 1)`;

app.get('/api/reports', auth.requireUser, (req, res) => {
  const [from, to] = range(req);
  const base = 'FROM walkins w JOIN locations l ON l.id = w.location_id WHERE w.created_at >= ? AND w.created_at < ?';
  const q = (sql) => db.prepare(sql).all(from, to);
  res.json({
    from, to,
    totals: db.prepare(`SELECT COUNT(*) AS total,
        SUM(status='resolved') AS resolved, SUM(status='left') AS left_count, SUM(status IN ('waiting','claimed')) AS open,
        ${MINUTES('w.created_at', 'w.claimed_at')} AS avg_wait_min,
        ${MINUTES('w.claimed_at', 'w.closed_at')} AS avg_handle_min ${base}`).get(from, to),
    byLocation: q(`SELECT l.name AS label, COUNT(*) AS n, ${MINUTES('w.created_at', 'w.claimed_at')} AS avg_wait_min ${base} GROUP BY l.name ORDER BY n DESC`),
    byIssue: q(`SELECT COALESCE(w.issue_type, 'Something else') AS label, COUNT(*) AS n ${base} GROUP BY label ORDER BY n DESC`),
    byConsultant: q(`SELECT COALESCE(u.name, w.claimed_by) AS label, COUNT(*) AS n ${base.replace('WHERE', 'LEFT JOIN users u ON u.email = w.claimed_by WHERE')} AND w.claimed_by IS NOT NULL GROUP BY w.claimed_by ORDER BY n DESC`),
    // Raw timestamps; the browser buckets them by local hour/day.
    times: q(`SELECT w.created_at ${base}`).map((r) => r.created_at),
  });
});

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

app.get('/api/reports/export.csv', auth.requireUser, (req, res) => {
  const [from, to] = range(req);
  const rows = db.prepare(`${WALKIN_SELECT} WHERE w.created_at >= ? AND w.created_at < ? ORDER BY w.created_at`).all(from, to);
  const cols = ['id', 'created_at', 'location', 'netid', 'name', 'email', 'issue_type', 'description', 'status',
    'claimed_by', 'claimed_at', 'ticket', 'closed_at', 'closed_by', 'notes'];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="walkins-${from.slice(0, 10)}-to-${to.slice(0, 10)}.csv"`);
  res.send([cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n'));
});

// ---------- Admin ----------
app.get('/api/admin', auth.requireAdmin, (req, res) => {
  res.json({
    users: db.prepare('SELECT email, name, role, active FROM users ORDER BY active DESC, role, email').all(),
    locations: db.prepare('SELECT * FROM locations ORDER BY active DESC, name').all(),
    issues: db.prepare('SELECT * FROM issue_types ORDER BY active DESC, sort, label').all(),
    devices: db.prepare(`SELECT d.id, l.name AS location, d.created_by, d.created_at, d.last_seen FROM devices d
                         JOIN locations l ON l.id = d.location_id WHERE d.revoked_at IS NULL ORDER BY d.created_at DESC`).all(),
    adminEmails: config.adminEmails,
    retentionDays: config.retentionDays,
    slack: slack.enabled(),
  });
});

app.post('/api/admin/users', auth.requireAdmin, (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'consultant';
  if (!EMAIL_RE.test(email)) return bad(res, 'Enter a valid email.');
  if (!config.allowedDomains.includes(email.split('@')[1])) return bad(res, `Email must end in ${config.allowedDomains.map((d) => '@' + d).join(' or ')}.`);
  const active = req.body.active === false ? 0 : 1;
  if (email === req.user.email && (!active || role !== 'admin')) return bad(res, 'You can\'t remove your own admin access.');
  db.prepare(`INSERT INTO users (email, name, role, active) VALUES (?, ?, ?, ?)
              ON CONFLICT(email) DO UPDATE SET role=excluded.role, active=excluded.active, name=COALESCE(excluded.name, users.name)`)
    .run(email, clean(req.body.name, 100) || null, role, active);
  if (!active) db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
  res.json({ ok: true });
});

// Add a new row (no id) or edit/enable/disable an existing one (with id).
function saveRow(res, { table, col, max, body, extra = {} }) {
  const value = clean(body[col], max);
  const active = body.active === false ? 0 : 1;
  try {
    if (body.id) {
      const sets = [`${col} = COALESCE(NULLIF(?, ''), ${col})`, 'active = ?', ...Object.keys(extra).map((k) => `${k} = COALESCE(?, ${k})`)];
      db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(value, active, ...Object.values(extra), Number(body.id));
    } else {
      if (!value) return bad(res, 'Enter a name.');
      const cols = [col, ...Object.keys(extra)];
      db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(value, ...Object.values(extra));
    }
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(res, 'That one already exists.');
    throw e;
  }
  res.json({ ok: true });
}
app.post('/api/admin/locations', auth.requireAdmin, (req, res) => saveRow(res, { table: 'locations', col: 'name', max: 100, body: req.body }));
app.post('/api/admin/issues', auth.requireAdmin, (req, res) => {
  const blankSort = req.body.sort == null || req.body.sort === '';
  const extra = { sort: blankSort ? (req.body.id ? null : 100) : Number(req.body.sort) };
  if (typeof req.body.options === 'string') extra.options = parseOptions(req.body.options).map((o) => o.slice(0, 40)).join(',');
  else if (!req.body.id) extra.options = '';
  if (String(req.body.label || '').includes(' · ')) return bad(res, 'Button text can\'t contain " · ".');
  saveRow(res, { table: 'issue_types', col: 'label', max: 60, body: req.body, extra });
});

app.post('/api/admin/devices/:id/revoke', auth.requireAdmin, (req, res) => {
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now(), Number(req.params.id));
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

if (require.main === module) {
  app.listen(config.port, () => console.log(`Walk-in tracker on ${config.baseUrl} (port ${config.port})`));
  slack.start();
  startRetention();
}

module.exports = app;
