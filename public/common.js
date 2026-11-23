// Small helpers shared by every page. No framework, no build step.

async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  if (r.status === 401 && !location.pathname.startsWith('/kiosk') && !location.pathname.startsWith('/tv')) {
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
// "Left", or "Fixed it themselves" when they used the self-help link (or a consultant marked it so).
const closedLabel = (w) => (w.close_reason === 'self_solved' ? 'Fixed it themselves' : STATUS[w.status] || w.status);

// Status messages go into one live region that exists from page load, so screen readers
// announce them (WCAG 4.1.3). The same region shows the toast on screen.
function liveRegion() {
  let r = document.getElementById('toast');
  if (!r) { r = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(r); }
  return r;
}
let toastTimer = null;
function toast(msg) {
  const t = liveRegion();
  t.textContent = '';
  // Clearing first and setting on the next frame makes repeat messages announce again.
  requestAnimationFrame(() => { t.textContent = msg; });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.textContent = ''; }, 4000);
}
// Announce to screen readers only, without a visible toast.
function announce(msg) {
  let r = document.getElementById('announce');
  if (!r) { r = el('div', { id: 'announce', class: 'sr-only', role: 'status', 'aria-live': 'polite' }); document.body.append(r); }
  r.textContent = '';
  requestAnimationFrame(() => { r.textContent = msg; });
}
document.addEventListener('DOMContentLoaded', () => { liveRegion(); });

// The Rutgers R. Only the official file from University Communications and Marketing is ever shown
// (put it at public/brand/rutgers-logo.svg, see public/brand/README.md). Until it is there, the
// university's name shows in plain text. BRAND_ALT must say exactly what the file says.
const BRAND_SRC = '/brand/rutgers-logo.svg';
const BRAND_ALT = 'Rutgers University, Office of Information Technology';
function brandMark(attrs) {
  const box = el('span', Object.assign({ class: 'brandmark' }, attrs || {}));
  const text = () => box.replaceChildren(el('span', { class: 'brand-text' }, 'Rutgers University'));
  if (brandMark.missing) { text(); return box; }
  const img = el('img', { src: BRAND_SRC, alt: BRAND_ALT, height: '36' });
  img.addEventListener('error', () => { brandMark.missing = true; text(); });
  box.append(img);
  return box;
}

// Link to a ticket in ServiceNow. nav_to.do keeps ServiceNow's normal frame; task.do covers
// incidents, requests, RITMs and tasks, so one format works for every ticket number.
function servicenowLink(base, ticket) {
  return `${base}/nav_to.do?uri=${encodeURIComponent('task.do?sysparm_query=number=' + ticket)}`;
}

// Top navigation for staff pages: skip link, Rutgers R, page links, who is signed in.
async function staffNav(active) {
  const me = await api('/api/me');
  const links = [['/dashboard', 'Queue'], ['/reports', 'Reports']];
  if (me.role === 'admin') links.push(['/admin', 'Admin']);
  const display = me.name || me.email.split('@')[0];
  const initials = display.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const main = document.querySelector('main');
  if (main && !main.id) main.id = 'main';
  const header = el('header', {},
    el('a', { class: 'skip', href: '#main' }, 'Skip to main content'),
    el('nav', { class: 'topbar', 'aria-label': 'Main' },
      el('span', { class: 'brand' }, brandMark(), el('span', { class: 'appname hide-sm' }, 'Walk-ins')),
      links.map(([href, label]) => el('a', { href, class: 'nav', 'aria-current': href === active ? 'page' : null }, label)),
      el('span', { class: 'me', title: me.email }, el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials), el('span', { class: 'hide-sm' }, display)),
      el('button', { onclick: async () => { await api('/api/auth/logout', {}); location.href = '/login'; } }, 'Sign out')));
  document.body.prepend(header);
  labelEmptyHeaders();
  return me;
}

// Table columns that hold only buttons get a name for screen readers (WCAG 1.3.1).
function labelEmptyHeaders() {
  document.querySelectorAll('th').forEach((th) => { if (!th.textContent.trim()) th.append(el('span', { class: 'sr-only' }, 'Actions')); });
}
