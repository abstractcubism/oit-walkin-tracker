// Small helpers shared by every page. No framework, no build step.

async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  if (r.status === 401 && !location.pathname.startsWith('/kiosk')) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('Signed out');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status });
  return data;
}

// el('div', {class: 'x', onclick: fn}, 'text', child) -> element. Strings are always text, never HTML.
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
function minutesSince(iso, until) {
  return Math.max(0, Math.round(((until ? new Date(until) : new Date()) - new Date(iso)) / 60000));
}
function ago(iso) {
  const m = minutesSince(iso);
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
const who = (w) => w.netid || w.name || '(erased)';
const STATUS = { waiting: 'Waiting', claimed: 'Claimed', resolved: 'Resolved', left: 'Left' };
const chip = (s) => el('span', { class: 'chip ' + s }, STATUS[s] || s);

function toast(msg) {
  const t = el('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// Top navigation for staff pages.
async function staffNav(active) {
  const me = await api('/api/me');
  const links = [['/dashboard', 'Queue'], ['/reports', 'Reports']];
  if (me.role === 'admin') links.push(['/admin', 'Admin']);
  const bar = el('nav', { class: 'topbar' },
    el('span', { class: 'brand' }, 'OIT Walk-ins'),
    links.map(([href, label]) => el('a', { href, class: href === active ? 'active' : null }, label)),
    el('span', { class: 'hide-sm small' }, me.name || me.email),
    el('button', { onclick: async () => { await api('/api/auth/logout', {}); location.href = '/login'; } }, 'Sign out'));
  document.body.prepend(bar);
  return me;
}
