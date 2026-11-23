// Sheet connection through the Google Sheets API with a Google Cloud service account.
// The Sheet must be shared with the service account's email as an Editor.
const fs = require('fs');
const { JWT } = require('google-auth-library');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const MARK = 'Written by the OIT walk-in tracker';

// Accepts a bare spreadsheet ID or a full docs.google.com link.
const spreadsheetIdFrom = (s) => (String(s || '').match(/\/spreadsheets\/d\/([\w-]+)/) || [])[1] || String(s || '').trim();

// getToken and apiBase are for tests; normally they come from the key file and Google.
function create({ spreadsheetId, keyFile, tab, getToken, clientEmail, apiBase = 'https://sheets.googleapis.com' }) {
  const id = spreadsheetIdFrom(spreadsheetId);
  if (!id) throw new Error('SHEETS_SPREADSHEET_ID must be set (the ID or link of the Sheet).');
  let email = clientEmail;
  if (!getToken) {
    if (!keyFile || !fs.existsSync(keyFile)) throw new Error('SHEETS_SA_KEY_FILE must point to the service account\'s JSON key file.');
    const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    email = key.client_email;
    const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE] });
    getToken = async () => (await jwt.getAccessToken()).token;
  }

  const range = (a1 = '') => `'${tab.replace(/'/g, "''")}'${a1 ? `!${a1}` : ''}`;
  async function api(method, path, body) {
    let r;
    try {
      r = await fetch(`${apiBase}/v4/spreadsheets/${id}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await getToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new Error(`can't reach the Sheets API (${e.cause?.code || e.message})`);
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const hint = r.status === 403 || r.status === 404 ? ` Is the Sheet shared with ${email} as an Editor?` : '';
      throw new Error(`Sheets API HTTP ${r.status}: ${data.error?.message || 'no details'}.${hint}`);
    }
    return data;
  }

  async function setup(headers) {
    const meta = await api('GET', `?fields=${encodeURIComponent('sheets(properties(sheetId,title),protectedRanges(description))')}`);
    let sheet = (meta.sheets || []).find((s) => s.properties.title === tab);
    const requests = [];
    if (!sheet) {
      const r = await api('POST', ':batchUpdate', { requests: [{ addSheet: { properties: { title: tab } } }] });
      sheet = { properties: r.replies[0].addSheet.properties, protectedRanges: [] };
    }
    const sheetId = sheet.properties.sheetId;
    requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    if (!(sheet.protectedRanges || []).some((p) => p.description === MARK)) {
      // Only the service account can edit. The Sheet's owner can always edit too (Google's rule).
      requests.push({ addProtectedRange: { protectedRange: { range: { sheetId }, description: MARK, warningOnly: false, editors: { users: [email].filter(Boolean) } } } });
    }
    await api('POST', ':batchUpdate', { requests });
    await api('PUT', `/values/${encodeURIComponent(range('A1'))}?valueInputOption=RAW`, { values: [headers] });
  }

  async function upsert(rows) {
    // Find each walk-in's row by the ID in column A (one read per batch).
    const col = await api('GET', `/values/${encodeURIComponent(range('A:A'))}?majorDimension=COLUMNS`);
    const at = new Map();
    (col.values?.[0] || []).forEach((v, i) => { if (i > 0 && v !== '') at.set(String(v), i + 1); });
    const updates = [];
    const adds = [];
    for (const row of rows) {
      const n = at.get(String(row[0]));
      if (n) updates.push({ range: range(`A${n}`), values: [row] });
      else adds.push(row);
    }
    if (updates.length) await api('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data: updates });
    if (adds.length) {
      await api('POST', `/values/${encodeURIComponent(range('A1'))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: adds });
    }
    return { updated: updates.length, added: adds.length };
  }

  async function readAll() {
    const d = await api('GET', `/values/${encodeURIComponent(range())}`);
    const [headers = [], ...rows] = d.values || [];
    return { headers, rows };
  }

  return { target: id, describe: () => `service account ${email}`, setup, upsert, readAll };
}

module.exports = { create, spreadsheetIdFrom };
