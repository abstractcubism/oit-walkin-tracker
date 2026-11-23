// The Sheet's columns, shared by the sync worker and scripts/sheets-check.js.
// [database column, Sheet header]. Column A is the walk-in ID, used to find a walk-in's row.
// Add new columns at the END so existing Sheets keep lining up.
const COLUMNS = [
  ['id', 'ID'],
  ['created_at', 'Checked in'],
  ['location', 'Location'],
  ['campus', 'Campus'],
  ['netid', 'NetID'],
  ['name', 'Name'],
  ['email', 'Email'],
  ['issue_type', 'Issue'],
  ['description', 'Description'],
  ['status', 'Status'],
  ['claimed_by', 'Claimed by'],
  ['claimed_at', 'Claimed at'],
  ['ticket', 'Ticket'],
  ['notes', 'Notes'],
  ['closed_at', 'Closed at'],
  ['closed_by', 'Closed by'],
  ['purged_at', 'Details erased at'],
  ['synced_at', 'Last synced'],
  ['close_reason', 'Close reason'], // blank, or self_solved (fixed it with the self-help guide)
  ['consent', 'Permission form'], // blank, signed (on the iPad), phone (DocuSign) or confirmed (by a consultant)
];
const HEADERS = COLUMNS.map(([, h]) => h);

module.exports = { COLUMNS, HEADERS };
