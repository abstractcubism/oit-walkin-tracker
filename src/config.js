// All settings come from environment variables (see .env.example). A .env file in the
// working directory is loaded automatically if present.
const fs = require('fs');
if (fs.existsSync('.env')) process.loadEnvFile('.env');

const list = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const config = {
  port: Number(process.env.PORT || 3000),
  // Public URL of the app, used for links in Slack posts. No trailing slash.
  baseUrl: (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dbPath: process.env.DB_PATH || './data/walkins.db',

  // ---- Sign-in. Each provider turns on when its client ID is set; you can run either or both. ----
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    // Students share this domain, so Google users must ALSO be on the consultant list (Admin page).
    domains: list(process.env.GOOGLE_ALLOWED_DOMAINS || 'scarletmail.rutgers.edu'),
  },
  microsoft: {
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    tenantId: process.env.MS_TENANT_ID || '',
    domains: list(process.env.MS_ALLOWED_DOMAINS || 'oit.rutgers.edu'),
    // Only OIT staff have these accounts, so by default anyone with one may sign in as a
    // consultant without being added first. Set to false to require the consultant list.
    autoAllow: process.env.MS_AUTO_ALLOW !== 'false',
  },
  // These emails are always admins. Everyone else is a consultant (added on the Admin page,
  // or automatically for Microsoft @oit accounts).
  adminEmails: list(process.env.ADMIN_EMAILS),

  // Local testing only: sign in by typing an email, no Google. NEVER enable in production.
  devLogin: process.env.DEV_LOGIN === 'true',
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  sessionHours: Number(process.env.SESSION_HOURS || 12),

  // Personal details (NetID, name, email, description) are erased after this many days.
  retentionDays: Number(process.env.RETENTION_DAYS || 90),
  // Require a ServiceNow ticket number before a walk-in can be marked resolved.
  requireTicket: process.env.REQUIRE_TICKET !== 'false',

  // ServiceNow address used to turn ticket numbers into links (Rutgers' IT Help portal runs on ServiceNow).
  servicenowUrl: (process.env.SERVICENOW_URL || 'https://ithelp.rutgers.edu').replace(/\/$/, ''),

  // Slack, two ways (see README):
  //  - Bot (Claim button): set SLACK_BOT_TOKEN, SLACK_APP_TOKEN and SLACK_CHANNEL. Uses Socket Mode,
  //    so the server connects out to Slack and needs no public URL.
  //  - Post only: set SLACK_WEBHOOK_URL.
  // Leave all empty to turn Slack off. If both are set, the bot is used.
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  slackAppToken: process.env.SLACK_APP_TOKEN || '',
  slackChannel: process.env.SLACK_CHANNEL || '',
  // Only changed by the tests.
  slackApiUrl: (process.env.SLACK_API_URL || 'https://slack.com/api').replace(/\/$/, ''),
};

// Every domain either provider accepts (used when an admin adds someone to the consultant list).
config.allowedDomains = [...new Set([...config.google.domains, ...config.microsoft.domains])];

if (config.devLogin) {
  console.warn('WARNING: DEV_LOGIN is on. Anyone can sign in as any allowed email. Do not use in production.');
}

module.exports = config;
