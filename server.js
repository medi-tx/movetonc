import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStorage, DEFAULT_SAFETY, emptyDb } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3001;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const ALLOWED_ORIGINS = String(process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);
const BCRYPT_ROUNDS = IS_PRODUCTION ? 12 : 10;
const SESSION_COOKIE = 'diskids.sid';

if (IS_PRODUCTION && !DATABASE_URL && process.env.ALLOW_JSON_STORAGE !== '1') {
  throw new Error(
    'DATABASE_URL is required in production. Set ALLOW_JSON_STORAGE=1 only if you have a persistent local disk.',
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSessionSecret() {
  const fromEnv = String(process.env.SESSION_SECRET || '').trim();
  if (fromEnv) {
    if (IS_PRODUCTION && fromEnv.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters in production.');
    }
    return fromEnv;
  }
  if (IS_PRODUCTION) {
    throw new Error('SESSION_SECRET must be set in production so logins survive restarts.');
  }
  const secretPath = path.join(DATA_DIR, 'session-secret');
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, generated);
  return generated;
}

const sessionSecret = loadSessionSecret();

/* ------------------------------------------------------------------ */
/* Domain helpers                                                      */
/* ------------------------------------------------------------------ */

const GUIDE_ID = 'guide';
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const PIN_RE = /^\d{4,6}$/;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const AVATARS = ['🦊', '🐼', '🐸', '🦄', '🐙', '🐨', '🦖', '🐝', '🐳', '🦉', '🐱', '🐶', '🍀', '🌈', '🚀', '⭐', '🎨', '⚽'];

const BANNED_WORDS = [
  'damn', 'hell', 'crap', 'stupid', 'idiot', 'dumb', 'loser', 'shut up', 'hate you',
  'kill', 'gun', 'knife', 'drugs', 'porn', 'sex', 'naked', 'blood', 'ugly', 'fat',
];
const FILTER_RE = new RegExp(`\\b(?:${BANNED_WORDS.map(escapeRegExp).join('|')})\\b`, 'gi');
const LINK_RE = /\b(?:https?:\/\/|www\.)\S+/i;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;

let db = emptyDb();
let storage = null;
let sessionMiddleware = null;
const presence = new Map();
const lastSentAt = new Map();

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

function publicClub(club) {
  if (!club) return null;
  return {
    id: club.id,
    name: club.name,
    emoji: club.emoji,
    description: club.description,
    ownerId: club.ownerId,
    createdAt: club.createdAt,
  };
}

function publicMessage(message) {
  const author = db.users.find((user) => user.id === message.userId);
  return {
    ...message,
    user: publicUser(author) || {
      id: GUIDE_ID,
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

function currentClub(user) {
  if (!user?.clubId) return null;
  return db.clubs.find((club) => club.id === user.clubId) || null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in first.' });
  const club = currentClub(user);
  if (!club) return res.status(403).json({ error: 'This account is not connected to a club.' });
  req.user = user;
  req.club = club;
  next();
}

function requireGrownup(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in first.' });
  if (user.role !== 'grownup') return res.status(403).json({ error: 'Only grown-ups can do that.' });
  const club = currentClub(user);
  if (!club) return res.status(403).json({ error: 'This account is not connected to a club.' });
  if (!req.session.grownupUnlocked) {
    return res.status(403).json({ error: 'Enter the Parental PIN first.', code: 'PIN_REQUIRED' });
  }
  req.user = user;
  req.club = club;
  next();
}

function makeInviteCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)]).join('');
  } while (db.clubs.some((club) => club.inviteCode === code));
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

function filterWords(text, safety) {
  if (!safety.profanityFilter) return { text, changed: false };
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

function onlineForClub(clubId) {
  return [...presence.keys()].filter((userId) => {
    const user = db.users.find((candidate) => candidate.id === userId);
    return user?.clubId === clubId;
  });
}

function broadcastPresence(clubId) {
  io.to(clubRoom(clubId)).emit('presence', onlineForClub(clubId));
}

function clubRoom(clubId) {
  return `club:${clubId}`;
}

function refreshClub(clubId) {
  io.to(clubRoom(clubId)).emit('state:refresh');
}

function emitToClub(clubId, event, payload) {
  io.to(clubRoom(clubId)).emit(event, payload);
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
    hasClubs: db.clubs.length > 0,
    // Kept for older front-end bundles that check setupComplete.
    setupComplete: db.clubs.length > 0,
    clubName: '',
    user: null,
  };

  if (!user) return base;
  const club = currentClub(user);
  if (!club) return { ...base, user: publicUser(user) };

  const unlocked = user.role === 'grownup' && Boolean(req.session.grownupUnlocked);
  return {
    ...base,
    clubName: club.name,
    user: publicUser(user),
    unlocked,
    inviteCode: unlocked ? club.inviteCode : null,
    safety: { ...DEFAULT_SAFETY, ...(club.safety || {}) },
    clubs: [publicClub(club)],
    channels: db.channels
      .filter((channel) => channel.clubId === club.id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    members: db.users
      .filter((member) => member.role !== 'system' && member.clubId === club.id)
      .map(publicUser)
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    online: onlineForClub(club.id),
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
        clubId: club.id,
        channelId: welcome.id,
        userId: GUIDE_ID,
        body: `Welcome to ${club.name}! 🌟 This is our clubhouse. Be kind, include everyone, and have fun.`,
        createdAt: now(),
        filtered: false,
        deleted: false,
      },
      {
        id: uid(),
        clubId: club.id,
        channelId: welcome.id,
        userId: GUIDE_ID,
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
      clubId: club.id,
      channelId: general.id,
      userId: GUIDE_ID,
      body: 'Say hi! 👋 Tell us one fun thing about your day.',
      createdAt: now(),
      filtered: false,
      deleted: false,
    });
  }
  return created;
}

function ensureGuideUser() {
  if (db.users.some((user) => user.id === GUIDE_ID)) return;
  db.users.push({
    id: GUIDE_ID,
    username: 'club-guide',
    usernameLower: 'club-guide',
    displayName: 'Club Guide',
    avatar: '🌙',
    role: 'system',
    clubId: null,
    passwordHash: null,
    createdAt: now(),
  });
}

/* ------------------------------------------------------------------ */
/* App, middleware, rate limits                                        */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many tries. Please wait a few minutes and try again.' },
});

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'You are sending messages very quickly. Take a breath and try again soon.' },
});

const reportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'You have sent several reports. A grown-up will take a look soon.' },
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true,
    credentials: true,
  },
});

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

function registerRoutes() {
app.post('/api/setup', authLimiter, async (req, res, next) => {
  try {
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
    if (db.users.some((user) => user.usernameLower === username.toLowerCase())) {
      return res.status(409).json({ error: 'That username is already taken. Try another one.' });
    }

    const club = {
      id: uid(),
      name: clubName,
      emoji: '🌈',
      description: 'Our shared clubhouse',
      ownerId: null,
      inviteCode: makeInviteCode(),
      parentalPinHash: await bcrypt.hash(pin, BCRYPT_ROUNDS),
      safety: { ...DEFAULT_SAFETY },
      createdAt: now(),
    };

    const user = {
      id: uid(),
      username,
      usernameLower: username.toLowerCase(),
      displayName,
      avatar,
      role: 'grownup',
      clubId: club.id,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      createdAt: now(),
    };
    club.ownerId = user.id;

    ensureGuideUser();
    db.users.push(user);
    db.clubs.push(club);
    seedClub(club);
    await storage.save(db);
    await establishSession(req, user.id);

    res.status(201).json({ ok: true, inviteCode: club.inviteCode, club: publicClub(club) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/register', authLimiter, async (req, res, next) => {
  try {
    const inviteCode = String(req.body?.inviteCode ?? '').trim().toUpperCase();
    const club = db.clubs.find((candidate) => candidate.inviteCode === inviteCode);
    if (!club) {
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
      clubId: club.id,
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      createdAt: now(),
    };
    ensureGuideUser();
    db.users.push(user);
    await storage.save(db);
    await establishSession(req, user.id);

    refreshClub(club.id);
    broadcastPresence(club.id);
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/login', authLimiter, async (req, res, next) => {
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
    next(error);
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });
});

app.get('/api/state', (req, res) => {
  res.json(buildState(req));
});

app.post('/api/unlock', authLimiter, requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'grownup') {
      return res.status(403).json({ error: 'Only grown-up accounts can open the safety tools.' });
    }
    const pin = String(req.body?.pin ?? '');
    const matches = await bcrypt.compare(pin, req.club.parentalPinHash || '');
    if (!matches) return res.status(401).json({ error: 'That PIN does not match. Try again.' });

    req.session.grownupUnlocked = true;
    await new Promise((resolve, reject) => {
      req.session.save((error) => (error ? reject(error) : resolve()));
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/lock', requireAuth, (req, res) => {
  req.session.grownupUnlocked = false;
  req.session.save(() => res.json({ ok: true }));
});

/* Channels ---------------------------------------------------------- */

app.post('/api/channels', requireGrownup, async (req, res, next) => {
  try {
    const name = normalizeChannelName(req.body?.name);
    const topic = cleanText(req.body?.topic, 80);
    const kind = req.body?.kind === 'announcement' ? 'announcement' : 'text';

    if (name.length < 2) {
      return res.status(400).json({ error: 'Channel names need at least 2 letters (letters and numbers work best).' });
    }
    if (db.channels.some((channel) => channel.clubId === req.club.id && channel.name === name)) {
      return res.status(409).json({ error: 'That channel already exists in this club.' });
    }

    const position = db.channels.filter((channel) => channel.clubId === req.club.id).length;
    const channel = {
      id: uid(),
      clubId: req.club.id,
      name,
      topic: topic || 'A new place to chat',
      emoji: kind === 'announcement' ? '📣' : '💬',
      kind,
      locked: false,
      position,
      createdAt: now(),
    };
    db.channels.push(channel);
    await storage.save(db);
    refreshClub(req.club.id);
    res.status(201).json({ channel });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/channels/:id', requireGrownup, async (req, res, next) => {
  try {
    const channel = db.channels.find((item) => item.id === req.params.id && item.clubId === req.club.id);
    if (!channel) return res.status(404).json({ error: 'That channel could not be found.' });

    if (typeof req.body?.locked === 'boolean') channel.locked = req.body.locked;
    if (typeof req.body?.topic === 'string') channel.topic = cleanText(req.body.topic, 80);
    await storage.save(db);
    refreshClub(req.club.id);
    res.json({ channel });
  } catch (error) {
    next(error);
  }
});

/* Messages + reports ------------------------------------------------ */

app.get('/api/channels/:id/messages', requireAuth, (req, res) => {
  const channel = db.channels.find((item) => item.id === req.params.id && item.clubId === req.club.id);
  if (!channel) return res.status(404).json({ error: 'That channel could not be found.' });
  const messages = db.messages
    .filter((message) => message.channelId === channel.id && message.clubId === req.club.id)
    .slice(-200)
    .map(publicMessage);
  res.json({ messages, channel });
});

app.post('/api/channels/:id/messages', messageLimiter, requireAuth, async (req, res, next) => {
  try {
    const channel = db.channels.find((item) => item.id === req.params.id && item.clubId === req.club.id);
    if (!channel) return res.status(404).json({ error: 'That channel could not be found.' });
    if (channel.locked && req.user.role !== 'grownup') {
      return res.status(403).json({ error: 'This channel is paused by a grown-up right now.' });
    }
    if (channel.kind === 'announcement' && req.user.role !== 'grownup') {
      return res.status(403).json({ error: 'Only grown-ups can post in announcement channels.' });
    }

    const raw = String(req.body?.body ?? '');
    if (raw.length > 500) return res.status(400).json({ error: 'Messages can be up to 500 characters.' });
    let body = cleanMessage(raw);
    if (!body) return res.status(400).json({ error: 'Type a message first.' });

    if (req.user.role === 'kid') {
      if (!req.club.safety.allowLinks && containsLinkOrEmail(body)) {
        return res.status(400).json({
          error: 'Links and email addresses are turned off for kids. Ask a grown-up if you need to share one.',
        });
      }
      const slowMode = Number(req.club.safety.slowModeSeconds) || 0;
      if (slowMode > 0) {
        const key = `${req.club.id}:${req.user.id}`;
        const last = lastSentAt.get(key) || 0;
        const waitMs = slowMode * 1000 - (Date.now() - last);
        if (waitMs > 0) {
          return res.status(429).json({
            error: `Slow mode is on — take a breath and try again in ${Math.ceil(waitMs / 1000)}s.`,
            retryAfter: Math.ceil(waitMs / 1000),
          });
        }
      }
    }

    const filtered = filterWords(body, req.club.safety);
    body = filtered.text;

    const message = {
      id: uid(),
      clubId: req.club.id,
      channelId: channel.id,
      userId: req.user.id,
      body,
      createdAt: now(),
      filtered: filtered.changed,
      deleted: false,
    };
    db.messages.push(message);
    if (db.messages.length > 5000) db.messages.splice(0, db.messages.length - 5000);
    lastSentAt.set(`${req.club.id}:${req.user.id}`, Date.now());
    await storage.save(db);

    const published = publicMessage(message);
    emitToClub(req.club.id, 'message:new', published);
    res.status(201).json(published);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/messages/:id', requireAuth, async (req, res, next) => {
  try {
    const message = db.messages.find((item) => item.id === req.params.id && item.clubId === req.club.id);
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
    await storage.save(db);
    emitToClub(req.club.id, 'message:deleted', {
      id: message.id,
      channelId: message.channelId,
      deletedBy: message.deletedBy || null,
    });
    emitToClub(req.club.id, 'reports:changed');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/messages/:id/report', reportLimiter, requireAuth, async (req, res, next) => {
  try {
    const message = db.messages.find((item) => item.id === req.params.id && item.clubId === req.club.id);
    if (!message || message.deleted) return res.status(404).json({ error: 'That message could not be found.' });
    if (message.userId === req.user.id) {
      return res.status(400).json({ error: 'You do not need to report your own message.' });
    }
    const allowed = new Set(['Mean words', 'Spam', 'Scary or unsafe', 'Something else']);
    const reason = allowed.has(req.body?.reason) ? req.body.reason : 'Something else';

    const existing = db.reports.find(
      (report) =>
        report.messageId === message.id && report.reporterId === req.user.id && report.status === 'open',
    );
    if (existing) return res.status(409).json({ error: 'You already told a grown-up about this message.' });

    db.reports.push({
      id: uid(),
      clubId: req.club.id,
      messageId: message.id,
      reporterId: req.user.id,
      reason,
      status: 'open',
      createdAt: now(),
    });
    await storage.save(db);
    emitToClub(req.club.id, 'reports:changed');
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reports', requireGrownup, (req, res) => {
  const reports = db.reports
    .filter((report) => report.status === 'open' && report.clubId === req.club.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((report) => {
      const message = db.messages.find((item) => item.id === report.messageId && item.clubId === req.club.id);
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

app.post('/api/reports/:id/resolve', requireGrownup, async (req, res, next) => {
  try {
    const report = db.reports.find((item) => item.id === req.params.id && item.clubId === req.club.id);
    if (!report) return res.status(404).json({ error: 'That report could not be found.' });
    report.status = 'resolved';
    report.resolvedAt = now();
    report.resolvedBy = req.user.displayName;
    await storage.save(db);
    emitToClub(req.club.id, 'reports:changed');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/settings', requireGrownup, async (req, res, next) => {
  try {
    const next = req.body?.safety;
    if (!next || typeof next !== 'object') return res.status(400).json({ error: 'No safety settings were sent.' });

    if (typeof next.profanityFilter === 'boolean') req.club.safety.profanityFilter = next.profanityFilter;
    if (typeof next.allowLinks === 'boolean') req.club.safety.allowLinks = next.allowLinks;
    if (next.slowModeSeconds !== undefined) {
      const seconds = Number(next.slowModeSeconds);
      if ([0, 2, 5, 10, 30].includes(seconds)) req.club.safety.slowModeSeconds = seconds;
    }
    await storage.save(db);
    emitToClub(req.club.id, 'safety:changed', { safety: { ...req.club.safety } });
    res.json({ safety: { ...req.club.safety } });
  } catch (error) {
    next(error);
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await storage.health();
    res.json({ ok: true, storage: storage.mode, uptime: Math.round(process.uptime()) });
  } catch (error) {
    console.error('health check failed', error);
    res.status(503).json({ ok: false, error: 'Storage is unavailable.' });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'That API route does not exist.' });
});
}

/* ------------------------------------------------------------------ */
/* Socket.IO: club-scoped presence + typing                            */
/* ------------------------------------------------------------------ */

function attachSockets() {
  io.engine.use(sessionMiddleware);

  io.on('connection', (socket) => {
    const userId = socket.request.session?.userId;
    const user = userId ? db.users.find((candidate) => candidate.id === userId) : null;
    const club = currentClub(user);
    if (!user || !club) {
      socket.disconnect(true);
      return;
    }

    socket.join(clubRoom(club.id));
    presence.set(userId, (presence.get(userId) || 0) + 1);
    broadcastPresence(club.id);

    socket.on('typing', (payload) => {
      const channelId = typeof payload?.channelId === 'string' ? payload.channelId : null;
      if (!channelId) return;
      if (!db.channels.some((channel) => channel.id === channelId && channel.clubId === club.id)) return;
      socket.to(clubRoom(club.id)).emit('typing', {
        channelId,
        user: publicUser(user),
        at: Date.now(),
      });
    });

    socket.on('disconnect', () => {
      const remaining = (presence.get(userId) || 1) - 1;
      if (remaining <= 0) presence.delete(userId);
      else presence.set(userId, remaining);
      broadcastPresence(club.id);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Static build + startup                                              */
/* ------------------------------------------------------------------ */

function attachStatic() {
  const distDir = path.join(__dirname, 'dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) return;

  app.use(
    express.static(distDir, {
      maxAge: IS_PRODUCTION ? '1h' : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

function attachErrorHandler() {
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'That message is too big.' });
    }
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'That request was not valid JSON.' });
    }
    console.error('request failed', error);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — closing DisKids…`);
  io.close();
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  httpServer.close(async () => {
    try {
      await storage.flush();
      await storage.close();
    } finally {
      process.exit(0);
    }
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function main() {
  storage = await createStorage({ dataDir: DATA_DIR, databaseUrl: DATABASE_URL });
  db = await storage.load();

  sessionMiddleware = session({
    name: SESSION_COOKIE,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PRODUCTION,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  });

  if (IS_PRODUCTION) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: IS_PRODUCTION
        ? {
            useDefaults: false,
            directives: {
              defaultSrc: ["'self'"],
              baseUri: ["'self'"],
              fontSrc: ["'self'", 'data:'],
              formAction: ["'self'"],
              frameAncestors: ["'none'"],
              imgSrc: ["'self'", 'data:'],
              objectSrc: ["'none'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              connectSrc: ["'self'", ...ALLOWED_ORIGINS.map((origin) => origin.replace(/^http/, 'ws'))],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
      hsts: IS_PRODUCTION,
    }),
  );

  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!ALLOWED_ORIGINS.length) return next();
    const origin = req.get('origin');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return res.status(403).json({ error: 'This request came from an unknown site.' });
    }
    next();
  });

  app.use(express.json({ limit: '32kb' }));
  app.use(sessionMiddleware);
  registerRoutes();
  attachSockets();
  attachStatic();
  attachErrorHandler();

  httpServer.listen(PORT, () => {
    console.log(`DisKids running on http://localhost:${PORT} (${storage.mode} storage, ${NODE_ENV})`);
  });
}

main().catch((error) => {
  console.error('DisKids failed to start:', error);
  process.exit(1);
});
