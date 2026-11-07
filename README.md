# DisKids

A real, deployable clubhouse for kids — like Discord, but private, invite-only, and built for classrooms, clubs, and families.

DisKids gives every club its own channels and chat, while grown-ups keep the keys: a Parental PIN unlocks reports, invite codes, member lists, and safety controls. Kids can only join with an invite code, and every club's data is isolated.

## What is included

- **Private clubs** — one club per grown-up account, with its own invite code, members, channels, and chats.
- **Invite-only membership** — kids join with a 6-character code or `?invite=CODE` link.
- **Real accounts** — bcrypt-hashed passwords, server-side sessions, and a PIN-protected grown-up area.
- **Chat** — live messages over Socket.IO, presence, typing indicators, unread badges, announcements, and paused channels.
- **Safety controls** — kindness filter, link/email blocking for kids, slow mode, message reports, and one-click message removal.
- **Moderation** — open report queue, member list, channel pause, and announcement-only channels.
- **Production storage** — PostgreSQL when `DATABASE_URL` is set; JSON files for local development.
- **Docker and Render support** — health checks, graceful shutdown, rate limits, CSP, secure cookies, and proxy-aware HTTPS.

## Deploy it for real (free)

You need two free accounts: **GitHub** (for the code) and **Neon** (for the database). The app itself runs on **Render's free web tier**.

### 1. Create the database (Neon)

1. Sign up at [neon.tech](https://neon.tech) and create a project.
2. Copy the **connection string**. It looks like:
   `postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`
3. Keep it somewhere private. This is your `DATABASE_URL`.

Neon's free plan autosuspends when idle and wakes on the next request. It does not expire like a temporary database.

### 2. Put the code on GitHub

Create a new **empty** repository on GitHub (for example `diskids`), then from this folder:

```powershell
git remote add origin https://github.com/YOUR_USERNAME/diskids.git
git branch -M main
git push -u origin main
```

This folder is already a Git repository with a clean production commit.

### 3. Deploy on Render

1. Sign up at [render.com](https://render.com) with GitHub.
2. Choose **New → Blueprint** and connect the repository.
3. Render reads `render.yaml` and asks for the `DATABASE_URL` value. Paste the Neon connection string.
4. Click **Apply**. Render installs dependencies, builds the front end, and starts the server.
5. When the health check passes, open the `https://diskids-xxxx.onrender.com` URL.

That is your live app. Create the first club, choose a Parental PIN, and share the invite code with your kids.

> Free Render web services sleep after inactivity. The first visit after a nap can take ~30 seconds. Data lives in Neon, so sleeping does not lose anything.

### Custom domain

Add the domain in Render, then add an environment variable:

```
APP_ORIGIN=https://your-domain.com
```

This tightens cookies, CSP, and the request-origin check. Redeploy after changing it.

## Run it locally

```powershell
npm install
npm run dev
```

- App: http://localhost:5173
- API: http://localhost:3001

The Vite dev server proxies `/api` and `/socket.io` to Express.

Production-style local run:

```powershell
npm run build
npm start
```

Then open http://localhost:3001. Local data is stored in `data/db.json`.

To use PostgreSQL locally, set `DATABASE_URL` and `NODE_ENV=production` plus a `SESSION_SECRET` of at least 32 characters.

## Tests

```powershell
npm test
```

The suite starts a real server against a temporary data directory and covers:

- first-run setup and login
- invite-only registration
- parental PIN gating
- kindness filter and link blocking
- reporting, duplicate reports, and grown-up removal
- cross-club isolation (channels, messages, settings, moderation)
- database persistence across a restart

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Production | PostgreSQL connection string. Without it, DisKids uses `data/db.json`. |
| `SESSION_SECRET` | Production | Random string of 32+ characters. Render generates one. |
| `NODE_ENV` | Production | Set to `production` for secure cookies and CSP. |
| `PORT` | No | Server port. Default `3001`. |
| `DATA_DIR` | No | Local JSON storage directory. Default `./data`. |
| `APP_ORIGIN` | Recommended | Public origin(s), comma-separated. Also inferred from `RENDER_EXTERNAL_URL`. |

## How the data is scoped

Every account belongs to exactly one club. Every channel, message, report, and session operation is filtered by `clubId` on the server, not just hidden in the UI.

```
users      -> clubId
clubs      -> inviteCode, parentalPinHash, safety settings
channels   -> clubId
messages   -> clubId + channelId
reports    -> clubId + messageId
```

The grown-up dashboard's reports, settings, and invite code are read through `clubId`, so one club cannot moderate or read another.

> Current model: one club per grown-up account. Multiple clubs per grown-up (a staff account that owns several classes) is the next data-model step.

## Storage model

- **Local development:** atomic JSON file (`data/db.json`).
- **Production:** one JSON document in PostgreSQL (`diskids_state`), written after every change, plus PostgreSQL-backed sessions (`diskids_sessions`).

This keeps the prototype's simple logic while giving you durable, backed-up cloud storage without a rewrite. It is a good fit for a classroom or a small group of clubs on one instance.

For large scale, the next step is normalizing messages/users/channels into relational tables, adding pagination instead of the current 200-message window, and moving presence/typing to a shared adapter if you run more than one instance.

## Safety and privacy notes

- No email addresses, phone numbers, ads, or third-party trackers are collected.
- Kids cannot join without a current invite code.
- Reports are only visible to an unlocked grown-up in the same club.
- Grown-ups choose the display names and usernames kids use. Use nicknames, not full legal names.
- The kindness filter is a blunt first layer, not a replacement for supervision. It intentionally hides a small built-in word list and rewrites flagged messages with dots.
- Links and emails are blocked for kids by default. A grown-up can turn that off per club.
- If a child is in danger, follow your school or organization's safeguarding process. DisKids is not an emergency service.

## Operational checklist

- Keep `SESSION_SECRET` and `DATABASE_URL` private.
- Enable Neon backups/point-in-time restore on paid plans if the club matters.
- Update dependencies with `npm audit` and `npm update`.
- For a school-wide rollout, add a privacy notice and get guardian consent as required in your region.
- The free Render instance is a single process. Do not scale to multiple instances until presence/typing and storage writes use shared infrastructure.

## Project layout

```
diskids/
├── server.js            Express API, auth, safety rules, Socket.IO
├── storage.js           JSON + PostgreSQL persistence, schema migration
├── dev.js               Runs server + Vite together
├── render.yaml          Render Blueprint
├── Dockerfile           Portable container build
├── src/                 React front end
│   ├── screens/         Setup, auth, chat
│   ├── components/      Dialogs, avatars, toasts, branding
│   └── lib/             API, socket, formatting
└── test/api.test.js     End-to-end API and isolation tests
```

## License

Private prototype for your club. Add a license before distributing publicly.
