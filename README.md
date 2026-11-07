# DisKids 🌈

A safe, Discord-style clubhouse for kids, classrooms, and after-school clubs. Built as a working local prototype.

Grown-ups create the club once, share a private invite code, and keep an eye on things with a Parental PIN. Kids get cozy channels, realtime chat, and reporting tools — without strangers or the open internet.

## Run it

```powershell
cd diskids
node dev.js
```

Vite opens `http://localhost:5173`. The API and Socket.IO server run on `http://localhost:3001`.

Other commands:

```powershell
node server.js        # serve the built app + API on :3001
node node_modules/vite/bin/vite.js build   # rebuild dist/
```

On Windows, if `npm run ...` is blocked by PowerShell execution policy, use the `node ...` commands above (or `npm.cmd run ...`).

## First run

1. Open the app. You will get the **grown-up setup** screen.
2. Pick a club name, your grown-up account, a password, and a 4–6 digit **Parental PIN**.
3. The next screen shows the club's **invite code**. Share it with your kids.
4. Kids choose **Join with code**, pick a display name and avatar, and start chatting.
5. Tap the shield / **Grown-up tools** and enter the PIN to see reports, change safety settings, and copy the invite link.

The invite code and data live in `diskids/data/db.json`. To start completely fresh, stop the server and delete `data/db.json`.

## What's included

- **Realtime chat** over Socket.IO, persisted to a local JSON store.
- **Clubs and channels** — grown-ups can create clubs and text or announcement channels.
- **Presence and typing indicators** — see who's online and who's typing.
- **Invite-only joining** with a 6-character club code and shareable invite link (`?invite=CODE`).
- **Parental PIN** separate from the grown-up login; unlocks moderation and settings.
- **Kindness filter** that masks a small built-in list of unkind words.
- **Link and email blocking** for kids (grown-ups can always share links).
- **Slow mode** (off, 2s, 5s, 10s, 30s) to keep chat calm.
- **Reporting** with reasons; grown-ups see open reports and can remove messages.
- **Message removal** — grown-ups can remove any message; kids can remove their own.
- **Channel pausing** and read-only announcement channels.
- **Unread badges**, day dividers, and a friendly mobile layout.

## Safety model (prototype)

This is a supervised-club tool, not a public social network:

- Every kid needs the invite code.
- Kids cannot post links or email addresses unless a grown-up allows it.
- A small word list is filtered and the message is flagged in the UI.
- Grown-ups can pause channels, remove messages, and review reports.
- No direct messages, file uploads, voice/video, or external embeds.

**Not production-ready yet:** JSON-file storage and in-memory sessions are designed for a single local server. There is no password reset, email verification, account deletion, audit log, rate limiting per IP, or scalable moderation queue. Add those before exposing this to the public internet.

## Project layout

```
diskids/
  server.js              Express + Socket.IO + JSON persistence
  dev.js                 Starts the API and Vite together
  src/
    App.jsx              Boot, setup/auth switch
    screens/             Setup, auth, and chat screens
    components/          Avatars, modals, dialogs, toasts
    lib/                 API client, socket client, formatting
    styles.css           Design system and responsive layout
  data/                  db.json + session secret (generated)
  dist/                  production build
```

## Good next steps

- Move persistence to SQLite or Postgres and sessions to a shared store.
- Add grown-up approval for new members instead of a shared code.
- Add per-club roles, member removal, and a full audit/moderation log.
- Let grown-ups customize the blocked-word list and add phrase rules.
- Add password reset and account deletion with grown-up consent.
- Add automated tests for the API and safety rules.
