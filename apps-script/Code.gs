/**
 * OIT walk-in tracker: Sheet connection (Apps Script web app).
 *
 * Setup, done once by the person who owns the Sheet:
 *  1. Open the Sheet, then Extensions > Apps Script. Replace Code.gs with this file and save.
 *  2. Project Settings (gear) > Script properties > Add: SECRET = a long random value.
 *     Put the same value in the app's SHEETS_APPS_SCRIPT_SECRET.
 *  3. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 *     ("Anyone" lets the server reach it without a Google sign-in; the SECRET is what protects it.)
 *  4. Copy the web app URL (ends in /exec) into SHEETS_APPS_SCRIPT_URL.
 *  After editing this script, use Deploy > Manage deployments > Edit > New version, or the URL keeps
 *  running the old code.
 *
 * The app sends: { secret, action: 'setup' | 'upsert' | 'read', tab, headers?, rows? }.
 * Column A of the tab is the walk-in ID; rows are matched on it.
 */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || req.secret !== secret) throw new Error('Wrong or missing secret.');
    if (!ACTIONS.hasOwnProperty(req.action)) throw new Error('Unknown action: ' + req.action);
    var lock = LockService.getScriptLock();
    lock.waitLock(20000); // one write at a time, so rows can't collide
    try { out = ACTIONS[req.action](req); } finally { lock.releaseLock(); }
    out.ok = true;
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function tabFor_(req, create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(req.tab);
  if (!sh && create) sh = ss.insertSheet(req.tab);
  if (!sh) throw new Error('No tab named "' + req.tab + '". The app creates it on start-up.');
  return sh;
}

// Writes values as plain text, so NetIDs and ticket numbers keep their exact form.
function write_(sh, row, values) {
  var need = row + values.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need);
  sh.getRange(row, 1, values.length, values[0].length).setNumberFormat('@').setValues(values);
}

var ACTIONS = {
  setup: function (req) {
    var sh = tabFor_(req, true);
    write_(sh, 1, [req.headers]);
    sh.getRange(1, 1, 1, req.headers.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    // People can view, sort a copy and filter, but only the script's owner can edit.
    var p = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET)[0] || sh.protect();
    p.setDescription('Written by the OIT walk-in tracker. Edits here would be overwritten.');
    var me = Session.getEffectiveUser();
    p.addEditor(me);
    var others = p.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); });
    if (others.length) p.removeEditors(others);
    if (p.canDomainEdit()) p.setDomainEdit(false);
    return { tab: sh.getName(), owner: me.getEmail() };
  },

  upsert: function (req) {
    var sh = tabFor_(req, false);
    var last = sh.getLastRow();
    var ids = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues() : [];
    var at = {};
    ids.forEach(function (r, i) { if (r[0] !== '') at[String(r[0])] = i + 2; });
    var adds = [];
    var updated = 0;
    req.rows.forEach(function (row) {
      var n = at[String(row[0])];
      if (n) { write_(sh, n, [row]); updated++; } else adds.push(row);
    });
    if (adds.length) write_(sh, Math.max(last, 1) + 1, adds);
    return { updated: updated, added: adds.length };
  },

  read: function (req) {
    var v = tabFor_(req, false).getDataRange().getDisplayValues();
    return { headers: v[0] || [], rows: v.slice(1) };
  }
};
