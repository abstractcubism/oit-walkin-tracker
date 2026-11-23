// Tests the Google Sheet connection without starting the app:  npm run sheets:check
// Uses the SHEETS_* settings from .env. Creates the tab and header row if needed (that's all it
// writes), then reads the tab back and prints how many walk-in rows it holds.
const config = require('../src/config');

const s = config.sheets;
const modes = { 'apps-script': '../src/sheets/apps-script', 'service-account': '../src/sheets/service-account' };

(async () => {
  if (!modes[s.mode]) {
    console.log(`SHEETS_MODE is "${s.mode}". Set it to apps-script or service-account in .env first.`);
    process.exit(1);
  }
  const t = require(modes[s.mode]).create(s);
  console.log(`Connecting with ${t.describe()} to tab "${s.tab}"...`);
  // Header list comes from the sync module's column map, without opening the database.
  const headers = require('../src/sheets/columns').HEADERS;
  await t.setup(headers);
  console.log('Header row and protection are in place.');
  const { headers: got, rows } = await t.readAll();
  const same = headers.every((h, i) => got[i] === h);
  console.log(`The tab has ${rows.length} walk-in rows. Header row ${same ? 'matches' : `does NOT match: ${JSON.stringify(got)}`}.`);
  console.log(s.includePersonal ? 'NetIDs and names will be copied (SHEETS_INCLUDE_PERSONAL is on).' : 'NetIDs and names will be left out (SHEETS_INCLUDE_PERSONAL=false).');
})().catch((e) => {
  console.error(`Failed: ${e.message}`);
  process.exit(1);
});
