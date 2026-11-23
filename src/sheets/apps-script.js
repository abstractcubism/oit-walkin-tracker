// Sheet connection through an Apps Script web app that lives inside the Sheet itself.
// The script (apps-script/Code.gs) runs as the Sheet owner's Google account, so no Google Cloud
// project or service account is needed. The app proves itself with a shared secret.
function create({ appsScriptUrl: url, appsScriptSecret: secret, tab }) {
  if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(url || '')) throw new Error('SHEETS_APPS_SCRIPT_URL must be the web app\'s https://script.google.com/.../exec address.');
  if (!secret || secret.length < 16) throw new Error('SHEETS_APPS_SCRIPT_SECRET must be set (16+ characters, same as the SECRET script property).');

  async function call(action, payload = {}) {
    let r;
    try {
      // Apps Script answers with a redirect to the result; fetch follows it.
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, action, tab, ...payload }),
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new Error(`can't reach Apps Script (${e.cause?.code || e.message})`);
    }
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Error(`Apps Script answered HTTP ${r.status} with a page instead of JSON. Check the web app is deployed with access "Anyone" and the URL ends in /exec.`);
    }
    if (!data.ok) throw new Error(`Apps Script: ${data.error || `HTTP ${r.status}`}`);
    return data;
  }

  return {
    target: url,
    describe: () => 'Apps Script web app',
    setup: (headers) => call('setup', { headers }),
    upsert: (rows) => call('upsert', { rows }),
    readAll: () => call('read'),
  };
}

module.exports = { create };
