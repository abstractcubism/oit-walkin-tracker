// Starts the app for local testing on any OS (Windows, macOS, Linux).
// Turns on test sign-in by email and makes admin@oit.rutgers.edu an admin.
// Anything already set in your shell wins over these defaults.
const { spawn } = require('node:child_process');
const path = require('node:path');

const env = {
  DEV_LOGIN: 'true',
  COOKIE_SECURE: 'false',
  ADMIN_EMAILS: 'admin@oit.rutgers.edu',
  ...process.env,
};

const server = path.join(__dirname, '..', 'src', 'server.js');
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--watch', server], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
