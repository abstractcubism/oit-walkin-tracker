const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const config = require('./config');
const { db, now } = require('./db');

const googleClient = new OAuth2Client(config.google.clientId);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.cookieSecure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...[].concat(prev), parts.join('; ')]);
}

// Is this email allowed to sign in with this provider ('google' | 'microsoft')?
// Returns { user } or { error }. ADMIN_EMAILS are always admins.
function authorize(email, name, provider) {
  email = String(email || '').toLowerCase();
  const domain = email.split('@')[1] || '';
  const p = config[provider];
  if (!p || !p.domains.includes(domain)) {
    return { error: `Sign in with ${p ? p.domains.map((d) => '@' + d).join(' or ') : 'an allowed'} account.` };
  }
  if (config.adminEmails.includes(email)) {
    db.prepare(`INSERT INTO users (email, name, role) VALUES (?, ?, 'admin')
                ON CONFLICT(email) DO UPDATE SET role='admin', active=1, name=COALESCE(excluded.name, users.name)`).run(email, name || null);
  } else if (provider === 'microsoft' && p.autoAllow) {
    // @oit accounts are staff-only, so they're let in unless an admin has turned them off.
    db.prepare("INSERT INTO users (email, name, role) VALUES (?, ?, 'consultant') ON CONFLICT(email) DO NOTHING").run(email, name || null);
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!user) return { error: 'Your account is not on the consultant list. Ask an admin to add you.' };
  if (name && !user.name) db.prepare('UPDATE users SET name = ? WHERE email = ?').run(name, email);
  return { user };
}

// Which provider owns this email's domain (used by dev login to act like the real thing).
const providerFor = (email) => ['microsoft', 'google'].find((p) => config[p].domains.includes(String(email).toLowerCase().split('@')[1]));

// ---- Google: the browser gets an ID token from Google's button; we verify it here. ----
async function verifyGoogle(credential) {
  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.google.clientId });
  const p = ticket.getPayload();
  if (!p.email_verified) throw new Error('Google email is not verified');
  return { email: p.email, name: p.name };
}

// ---- Microsoft (Entra ID): standard OpenID Connect authorization-code flow. ----
const msBase = () => `https://login.microsoftonline.com/${config.microsoft.tenantId}/oauth2/v2.0`;
const msRedirect = () => `${config.baseUrl}/auth/microsoft/callback`;

function microsoftStart(req, res) {
  const state = newToken();
  const nonce = newToken();
  // Remember state/nonce/return path for 10 minutes to check on the way back.
  setCookie(res, 'ms_flow', JSON.stringify({ state, nonce, next: safeNext(req.query.next) }), 600);
  const q = new URLSearchParams({
    client_id: config.microsoft.clientId, response_type: 'code', redirect_uri: msRedirect(),
    response_mode: 'query', scope: 'openid profile email', state, nonce, prompt: 'select_account',
  });
  res.redirect(`${msBase()}/authorize?${q}`);
}

async function microsoftFinish(req, res) {
  let flow = {};
  try { flow = JSON.parse(parseCookies(req).ms_flow || '{}'); } catch { /* ignore */ }
  setCookie(res, 'ms_flow', '', 0);
  if (!req.query.code || !flow.state || req.query.state !== flow.state) throw new Error('Sign-in expired or was tampered with. Try again.');

  // The ID token comes straight from Microsoft's token endpoint over TLS using our client
  // secret, so (per the OIDC spec) its signature doesn't need separate checking. We still
  // check who it was issued to, which tenant, the nonce and the expiry.
  const r = await fetch(`${msBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret,
      grant_type: 'authorization_code', code: req.query.code, redirect_uri: msRedirect(), scope: 'openid profile email',
    }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await r.json();
  if (!r.ok || !body.id_token) throw new Error('Microsoft sign-in failed: ' + (body.error_description || r.status));
  const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1], 'base64url').toString());
  if (claims.aud !== config.microsoft.clientId) throw new Error('Token was not issued to this app.');
  if (claims.tid !== config.microsoft.tenantId) throw new Error('Token is from the wrong Microsoft tenant.');
  if (claims.nonce !== flow.nonce) throw new Error('Sign-in nonce mismatch.');
  if (claims.exp * 1000 < Date.now()) throw new Error('Token expired.');
  return { email: claims.email || claims.preferred_username || claims.upn, name: claims.name, next: flow.next };
}

// Only allow redirects back into this app.
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

function startSession(res, email) {
  const token = newToken();
  const expires = new Date(Date.now() + config.sessionHours * 3600e3).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, email, expires_at) VALUES (?, ?, ?)').run(sha256(token), email, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  setCookie(res, 'sid', token, config.sessionHours * 3600);
}

function endSession(req, res) {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setCookie(res, 'sid', '', 0);
}

// Attaches req.user (consultant) and req.device (kiosk iPad) when present.
function loadIdentity(req, res, next) {
  const c = parseCookies(req);
  if (c.sid) {
    req.user = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.email = s.email
                           WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(sha256(c.sid), now()) || null;
  }
  if (c.kiosk) {
    req.device = db.prepare(`SELECT d.*, l.name AS location_name FROM devices d JOIN locations l ON l.id = d.location_id
                             WHERE d.token_hash = ? AND d.revoked_at IS NULL`).get(sha256(c.kiosk)) || null;
  }
  next();
}

const wantsHtml = (req) => !req.path.startsWith('/api/');

function requireUser(req, res, next) {
  if (req.user) return next();
  if (wantsHtml(req)) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  res.status(401).json({ error: 'Please sign in.' });
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (wantsHtml(req)) return req.user ? res.status(403).send('Admins only.') : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  res.status(403).json({ error: 'Admins only.' });
}

function requireDevice(req, res, next) {
  if (req.device) return next();
  if (wantsHtml(req)) return res.redirect('/setup');
  res.status(401).json({ error: 'This iPad is not set up. A consultant needs to set it up.' });
}

module.exports = {
  sha256, newToken, setCookie, authorize, providerFor, verifyGoogle, microsoftStart, microsoftFinish, safeNext, startSession, endSession,
  loadIdentity, requireUser, requireAdmin, requireDevice,
};
