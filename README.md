# OIT Walk-in Tracker

Check-in and queue for walk-ins at Rutgers OIT help desk and lab locations.

1. **At opening**, a consultant signs in on the location's iPad, picks the location, and the iPad becomes a check-in form. The consultant is signed out on the iPad right away. The iPad keeps a token that can only submit walk-ins.
2. **A walk-in** enters their NetID (or name and email if they don't have one), taps a common issue such as Duo / 2FA, and optionally describes it.
3. **Consultants** see the live queue on their computers, **claim** a walk-in (two people can't both claim the same one), add the **ServiceNow ticket number**, and mark it resolved or left.
4. **Slack** (optional, last): each walk-in is posted to a channel with the NetID, the issue and a direct link to that walk-in. With the Slack bot turned on, the post also has a **Claim** button that opens a small box for the ticket number, and the post updates to show who claimed it and the ticket.

There's also a **Reports** page (volume by location, issue, hour and day, average wait, CSV export) and an **Admin** page (consultant list, locations, issue buttons, linked iPads).

## Stack

Node.js 22.13+ and Express, with SQLite through Node's built-in `node:sqlite` (one file, no database server). The pages are plain HTML and JS, so there's no build step. The only dependencies are `express` and `google-auth-library`. Icons are [Lucide](https://lucide.dev) (ISC license), inlined in `public/icons.js`. The IBM Plex font loads from Google Fonts, and the pages fall back to system fonts if it can't be reached.

## Run it locally

```bash
npm install
npm run dev        # then open http://localhost:3000 (works in PowerShell, macOS and Linux)
npm test
```

## Settings

Copy `.env.example` to `.env` and fill it in. Every setting is explained there. The main ones:

| Setting | What it's for |
|---|---|
| `BASE_URL` | Public address of the app, used for links in Slack |
| `ADMIN_EMAILS` | People who are always admins |
| `GOOGLE_CLIENT_ID` | Turns on Google sign-in (@scarletmail). Users must also be on the consultant list, since students share the domain. |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID` | Turns on Microsoft sign-in (@oit.rutgers.edu). Staff-only accounts, so they're let in automatically unless `MS_AUTO_ALLOW=false`. |
| `RETENTION_DAYS` | NetID, name, email and description are erased from closed walk-ins after this many days (default 90). Counts and ticket numbers are kept. |
| `REQUIRE_TICKET` | A ticket number is required before resolving (default true) |
| `SERVICENOW_URL` | ServiceNow address used to turn ticket numbers into links (default `https://ithelp.rutgers.edu`) |
| `SLACK_WEBHOOK_URL` | Turns on Slack posting (post only) |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL` | Turns on the Slack bot with the Claim button instead (see below) |

You can turn on Google, Microsoft or both. Each one appears on the sign-in page once its keys are set.

## What to request for approval

All three requests are small, and each is independent of the others.

**Google OAuth client** (if using Google). In Google Cloud Console, create an OAuth client ID of type *Web application*.
- Authorized JavaScript origin: your `BASE_URL`
- Scopes: only the basic sign-in profile (`openid email profile`), with no access to Drive, Gmail or anything else
- The app only receives the person's name and email

**Microsoft Entra app registration** (if using Microsoft). Register an app in the Rutgers tenant.
- Single tenant, Web platform, redirect URI `BASE_URL/auth/microsoft/callback`
- API permissions: only `openid`, `profile` and `email` (the Microsoft Graph sign-in basics)
- No admin consent is needed for those
- Create one client secret

**Slack**, pick one:

*Option A: incoming webhook (post only, the smallest ask)*
- A Slack app with a single feature, *Incoming Webhooks*, added to one channel
- It can only post to that channel. It can't read messages, list users or do anything else.

*Option B: bot with the Claim button*
- A Slack app with **Socket Mode** and **Interactivity** turned on. Socket Mode means the OIT server connects out to Slack, so no public URL or firewall opening is needed, and no request URL is set.
- Bot token scopes: `chat:write` (post and update its own walk-in posts, and send the private "already claimed" note), `users:read` and `users:read.email` (look up the email of the person who pressed Claim, to match them to the consultant list)
- One app-level token with `connections:write` (for Socket Mode)
- Invite the bot to the walk-ins channel and put the channel's ID in `SLACK_CHANNEL`
- No event subscriptions and no `channels:history`: the bot never reads messages in the channel
- When the retention period erases a walk-in's personal details here, the bot also edits the Slack post to remove them

People are matched to Slack by email (or by NetID across @rutgers.edu and @scarletmail.rutgers.edu) the first time they press Claim. Anyone who doesn't match can be linked by Slack member ID on the Admin page.

App manifest for Option B (paste into *Create New App, From a manifest*):

```yaml
display_information:
  name: OIT Walk-ins
features:
  bot_user:
    display_name: OIT Walk-ins
oauth_config:
  scopes:
    bot: [chat:write, users:read, users:read.email]
settings:
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

## Deploy on the OIT server

1. Install Node.js 22.13 or newer.
2. Copy the repo to e.g. `/opt/walkin-tracker`, run `npm ci --omit=dev`, and create `.env` (with `DEV_LOGIN=false`).
3. Run it as a service:

   ```ini
   # /etc/systemd/system/walkin-tracker.service
   [Unit]
   Description=OIT Walk-in Tracker
   After=network.target

   [Service]
   WorkingDirectory=/opt/walkin-tracker
   ExecStart=/usr/bin/npm start
   User=walkins
   Restart=always

   [Install]
   WantedBy=multi-user.target
   ```

4. Put it behind the server's existing web server with HTTPS, proxying to `127.0.0.1:3000`. For nginx:

   ```nginx
   location / {
     proxy_pass http://127.0.0.1:3000;
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto https;
   }
   ```

5. **Backups:** everything lives in `data/walkins.db`. Back it up with `sqlite3 data/walkins.db ".backup backup.db"` (safe while the app is running).

## Setting up an iPad

1. Open `BASE_URL/setup` in Safari and sign in.
2. Tap the location. The iPad switches to the check-in form and signs you out.
3. Turn on **Guided Access** (Settings › Accessibility › Guided Access) and start it on the form, so walk-ins can't leave the page.
4. To get back to the staff screen, **press and hold "Rutgers OIT" in the top-left corner for 3 seconds**. That opens the consultant sign-in, which has a "Back to check-in" button and goes back to the form on its own after a minute. Nothing changes on the iPad until a consultant signs in. You can also unlink an iPad from the Admin page.

The form clears itself 6 seconds after each check-in, and any half-filled form is cleared after 90 seconds of no activity.

If you use *Add to Home Screen*, set the iPad up from the home-screen app itself, because it keeps separate cookies from Safari.
