import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SECRET_PATH = path.join(DATA_DIR, 'session-secret');
const PORT = Number(process.env.PORT) || 3001;

fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_SAFETY = {
  profanityFilter: true,
  allowLinks: false,
  slowModeSeconds: 2,
};

function emptyDb() {
  return {
    users: [],
    clubs: [],
    channels: [],
    messages: [],
    reports: [],
    settings: {
      setupComplete: false,
      clubName: '',
      inviteCode: '',
      parentalPinHash: '',
      safety: { ...DEFAULT_SAFETY },
    },
  };
}

function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    const base = emptyDb();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}), safety: { ...DEFAULT_SAFETY, ...(parsed.settings?.safety || {}) } },
    };
  } catch {
    return emptyDb();
  }
}

const db = loadDb();

function saveDb() {
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

let sessionSecret;
if (fs.existsSync(SECRET_PATH)) {
  sessionSecret = fs.readFileSync(SECRET_PATH, 'utf8').trim();
} else {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, sessionSecret);
}

const sessionMiddleware = session({
  name: 'diskids.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(sessionMiddleware);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const PIN_RE = /^\d{4,6}$/;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROWNUP_ROLES = new Set(['grownup']);
const AVATARS = ['🦊', '🐼', '🐸', '🦄', '🐙', '🐨', '🦖', '🐝', '🐳', '🦉', '🐱', '🐶', '🍀', '🌈', '🚀', '⭐', '🎨', '⚽'];

const BANNED_WORDS = [
  'damn', 'hell', 'crap', 'stupid', 'idiot', 'dumb', 'loser', 'shut up', 'hate you',
  'kill', 'gun', 'knife', 'drugs', 'porn', 'sex', 'naked', 'blood', 'ugly', 'fat',
];
const FILTER_RE = new RegExp(`\\b(?:${BANNED_WORDS.map(escapeRegExp).join('|')})\\b`, 'gi');
const LINK_RE = /\b(?:https?:\/\/|www\.)\S+/i;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;

function cleanText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function cleanMessage(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 500);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function publicMessage(message) {
  const author = db.users.find((user) => user.id === message.userId);
  return {
    ...message,
    user: publicUser(author) || {
      id: 'guide',
      username: 'club-guide',
      displayName: 'Club Guide',
      avatar: '🌙',
      role: 'system',
    },
  };
}

function currentUser(req) {
  if (!req.session?.userId) return null;
  return db.users.find((user) => user.id === req.session.userId) || null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in first.' });
  req.user = user;
  next();
}

function requireGrownup(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in first.' });
  if (user.role !== 'grownup') {
    return res.status(403).json({ error: 'Only grown-ups can do that.' });
  }
  if (!req.session.grownupUnlocked) {
    return res.status(403).json({ error: 'Enter the Parental PIN first.', code: 'PIN_REQUIRED' });
  }
  req.user = user;
  next();
}

function makeInviteCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)]).join('');
  } while (db.settings.inviteCode === code);
  return code;
}

function normalizeChannelName(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function filterWords(text) {
  if (!db.settings.safety.profanityFilter) return { text, changed: false };
  let changed = false;
  const filtered = text.replace(FILTER_RE, (match) => {
    changed = true;
    return '•'.repeat(Math.min(match.length, 8));
  });
  return { text: filtered, changed };
}

function containsLinkOrEmail(text) {
  return LINK_RE.test(text) || EMAIL_RE.test(text);
}

async function establishSession(req, userId) {
  await new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
  req.session.userId = userId;
  await new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function buildState(req) {
  const user = currentUser(req);
  const base = {
    setupComplete: db.settings.setupComplete,
    clubName: db.settings.clubName || 'Our Club',
    safety: db.settings.safety,
    online: [...presence.keys()],
  };

  if (!user) return { ...base, user: null };

  const unlocked = user.role === 'grownup' && Boolean(req.session.grownupUnlocked);
  return {
    ...base,
    user: publicUser(user),
    unlocked,
    inviteCode: unlocked ? db.settings.inviteCode : null,
    clubs: [...db.clubs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    channels: [...db.channels].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    members: db.users
      .filter((member) => member.role !== 'system')
      .map(publicUser)
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

function seedClub(club) {
  const channelDefs = [
    { name: 'welcome', topic: 'Start here! Say hello and read the club promises.', emoji: '🌟' },
    { name: 'general', topic: 'Chat about anything kind and fun.', emoji: '💬' },
    { name: 'homework-help', topic: 'Stuck? Ask a question and help each other.', emoji: '📚' },
    { name: 'art-and-stories', topic: 'Share drawings, stories, and silly ideas.', emoji: '🎨' },
  ];

  const created = channelDefs.map((definition, index) => ({
    id: uid(),
    clubId: club.id,
    name: definition.name,
    topic: definition.topic,
    emoji: definition.emoji,
    kind: 'text',
    locked: false,
    position: index,
    createdAt: now(),
  }));
  db.channels.push(...created);

  const welcome = created[0];
  if (welcome) {
    db.messages.push(
      {
        id: uid(),
        channelId: welcome.id,
        userId: 'guide',
        body: `Welcome to ${club.name}! 🌟 This is our clubhouse. Be kind, include everyone, and have fun.`,
        createdAt: now(),
        filtered: false,
        deleted: false,
      },
      {
        id: uid(),
        channelId: welcome.id,
        userId: 'guide',
        body: 'Grown-ups: tap the shield to enter your Parental PIN. There you can share the invite code, read reports, and change safety settings.',
        createdAt: now(),
        filtered: false,
        deleted: false,
      },
    );
  }
  const general = created[1];
  if (general) {
    db.messages.push({
      id: uid(),
      channelId: general.id,
      userId: 'guide',
      body: 'Say hi! 👋 Tell us one fun thing about your day.',
      createdAt: now(),
      filtered: false,
      deleted: false,
    });
  }
  return created;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

app.post('/api/setup', async (req, res) => {
  try {
    if (db.settings.setupComplete) {
      return res.status(409).json({ error: 'This clubhouse is already set up. Please log in.' });
    }

    const clubName = cleanText(req.body?.clubName, 32);
    const displayName = cleanText(req.body?.displayName, 24);
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const pin = String(req.body?.pin ?? '');
    const avatar = AVATARS.includes(req.body?.avatar) ? req.body.avatar : '🦊';

    if (clubName.length < 2) return res.status(400).json({ error: 'Give your club a name (at least 2 letters).' });
    if (displayName.length < 2) return res.status(400).json({ error: 'Tell us your name (at least 2 letters).' });
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–20 letters, numbers, or underscores.' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters.' });
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'Parental PIN must be 4–6 digits.' });

    const club = {
      id: uid(),
      name: clubName,
      emoji: '🌈',
      description: 'Our shared clubhouse',
      ownerId: null,
      createdAt: now(),
    };

    const user = {
      id: uid(),
      username,
      usernameLower: username.toLowerCase(),
      displayName,
      avatar,
      role: 'grownup',
      passwordHash: await bcrypt.hash(password, 10),
      createdAt: now(),
    };
    club.ownerId = user.id;

    const guide = {
      id: 'guide',
      username: 'club-guide',
      usernameLower: 'club-guide',
      displayName: 'Club Guide',
      avatar: '🌙',
      role: 'system',
      passwordHash: null,
      createdAt: now(),
    };

    db.users.push(user, guide);
    db.clubs.push(club);
    db.settings = {
      setupComplete: true,
      clubName,
      inviteCode: makeInviteCode(),
      parentalPinHash: await bcrypt.hash(pin, 10),
      safety: { ...DEFAULT_SAFETY },
    };

    seedClub(club);
    saveDb();
    await establishSession(req, user.id);

    res.status(201).json({ ok: true, inviteCode: db.settings.inviteCode });
  } catch (error) {
    console.error('setup failed', error);
    res.status(500).json({ error: 'Something went wrong while setting up the club.' });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    if (!db.settings.setupComplete) {
      return res.status(409).json({ error: 'A grown-up needs to set up the club first.' });
    }

    const inviteCode = String(req.body?.inviteCode ?? '').trim().toUpperCase();
    if (inviteCode !== db.settings.inviteCode) {
      return res.status(403).json({ error: 'That invite code does not match. Ask a grown-up for the code.' });
    }

    const displayName = cleanText(req.body?.displayName, 24);
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    const avatar = AVATARS.includes(req.body?.avatar) ? req.body.avatar : '🐼';

    if (displayName.length < 2) return res.status(400).json({ error: 'Pick a display name (at least 2 letters).' });
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–20 letters, numbers, or underscores.' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters.' });
    if (db.users.some((user) => user.usernameLower === username.toLowerCase())) {
      return res.status(409).json({ error: 'That username is already taken. Try another one.' });
    }

    const user = {
      id: uid(),
      username,
      usernameLower: username.toLowerCase(),
      displayName,
      avatar,
      role: 'kid',
      passwordHash: await bcrypt.hash(password, 10),
      createdAt: now(),
    };
    db.users.push(user);
    saveDb();
    await establishSession(req, user.id);

    io.emit('state:refresh');
    io.emit('presence', [...presence.keys()]);
    res.status(201).json({ ok: true });
  } catch (error) {
    console.error('register failed', error);
    res.status(500).json({ error: 'Something went wrong while joining the club.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const user = db.users.find((candidate) => candidate.usernameLower === username && candidate.role !== 'system');
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Username or password is not right. Try again!' });
    }
    await establishSession(req, user.id);
    res.json({ ok: true });
  } catch (error) {
    console.error('login failed', error);
    res.status(500).json({ error: 'Something went wrong while logging in.' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/state', (req, res) => {
  res.json(buildState(req));
});

app.post('/api/unlock', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'grownup') {
      return res.status(403).json({ error: 'Only grown-up accounts can open the safety tools.' });
    }
    const pin = String(req.body?.pin ?? '');
    const matches = await bcrypt.compare(pin, db.settings.parentalPinHash);
    if (!matches) return res.status(401).json({ error: 'That PIN does not match. Try again.' });

    req.session.grownupUnlocked = true;
    await new Promise((resolve, reject) => {
      req.session.save((error) => (error ? reject(error) : resolve()));
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('unlock failed', error);
    res.status(500).json({ error: 'Could not check the PIN right now.' });
  }
});

app.post('/api/lock', requireAuth, (req, res) => {
  req.session.grownupUnlocked = false;
  req.session.save(() => res.json({ ok: true }));
});

/* ------------------------------------------------------------------ */
/* Clubs + channels                                                    */
/* ------------------------------------------------------------------ */

app.post('/api/clubs', requireGrownup, (req, res) => {
  const name = cleanText(req.body?.name, 32);
  const description = cleanText(req.body?.description, 80);
  const emoji = AVATARS.includes(req.body?.emoji) ? req.body.emoji : '🏡';
  if (name.length < 2) return res.status(400).json({ error: 'Give the club a name (at least 2 letters).' });

  const club = {
    id: uid(),
    name,
    emoji,
    description: description || 'A place for our group to chat',
    ownerId: req.user.id,
    createdAt: now(),
  };
  db.clubs.push(club);
  db.channels.push({
    id: uid(),
    clubId: club.id,
    name: 'general',
    topic: 'Say hello and start chatting!',
    emoji: '💬',
    kind: 'text',
    locked: false,
    position: 0,
    createdAt: now(),
  });
  saveDb();
  io.emit('state:refresh');
  res.status(201).json({ club });
});

app.post('/api/channels', requireGrownup, (req, res) => {
  const club = db.clubs.find((item) => item.id === req.body?.clubId);
  if (!club) return res.status(404).json({ error: 'That club could not be found.' });

  const name = normalizeChannelName(req.body?.name);
  const topic = cleanText(req.body?.topic, 80);
  const kind = req.body?.kind === 'announcement' ? 'announcement' : 'text';

  if (name.length < 2) {
    return res.status(400).json({ error: 'Channel names need at least 2 letters (letters and numbers work best).' });
  }
  if (db.channels.some((channel) => channel.clubId === club.id && channel.name === name)) {
    return res.status(409).json({ error: 'That channel already exists in this club.' });
  }

  const position = db.channels.filter((channel) => channel.clubId === club.id).length;
  const channel = {
    id: uid(),
    clubId: club.id,
    name,
    topic: topic || 'A new place to chat',
    emoji: kind === 'announcement' ? '📣' : '💬',
    kind,
    locked: false,
    position,
    createdAt: now(),
  };
  db.channels.push(channel);
  saveDb();
  io.emit('state:refresh');
  res.status(201).json({ channel });
});

app.patch('/api/channels/:id', requireGrownup, (req, res) => {
  const channel = db.channels.find((item) => item.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'That channel could not be found.' });

  if (typeof req.body?.locked === 'boolean') channel.locked = req.body.locked;
  if (typeof req.body?.topic === 'string') channel.topic = cleanText(req.body.topic, 80);
  saveDb();
  io.emit('state:refresh');
  res.json({ channel });
});

/* ------------------------------------------------------------------ */
/* Messages + reports                                                  */
/* ------------------------------------------------------------------ */

const lastSentAt = new Map();

app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  const channel = db.channels.find((item) => item.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'That channel could not be found.' });
  const messages = db.messages
    .filter((message) => message.channelId === channel.id)
    .slice(-200)
    .map(publicMessage);
  res.json({ messages, channel });
});

app.post('/api/channels/:id/messages', requireAuth, (req, res) => {
  const channel = db.channels.find((item) => item.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'That channel could not be found.' });
  if (channel.locked && req.user.role !== 'grownup') {
    return res.status(403).json({ error: 'This channel is paused by a grown-up right now.' });
  }
  if (channel.kind === 'announcement' && req.user.role !== 'grownup') {
    return res.status(403).json({ error: 'Only grown-ups can post in announcement channels.' });
  }

  let body = cleanMessage(req.body?.body);
  if (!body) return res.status(400).json({ error: 'Type a message first.' });
  if (body.length > 500) return res.status(400).json({ error: 'Messages can be up to 500 characters.' });

  if (req.user.role === 'kid') {
    if (!db.settings.safety.allowLinks && containsLinkOrEmail(body)) {
      return res.status(400).json({ error: 'Links and email addresses are turned off for kids. Ask a grown-up if you need to share one.' });
    }
    const slowMode = Number(db.settings.safety.slowModeSeconds) || 0;
    if (slowMode > 0) {
      const last = lastSentAt.get(req.user.id) || 0;
      const waitMs = slowMode * 1000 - (Date.now() - last);
      if (waitMs > 0) {
        return res.status(429).json({
          error: `Slow mode is on — take a breath and try again in ${Math.ceil(waitMs / 1000)}s.`,
          retryAfter: Math.ceil(waitMs / 1000),
        });
      }
    }
  }

  const filtered = filterWords(body);
  body = filtered.text;

  const message = {
    id: uid(),
    channelId: channel.id,
    userId: req.user.id,
    body,
    createdAt: now(),
    filtered: filtered.changed,
    deleted: false,
  };
  db.messages.push(message);
  if (db.messages.length > 5000) db.messages.splice(0, db.messages.length - 5000);
  lastSentAt.set(req.user.id, Date.now());
  saveDb();

  const published = publicMessage(message);
  io.emit('message:new', published);
  res.status(201).json(published);
});

app.delete('/api/messages/:id', requireAuth, (req, res) => {
  const message = db.messages.find((item) => item.id === req.params.id);
  if (!message) return res.status(404).json({ error: 'That message could not be found.' });

  const isGrownup = req.user.role === 'grownup' && req.session.grownupUnlocked;
  const isAuthor = message.userId === req.user.id;
  if (!isGrownup && !isAuthor) {
    return res.status(403).json({ error: 'You can only remove your own messages.' });
  }

  message.deleted = true;
  message.body = '';
  message.deletedBy = isGrownup && !isAuthor ? req.user.displayName : null;
  for (const report of db.reports) {
    if (report.messageId === message.id && report.status === 'open') {
      report.status = 'resolved';
      report.resolvedAt = now();
      report.resolvedBy = req.user.displayName;
    }
  }
  saveDb();
  io.emit('message:deleted', {
    id: message.id,
    channelId: message.channelId,
    deletedBy: message.deletedBy || null,
  });
  io.emit('reports:changed');
  res.json({ ok: true });
});

app.post('/api/messages/:id/report', requireAuth, (req, res) => {
  const message = db.messages.find((item) => item.id === req.params.id);
  if (!message || message.deleted) return res.status(404).json({ error: 'That message could not be found.' });
  if (message.userId === req.user.id) {
    return res.status(400).json({ error: 'You do not need to report your own message.' });
  }
  const allowed = new Set(['Mean words', 'Spam', 'Scary or unsafe', 'Something else']);
  const reason = allowed.has(req.body?.reason) ? req.body.reason : 'Something else';

  const existing = db.reports.find(
    (report) => report.messageId === message.id && report.reporterId === req.user.id && report.status === 'open',
  );
  if (existing) return res.status(409).json({ error: 'You already told a grown-up about this message.' });

  db.reports.push({
    id: uid(),
    messageId: message.id,
    reporterId: req.user.id,
    reason,
    status: 'open',
    createdAt: now(),
  });
  saveDb();
  io.emit('reports:changed');
  res.status(201).json({ ok: true });
});

app.get('/api/reports', requireGrownup, (req, res) => {
  const reports = db.reports
    .filter((report) => report.status === 'open')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((report) => {
      const message = db.messages.find((item) => item.id === report.messageId);
      if (!message) return null;
      const channel = db.channels.find((item) => item.id === message.channelId);
      return {
        ...report,
        reporter: publicUser(db.users.find((user) => user.id === report.reporterId)),
        message: {
          ...publicMessage(message),
          channelName: channel?.name || 'unknown',
        },
      };
    })
    .filter(Boolean);
  res.json({ reports });
});

app.post('/api/reports/:id/resolve', requireGrownup, (req, res) => {
  const report = db.reports.find((item) => item.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'That report could not be found.' });
  report.status = 'resolved';
  report.resolvedAt = now();
  report.resolvedBy = req.user.displayName;
  saveDb();
  io.emit('reports:changed');
  res.json({ ok: true });
});

app.patch('/api/settings', requireGrownup, (req, res) => {
  const next = req.body?.safety;
  if (!next || typeof next !== 'object') return res.status(400).json({ error: 'No safety settings were sent.' });

  if (typeof next.profanityFilter === 'boolean') db.settings.safety.profanityFilter = next.profanityFilter;
  if (typeof next.allowLinks === 'boolean') db.settings.safety.allowLinks = next.allowLinks;
  if (next.slowModeSeconds !== undefined) {
    const seconds = Number(next.slowModeSeconds);
    if ([0, 2, 5, 10, 30].includes(seconds)) db.settings.safety.slowModeSeconds = seconds;
  }
  saveDb();
  io.emit('safety:changed', { safety: db.settings.safety });
  res.json({ safety: db.settings.safety });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, setupComplete: db.settings.setupComplete });
});

/* ------------------------------------------------------------------ */
/* Socket.IO: presence + typing                                        */
/* ------------------------------------------------------------------ */

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
});
io.engine.use(sessionMiddleware);

const presence = new Map();

function broadcastPresence() {
  io.emit('presence', [...presence.keys()]);
}

io.on('connection', (socket) => {
  const userId = socket.request.session?.userId;
  const user = userId ? db.users.find((candidate) => candidate.id === userId) : null;
  if (!user) {
    socket.disconnect(true);
    return;
  }

  presence.set(userId, (presence.get(userId) || 0) + 1);
  broadcastPresence();

  socket.on('typing', (payload) => {
    const channelId = typeof payload?.channelId === 'string' ? payload.channelId : null;
    if (!channelId || !db.channels.some((channel) => channel.id === channelId)) return;
    socket.broadcast.emit('typing', {
      channelId,
      user: publicUser(user),
      at: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    const next = (presence.get(userId) || 1) - 1;
    if (next <= 0) presence.delete(userId);
    else presence.set(userId, next);
    broadcastPresence();
  });
});

/* ------------------------------------------------------------------ */
/* Static build + start                                                */
/* ------------------------------------------------------------------ */

const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That message is too big.' });
  }
  console.error('request failed', error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

httpServer.listen(PORT, () => {
  console.log(`DisKids server running on http://localhost:${PORT}`);
});

export { app };
