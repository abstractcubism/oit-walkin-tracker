// Erases personal details from old walk-ins. Counts, times, locations, issue types and ticket
// numbers are kept so reports still work.
const config = require('./config');
const { db, now } = require('./db');

function purge() {
  if (!config.retentionDays || config.retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - config.retentionDays * 24 * 3600e3).toISOString();
  const r = db.prepare(`UPDATE walkins SET netid=NULL, name=NULL, email=NULL, description=NULL, notes=NULL, purged_at=?
                        WHERE created_at < ? AND purged_at IS NULL AND status IN ('resolved','left')`).run(now(), cutoff);
  if (r.changes) console.log(`Retention: erased personal details from ${r.changes} walk-ins older than ${config.retentionDays} days.`);
  return r.changes;
}

function startRetention() {
  purge();
  setInterval(purge, 6 * 3600e3).unref();
}

module.exports = { purge, startRetention };
