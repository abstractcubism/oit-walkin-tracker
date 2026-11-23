// Erases personal details from old walk-ins. Counts, times, locations, issue types and ticket
// numbers are kept so reports still work.
const config = require('./config');
const { db, now } = require('./db');

function purge() {
  if (!config.retentionDays || config.retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - config.retentionDays * 24 * 3600e3).toISOString();
  const stamp = now();
  const r = db.prepare(`UPDATE walkins SET netid=NULL, name=NULL, email=NULL, description=NULL, notes=NULL, consent_name=NULL, consent_sig=NULL, purged_at=?
                        WHERE created_at < ? AND purged_at IS NULL AND status IN ('resolved','left')`).run(stamp, cutoff);
  // Bot mode: blank the NetID / name / email out of the Slack posts too.
  if (r.changes) db.prepare('UPDATE walkins SET slack_sync = 1 WHERE purged_at IS NOT NULL AND slack_ts IS NOT NULL AND slack_sync = 0 AND purged_at = ?').run(stamp);
  if (r.changes) console.log(`Retention: erased personal details from ${r.changes} walk-ins older than ${config.retentionDays} days.`);
  return r.changes;
}

function startRetention() {
  purge();
  require('./slack').kick();
  setInterval(purge, 6 * 3600e3).unref();
}

module.exports = { purge, startRetention };
